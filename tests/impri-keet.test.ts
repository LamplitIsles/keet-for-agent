import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { getEventListeners } from "node:events"
import path from "node:path"
import type { KeetMessage, KeetMessageId } from "../packages/keet-core/src/index.js"
import { ApprovalBridge, approvalText, reactionChoice, type ApprovalCore } from "../packages/impri-keet/src/bridge.js"
import { runBot, setupBot } from "../packages/impri-keet/src/cli.js"
import type { BotConfig } from "../packages/impri-keet/src/config.js"
import { ImpriInbox, ImpriHttpError, type ApprovalAction, type ApprovalInbox, type Verdict } from "../packages/impri-keet/src/impri.js"
import { BotStore } from "../packages/impri-keet/src/state.js"

const directories: string[] = []
const stores: BotStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const baseUrl = "http://impri.test"
const dmId = "fixture-dm"
const identityId = "fixture-bot"
const signal = () => new AbortController().signal
const keyOf = (id: KeetMessageId) => `${id.deviceId}:${id.seq}`
const pendingAction = (id = "act_one"): ApprovalAction => ({ id, title: "Review this action", kind: "test.action", preview: "Make this change?", status: "pending" })

async function openStore(directory?: string, bind = true): Promise<{ directory: string; store: BotStore }> {
  if (!directory) {
    directory = await mkdtemp(path.join(tmpdir(), "impri-keet-test-"))
    directories.push(directory)
  }
  const store = await BotStore.open(directory)
  stores.push(store)
  if (bind) await store.bind(baseUrl, identityId, dmId)
  return { directory, store }
}

function fakeCore() {
  const messages: KeetMessage[] = []
  const reactions = new Map<string, { emoji: string; count: number; own: boolean }[]>()
  let closed = false
  const core = {
    status: vi.fn(async () => {
      if (closed) throw new Error("closed")
      return { state: "ready" as const, identityId, appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: false }
    }),
    listGroups: vi.fn(async () => [{ groupId: dmId, roomType: "DirectMessage" as const, dmMemberId: "any-peer", title: "Private DM" }]),
    listPendingDmRequests: vi.fn(async (): Promise<{ memberId: string; displayName?: string }[]> => []),
    readRecentMessages: vi.fn(async (_room: string, last = 50, stop?: AbortSignal) => { stop?.throwIfAborted(); return messages.slice(-last) }),
    readReactions: vi.fn(async (_room: string, target: KeetMessageId, stop?: AbortSignal) => {
      stop?.throwIfAborted()
      return structuredClone(reactions.get(keyOf(target)) ?? null)
    }),
    sendMessage: vi.fn(async (room: string, text: string, _replyTo?: KeetMessageId, stop?: AbortSignal): Promise<KeetMessageId | undefined> => {
      stop?.throwIfAborted()
      const id = { deviceId: "bot-device", seq: messages.length + 1 }
      messages.push({ messageId: id, groupId: room, senderId: identityId, senderLabel: "Impri", timestamp: messages.length, text })
      reactions.set(keyOf(id), [])
      // Match the official send path: it may confirm text without a message ID.
      return undefined
    }),
    addReaction: vi.fn(async (_room: string, target: KeetMessageId, emoji: string, stop?: AbortSignal) => {
      stop?.throwIfAborted()
      const entries = reactions.get(keyOf(target))!
      const item = entries.find((entry) => entry.emoji === emoji)
      if (item?.own) throw new Error("duplicate reaction")
      if (item) { item.own = true; item.count += 1 }
      else entries.push({ emoji, count: 1, own: true })
    }),
    close: vi.fn(async () => { closed = true }),
  } satisfies ApprovalCore
  const choose = (target: KeetMessageId, ...choices: string[]) => {
    const entries = reactions.get(keyOf(target))!
    for (const emoji of ["✅", "❌"]) {
      const entry = entries.find((item) => item.emoji === emoji)!
      entry.count = Number(entry.own) + Number(choices.includes(emoji))
    }
  }
  return { core, messages, reactions, choose }
}

