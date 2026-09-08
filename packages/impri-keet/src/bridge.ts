import type { KeetCore, KeetMessageId, KeetReactionSummary } from "@lamplitisles/keet-integration-core"
import type { ApprovalAction, ApprovalInbox, Verdict } from "./impri.js"
import { BotStore, MAX_ACTIVE_REQUESTS, type ApprovalMessage, type BotState } from "./state.js"

export type ApprovalCore = Pick<KeetCore,
  "status" | "listGroups" | "listPendingDmRequests" | "readRecentMessages" | "readReactions" | "sendMessage" | "addReaction" | "close">

const APPROVE = "✅"
const REJECT = "❌"
const LABELS = {
  pending: "Pending approval", approved: "Approved; awaiting execution", rejected: "Rejected",
  expired: "Expired", executed: "Executed", execute_failed: "Execution failed",
} as const

function operationSignal(signal: AbortSignal): AbortSignal { return AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }

export function reactionChoice(reactions: readonly KeetReactionSummary[]): Verdict | "conflict" | null {
  const external = (emoji: string) => reactions.some((item) => item.emoji === emoji && item.count - Number(item.own) > 0)
  const approve = external(APPROVE)
  const reject = external(REJECT)
  return approve && reject ? "conflict" : approve ? "approve" : reject ? "reject" : null
}

export function approvalText(action: ApprovalAction, inboxUrl: string): string {
  const preview = action.preview.length > 10_000 ? action.preview.slice(0, 10_000) + "\n…See the link for the full preview." : action.preview
  return [
    `Pending approval: ${action.title}`, `Type: ${action.kind}`, "", preview, "",
    `${inboxUrl}/inbox/${action.id}`, "",
    "✅ Approve · ❌ Reject. Choose one; removing a reaction cannot undo an accepted decision.",
  ].join("\n")
}

/** This private DM is the authorization boundary; there is no member allowlist. */
export async function verifyDestination(core: ApprovalCore, binding: BotState, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const status = await core.status()
  if (status.identityId !== binding.identityId) throw new Error("Keet bot identity changed")
  const rooms = await core.listGroups()
  const room = rooms.find((candidate) => candidate.groupId === binding.dmId)
  if (!room || room.roomType !== "DirectMessage" || !room.dmMemberId) throw new Error("Configured destination is not a complete private DM")
  const pending = await core.listPendingDmRequests(operationSignal(signal))
  if (pending.some((request) => request.memberId === room.dmMemberId)) throw new Error("Configured private DM is not accepted")
  signal.throwIfAborted()
}

/** A serialized poll of Impri state and current Keet choices, with no vote queue. */
export class ApprovalBridge {
  constructor(
    private readonly core: ApprovalCore,
    private readonly inbox: ApprovalInbox,
    private readonly store: BotStore,
    private readonly inboxUrl: string,
    private readonly reportFailure: () => void = () => undefined,
  ) {}

  async tick(signal: AbortSignal): Promise<boolean> {
    const state = this.store.snapshot()
    if (!state) throw new Error("Run Impri Keet setup first")
    await verifyDestination(this.core, state, signal)

    // Service persisted work first, so pagination or discovery failures never
    // make an older message fall out of the decision window.
    let healthy = true
    const process = async (id: string, message: ApprovalMessage) => {
      signal.throwIfAborted()
      try { await this.process(state, id, message, signal) }
      catch {
        signal.throwIfAborted()
        healthy = false
        this.reportFailure()
      }
    }
    for (const [id, message] of Object.entries(state.requests)) {
      await process(id, message)
    }

    const current = this.store.snapshot()!
    let active = Object.keys(current.requests).length
    for await (const action of this.inbox.pending(signal)) {
      if (current.requests[action.id]) continue
      if (active >= MAX_ACTIVE_REQUESTS) break
      const message: ApprovalMessage = { text: approvalText(action, this.inboxUrl), messageId: null, notice: null }
      await this.store.put(action.id, message)
      current.requests[action.id] = message
      active += 1
      await process(action.id, message)
    }
    return healthy
  }

  private async process(binding: BotState, id: string, message: ApprovalMessage, signal: AbortSignal): Promise<void> {
    let action = await this.inbox.get(id, signal)
    if (!action) {
      await this.core.sendMessage(binding.dmId, `Request ${id} is no longer available. Check Impri for details.`, undefined, operationSignal(signal))
      await this.store.remove(id)
      return
    }
    if (action.status === "pending") {
      const target = await this.ensureMessage(binding, id, message, signal)
      if (!target) return
      let reactions = await this.core.readReactions(binding.dmId, target, operationSignal(signal))
      if (reactions === null) return
      for (const emoji of [APPROVE, REJECT]) {
        if (!reactions.some((item) => item.emoji === emoji && item.own)) {
          await this.core.addReaction(binding.dmId, target, emoji, operationSignal(signal))
        }
      }
      // Confirm both decorations in a fresh native snapshot before interpreting
      // counts. A failed add can be recovered without duplicate-add assumptions.
      reactions = await this.core.readReactions(binding.dmId, target, operationSignal(signal))
      if (!reactions || ![APPROVE, REJECT].every((emoji) => reactions.some((item) => item.emoji === emoji && item.own))) return
      const choice = reactionChoice(reactions)
      if (choice === "conflict") {
        if (message.notice !== "conflict") {
          await this.core.sendMessage(binding.dmId, `Both ✅ and ❌ are selected for "${action.title}". Please keep only one.\n${this.inboxUrl}/inbox/${id}`, undefined, operationSignal(signal))
          message.notice = "conflict"
          await this.store.put(id, message)
        }
        return
      }
      if (message.notice === "conflict") {
        message.notice = null
        await this.store.put(id, message)
      }
      if (!choice) return
      // On HTTP failure we retain no verdict. Next poll first reads Impri, then
      // the current reaction snapshot: removed offline choices are never replayed.
      await this.inbox.decide(id, choice, signal)
      action = await this.inbox.get(id, signal)
      if (!action || action.status === "pending") return
    }
    if (message.notice !== action.status) {
      await this.core.sendMessage(binding.dmId, `"${action.title}": ${LABELS[action.status]}\n${this.inboxUrl}/inbox/${id}`, undefined, operationSignal(signal))
      message.notice = action.status
      await this.store.put(id, message)
    }
    // Approved actions remain observed for an execution receipt. Every other
    // non-pending status is terminal under Impri's existing action contract.
    if (action.status !== "approved") await this.store.remove(id)
  }

  private async ensureMessage(binding: BotState, id: string, message: ApprovalMessage, signal: AbortSignal): Promise<KeetMessageId | null> {
    if (message.messageId) return message.messageId
    const recover = async () => {
      const history = await this.core.readRecentMessages(binding.dmId, 50, operationSignal(signal))
      return history.find((item) => item.senderId === binding.identityId && item.text === message.text)?.messageId
    }
    // The native send commonly resolves without a canonical message ID. The
    // durable text includes the unique action URL; only our own exact text
    // can recover it, including after losing the send acknowledgement.
    const existing = await recover()
    const sent = existing ?? await this.core.sendMessage(binding.dmId, message.text, undefined, operationSignal(signal))
    const target = sent ?? await recover()
    if (!target) return null
    message.messageId = target
    await this.store.put(id, message)
    return target
  }
}