function fakeInbox(actions = [pendingAction()]) {
  const state = new Map(actions.map((item) => [item.id, structuredClone(item)]))
  const inbox = {
    async *pending(stop: AbortSignal) { stop.throwIfAborted(); yield* [...state.values()].filter((item) => item.status === "pending").map((item) => structuredClone(item)) },
    get: vi.fn(async (id: string, stop: AbortSignal) => { stop.throwIfAborted(); return structuredClone(state.get(id) ?? null) }),
    decide: vi.fn(async (id: string, verdict: Verdict, stop: AbortSignal) => {
      stop.throwIfAborted()
      const item = state.get(id)!
      if (item.status === "pending") item.status = verdict === "approve" ? "approved" : "rejected"
    }),
  } satisfies ApprovalInbox
  return { inbox, state }
}

async function fixture(actions = [pendingAction()]) {
  const { directory, store } = await openStore()
  const keet = fakeCore()
  const impri = fakeInbox(actions)
  const bridge = new ApprovalBridge(keet.core, impri.inbox, store, baseUrl)
  return { directory, store, bridge, ...keet, ...impri }
}

describe("Keet approval channel", () => {
  it("publishes both decorations without approving, then reflects approval and execution exactly once in an uninterrupted run", async () => {
    const f = await fixture()
    await expect(f.bridge.tick(signal())).resolves.toBe(true)
    expect(f.messages).toHaveLength(1)
    expect(f.core.addReaction.mock.calls.map((call) => call[2])).toEqual(["✅", "❌"])
    expect(f.inbox.decide).not.toHaveBeenCalled()
    f.choose(f.messages[0]!.messageId, "✅")
    await f.bridge.tick(signal())
    expect(f.inbox.decide).toHaveBeenCalledWith("act_one", "approve", expect.any(AbortSignal))
    expect(f.messages.at(-1)?.text).toContain("Approved; awaiting execution")
    await f.bridge.tick(signal())
    expect(f.messages).toHaveLength(2)
    f.state.get("act_one")!.status = "executed"
    await f.bridge.tick(signal())
    expect(f.messages.at(-1)?.text).toContain("Executed")
    expect(f.store.snapshot()?.requests).toEqual({})
    await f.bridge.tick(signal())
    expect(f.messages).toHaveLength(3)
    expect(f.inbox.decide).toHaveBeenCalledTimes(1)
  })

  it("maps reject to the existing action decision and never calls a forge", async () => {
    const f = await fixture()
    await f.bridge.tick(signal())
    f.choose(f.messages[0]!.messageId, "❌")
    await f.bridge.tick(signal())
    expect(f.state.get("act_one")!.status).toBe("rejected")
    expect(f.inbox.decide.mock.calls[0]?.slice(0, 2)).toEqual(["act_one", "reject"])
    expect(f.messages.at(-1)?.text).toContain("Rejected")
  })

  it("recovers current offline choices from durable message IDs, including messages outside recent history", async () => {
    const f = await fixture()
    await f.bridge.tick(signal())
    const target = f.messages[0]!.messageId
    f.choose(target, "✅")
    for (let index = 0; index < 55; index += 1) await f.core.sendMessage(dmId, `Unrelated text ${index}`)
    await f.store.close()
    const reopened = await openStore(f.directory)
    const bridge = new ApprovalBridge(f.core, f.inbox, reopened.store, baseUrl)
    const readsBefore = f.core.readRecentMessages.mock.calls.length
    await bridge.tick(signal())
    expect(f.inbox.decide).toHaveBeenCalledTimes(1)
    expect(f.core.readRecentMessages.mock.calls.length).toBe(readsBefore)
    expect(f.messages.filter((item) => item.text.startsWith("Pending approval: "))).toHaveLength(1)
  })

  it("does not replay a removed choice after a failed decision or select between conflicting reactions", async () => {
    const f = await fixture()
    await f.bridge.tick(signal())
    const target = f.messages[0]!.messageId
    f.choose(target, "✅")
    f.inbox.decide.mockRejectedValueOnce(new Error("offline"))
    await expect(f.bridge.tick(signal())).resolves.toBe(false)
    f.choose(target)
    await f.store.close()
    const reopened = await openStore(f.directory)
    const bridge = new ApprovalBridge(f.core, f.inbox, reopened.store, baseUrl)
    await bridge.tick(signal())
    expect(f.inbox.decide).toHaveBeenCalledTimes(1)
    f.choose(target, "✅", "❌")
    await bridge.tick(signal())
    await bridge.tick(signal())
    expect(f.messages.filter((item) => item.text.includes("Please keep only one"))).toHaveLength(1)
    expect(f.inbox.decide).toHaveBeenCalledTimes(1)
    f.choose(target, "❌")
    await bridge.tick(signal())
    expect(f.state.get("act_one")!.status).toBe("rejected")
  })

  it("trusts canonical Impri state when a decision committed but its acknowledgement was lost", async () => {
    const f = await fixture()
    await f.bridge.tick(signal())
    f.choose(f.messages[0]!.messageId, "✅")
    f.inbox.decide.mockImplementationOnce(async (id) => {
      f.state.get(id)!.status = "approved"
      throw new Error("response lost")
    })
    await f.bridge.tick(signal())
    f.choose(f.messages[0]!.messageId, "❌")
    await f.bridge.tick(signal())
    expect(f.inbox.decide).toHaveBeenCalledTimes(1)
    expect(f.messages.at(-1)?.text).toContain("Approved")
  })

  it("never re-decides an action resolved through another channel", async () => {
    const f = await fixture()
    await f.bridge.tick(signal())
    f.choose(f.messages[0]!.messageId, "✅")
    f.state.get("act_one")!.status = "expired"
    await f.bridge.tick(signal())
    expect(f.inbox.decide).not.toHaveBeenCalled()
    expect(f.messages.at(-1)?.text).toContain("Expired")
    expect(f.store.snapshot()?.requests).toEqual({})
  })

  it("recovers an unacknowledged send using only the bot's own exact message", async () => {
    const f = await fixture()
    const send = f.core.sendMessage.getMockImplementation()!
    f.core.sendMessage.mockImplementationOnce(async (...args) => {
      await send(...args)
      throw new Error("send acknowledgement lost")
    })
    await f.bridge.tick(signal())
    expect(f.store.snapshot()?.requests.act_one?.messageId).toBeNull()
    expect(f.messages).toHaveLength(1)
    await f.store.close()
    const reopened = await openStore(f.directory)
    const bridge = new ApprovalBridge(f.core, f.inbox, reopened.store, baseUrl)
    await bridge.tick(signal())
    expect(f.messages).toHaveLength(1)
    expect(reopened.store.snapshot()?.requests.act_one?.messageId).toEqual(f.messages[0]!.messageId)

    const other = await fixture()
    const text = approvalText(pendingAction(), baseUrl)
    await other.store.put("act_one", { text, messageId: null, notice: null })
    other.messages.push({ messageId: { deviceId: "peer", seq: 1 }, groupId: dmId, senderId: "someone-else", senderLabel: "Impri", timestamp: 1, text })
    await other.bridge.tick(signal())
    expect(other.messages).toHaveLength(2)
    expect(other.store.snapshot()?.requests.act_one?.messageId?.deviceId).toBe("bot-device")
  })

  it("waits for both decorations after a partial add and never retries the confirmed one", async () => {
    const f = await fixture()
    const add = f.core.addReaction.getMockImplementation()!
    f.core.addReaction.mockImplementationOnce(add).mockRejectedValueOnce(new Error("add failed"))
    await expect(f.bridge.tick(signal())).resolves.toBe(false)
    expect(f.inbox.decide).not.toHaveBeenCalled()
    await f.bridge.tick(signal())
    expect(f.core.addReaction.mock.calls.map((call) => call[2])).toEqual(["✅", "❌", "❌"])
    expect(f.inbox.decide).not.toHaveBeenCalled()
  })

  it("continues servicing other pending messages when one native snapshot fails", async () => {
    const f = await fixture([pendingAction(), pendingAction("act_two")])
    await f.bridge.tick(signal())
    const second = f.store.snapshot()!.requests.act_two!.messageId!
    f.choose(second, "✅")
    f.core.readReactions.mockRejectedValueOnce(new Error("bad first message"))
    await expect(f.bridge.tick(signal())).resolves.toBe(false)
    expect(f.state.get("act_one")!.status).toBe("pending")
    expect(f.state.get("act_two")!.status).toBe("approved")
  })

  it("does not send or decide in a group, a pending DM, or a replacement identity", async () => {
    const f = await fixture()
    f.core.listGroups.mockResolvedValueOnce([])
    await expect(f.bridge.tick(signal())).rejects.toThrow("complete private DM")
    f.core.listPendingDmRequests.mockResolvedValueOnce([{ memberId: "any-peer" }])
    await expect(f.bridge.tick(signal())).rejects.toThrow("not accepted")
    f.core.status.mockResolvedValueOnce({ state: "ready", identityId: "replacement", appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: false })
    await expect(f.bridge.tick(signal())).rejects.toThrow("identity changed")
    expect(f.messages).toHaveLength(0)
    expect(f.inbox.decide).not.toHaveBeenCalled()
  })

  it("keeps the confirmed message ID when cancellation arrives just after a send", async () => {
    const f = await fixture()
    const controller = new AbortController()
    const send = f.core.sendMessage.getMockImplementation()!
    f.core.sendMessage.mockImplementationOnce(async (...args) => {
      await send(...args)
      controller.abort()
      return f.messages.at(-1)!.messageId
    })
    await expect(f.bridge.tick(controller.signal)).rejects.toThrow()
    expect(f.store.snapshot()?.requests.act_one?.messageId).toEqual(f.messages[0]!.messageId)
    await f.bridge.tick(signal())
    expect(f.messages).toHaveLength(1)
    expect(f.inbox.decide).not.toHaveBeenCalled()
  })

  it("treats aggregate non-bot choices as intent without knowing a Member ID", () => {
    expect(reactionChoice([{ emoji: "✅", count: 1, own: true }, { emoji: "❌", count: 1, own: true }])).toBeNull()
    expect(reactionChoice([{ emoji: "✅", count: 1, own: false }])).toBe("approve")
    expect(reactionChoice([{ emoji: "✅", count: 2, own: true }, { emoji: "❌", count: 2, own: true }])).toBe("conflict")
    expect(reactionChoice([{ emoji: "👍", count: 2, own: false }])).toBeNull()
  })
})

describe("bot state and lifecycle", () => {
  it("exclusively owns the directory, persists private state, and refuses corrupt state or retargeting", async () => {
    const { directory, store } = await openStore()
    await expect(BotStore.open(directory)).rejects.toThrow("Another Impri Keet process")
    await expect(store.bind(baseUrl, identityId, "another-dm")).rejects.toThrow("different")
    expect((await stat(path.join(directory, "state.json"))).mode & 0o777).toBe(0o600)
    await store.close()
    const next = await openStore(directory)
    expect(next.store.snapshot()?.dmId).toBe(dmId)
    await next.store.close()
    await writeFile(path.join(directory, "state.json"), "{broken")
    await expect(BotStore.open(directory)).rejects.toThrow()
    expect(await readFile(path.join(directory, "state.json"), "utf8")).toBe("{broken")
  })

  it("lets a human select one DM without storing an approver allowlist", async () => {
    const { directory, store } = await openStore(undefined, false)
    const f = fakeCore()
    f.core.listGroups.mockResolvedValueOnce([])
    f.core.listPendingDmRequests.mockResolvedValueOnce([{ memberId: "peer-a", displayName: "Alice\n\u001b[2J" }, { memberId: "peer-b", displayName: "Bob" }])
    const core = {
      ...f.core,
      updateDisplayName: vi.fn(async () => undefined),
      setUsername: vi.fn(async () => ({ status: "searchable" as const, submitted: true })),
      acceptDmRequest: vi.fn(async () => ({ groupId: dmId, roomType: "DirectMessage" as const, dmMemberId: "any-peer" })),
    }
    const config: BotConfig = { baseUrl, inboxUrl: baseUrl, apiKey: "im_fixture", runtimeDir: "/fixture/runtime", dataDir: directory }
    const answers = ["", "2"]
    const tell = vi.fn()
    await setupBot(core, store, config, "bot123", async () => answers.shift()!, tell, signal())
    expect(core.acceptDmRequest).toHaveBeenCalledWith("peer-b", expect.any(AbortSignal))
    expect(tell.mock.calls.flat().join(" ")).not.toContain("peer-b")
    expect(tell.mock.calls.some(([line]) => (line as string).includes("\n") || (line as string).includes("\u001b"))).toBe(false)
    expect(store.snapshot()).toEqual({ baseUrl, identityId, dmId, requests: {} })
  })

  it("closes the old worker before reconnect and never dispatches old-owner work after replacement", async () => {
    const { directory, store } = await openStore()
    const old = fakeCore()
    const next = fakeCore()
    old.core.status.mockRejectedValueOnce(new Error("worker died"))
    const inbox = fakeInbox([]).inbox
    const controller = new AbortController()
    const startCore = vi.fn(async () => {
      if (startCore.mock.calls.length === 1) return old.core
      expect(old.core.close).toHaveBeenCalledTimes(1)
      return next.core
    })
    let pauses = 0
    await runBot({ config: { baseUrl, inboxUrl: baseUrl, apiKey: "im_fixture", runtimeDir: "/fixture/runtime", dataDir: directory },
      store, inbox, signal: controller.signal, log: () => undefined, startCore,
      pause: async () => { if (++pauses === 2) controller.abort() },
    })
    expect(startCore).toHaveBeenCalledTimes(2)
    expect(old.core.status).toHaveBeenCalledTimes(1)
    expect(next.core.status).toHaveBeenCalledTimes(1)
    expect(next.core.close).toHaveBeenCalled()
    expect(old.core.sendMessage).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  })
})

describe("Impri HTTP contract", () => {
  const wire = (item: ApprovalAction) => ({ ...item, preview: { format: "plain", body: item.preview } })
  it("paginates pending actions and submits the Keet channel without payload or PR semantics", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const fetcher: typeof fetch = async (url, init) => {
      const requestedUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
      calls.push({ url: requestedUrl, init })
      if (init?.method === "POST") return Response.json({ verdict: "approve" })
      if (requestedUrl.includes("cursor=")) return Response.json({ items: [wire(pendingAction("act_two"))], has_more: false })
      return Response.json({ items: [wire(pendingAction())], has_more: true, next_cursor: "next/page" })
    }
    const inbox = new ImpriInbox(baseUrl, "im_fixture", fetcher)
    const actions: ApprovalAction[] = []
    for await (const item of inbox.pending(signal())) actions.push(item)
    expect(actions.map((item) => item.id)).toEqual(["act_one", "act_two"])
    await inbox.decide("act_one", "approve", signal())
    expect(calls[1]?.url).toContain("cursor=next%2Fpage")
    expect(JSON.parse(calls[2]!.init!.body as string)).toEqual({ decision: "approve", channel: "keet" })
    expect(calls.every((call) => call.init?.redirect === "error")).toBe(true)
  })

  it("handles already-decided/not-found responses and rejects wrong action IDs and unknown states", async () => {
    const replies = [new Response("conflict", { status: 409 }), new Response("missing", { status: 404 }),
      Response.json(wire(pendingAction("act_other"))), Response.json({ ...wire(pendingAction()), status: "new-state" }),
      new Response("private server detail", { status: 403 })]
    const inbox = new ImpriInbox(baseUrl, "im_fixture", async () => replies.shift()!)
    await expect(inbox.decide("act_one", "approve", signal())).resolves.toBeUndefined()
    await expect(inbox.get("act_one", signal())).resolves.toBeNull()
    await expect(inbox.get("act_one", signal())).rejects.toThrow("ID mismatch")
    await expect(inbox.get("act_one", signal())).rejects.toThrow("action status")
    await expect(inbox.get("act_one", signal())).rejects.toEqual(new ImpriHttpError(403))
  })

  it("propagates cancellation through the fetch boundary", async () => {
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const inbox = new ImpriInbox(baseUrl, "im_fixture", async (_url, init) => {
      started()
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    })
    const request = inbox.get("act_one", controller.signal)
    await ready
    controller.abort()
    await expect(request).rejects.toThrow("aborted")
  })
})
