import { KeetSidecar } from "./sidecar.js"
import {
  KEET_NATIVE_ADDON_COUNT,
  validateKeetCompatibility,
  type InvitationInfo,
  type Invitation,
  type CreateGroupOptions,
  type KeetCore,
  type JoinResult,
  type KeetCoreOptions,
  type KeetMember,
  type KeetMessage,
  type KeetMessageId,
  type KeetReadiness,
  type KeetSubscription,
  type ManagedGroup,
  type KeetManagedDm,
  type KeetPendingDmRequest,
  type PreparedAvatar,
  type PreparedAvatarVariant,
  type KeetRoomType,
} from "./types.js"
import { createHash } from "node:crypto"

const MAX_TEXT = 16_000
const MAX_MEMBER_ID = 512
const MAX_GROUP_ID = 512
const MAX_MESSAGES = 50
const MAX_GROUPS = 512
const MAX_POLL = 32
const DEFAULT_PAIRING_TIMEOUT_MS = 60_000
const MAX_DM_REQUESTS = 32
const MAX_AVATAR_BYTES = 512 * 1024
const DM_REQUEST_PENDING = 3

type RawRecord = Record<string, unknown>

/**
 * Typed Integration Core over the official fd-3 sidecar. No DSH concepts live
 * here; adapters consume only normalized records and bounded destination operations.
 */
export class KeetIntegrationCore implements KeetCore {
  readonly sidecar: KeetSidecar
  readonly #pairingTimeoutMs: number
  #selfId: string | undefined
  #selfLabel: string | undefined
  #closed = false

  constructor(options: KeetCoreOptions | KeetSidecar) {
    this.sidecar = options instanceof KeetSidecar ? options : new KeetSidecar(options)
    this.#pairingTimeoutMs = options instanceof KeetSidecar ? DEFAULT_PAIRING_TIMEOUT_MS : Math.max(1, Math.min(options.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS, DEFAULT_PAIRING_TIMEOUT_MS))
  }

  static async start(options: KeetCoreOptions): Promise<KeetIntegrationCore> {
    validateAdmission(options)
    const core = new KeetIntegrationCore(options)
    await core.sidecar.start()
    try {
      await core.loadIdentity()
      return core
    } catch (error) {
      await core.close().catch(() => undefined)
      throw error
    }
  }

  async status(): Promise<KeetReadiness> {
    let status
    try {
      status = await this.sidecar.status()
    } catch {
      throw publicError("Keet status is unavailable")
    }
    const identity = await this.loadIdentity()
    return {
      ...status,
      identityId: identity.id,
      ...(identity.label ? { displayName: identity.label } : {}),
    }
  }

  async listGroups(): Promise<ManagedGroup[]> {
    const raw = await this.safeCall("getRecentRooms", [])
    const values = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.rooms) ? raw.rooms : []
    const initial = values.slice(0, MAX_GROUPS).flatMap((value) => {
      const group = normalizeGroup(value)
      return group ? [group] : []
    })
    // getRecentRooms intentionally returns a compact recency record. Resolve
    // room metadata through the pinned getRoomInfo call when the compact
    // record did not carry its type. Test workers may already include the
    // metadata, so their fixture shape remains accepted.
    return await Promise.all(initial.map(async (group) => {
      if (group.roomType) return group
      try {
        const rawInfo = await this.callWithSignal("getRoomInfo", [group.groupId])
        const info = normalizeGroup(rawInfo)
        if (info && info.groupId === group.groupId) return {
          ...group,
          ...info,
          ...(info.title === undefined && group.title !== undefined ? { title: group.title } : {}),
          ...(info.description === undefined && group.description !== undefined ? { description: group.description } : {}),
        }
      } catch {
        // A compact room record can omit metadata. It remains visible until a
        // destination admission path requires an explicit room type.
      }
      return group
    }))
  }

  async resolveDm(memberId: string, signal?: AbortSignal): Promise<KeetManagedDm> {
    const id = boundedMemberId(memberId, "DM Member ID")
    ensureSignal(signal)
    const raw = await this.callWithSignal("getDmByMemberId", [id], signal)
    const resolved = normalizeDmResolution(raw, id)
    if (!resolved) throw publicError("configured Managed DM is not resolved")
    if (hasUnsupportedRoomType(raw)) throw publicError("resolved Managed DM has an unsupported room type")
    // The pinned worker's member lookup includes pending contact requests as
    // well as accepted contacts. Pending status is authoritative for this
    // boundary: a request is not a usable Managed DM until explicitly accepted.
    const pendingRaw = await this.callWithSignal("getDmRequestsByStatus", [DM_REQUEST_PENDING, { reverse: true, limit: MAX_DM_REQUESTS }], signal)
    const pendingValues = Array.isArray(pendingRaw) ? pendingRaw : isRecord(pendingRaw) && Array.isArray(pendingRaw.requests) ? pendingRaw.requests : []
    if (pendingValues.some((value) => normalizePendingDmRequest(value)?.memberId === id)) throw publicError("configured Managed DM is not resolved")
    let room = normalizeGroup(raw)
    if (!room || room.groupId !== resolved.groupId || room.roomType === undefined) {
      try {
        const info = await this.callWithSignal("getRoomInfo", [resolved.groupId], signal)
        if (hasUnsupportedRoomType(info)) throw publicError("resolved Managed DM has an unsupported room type")
        const normalized = normalizeGroup(info)
        if (normalized && normalized.groupId === resolved.groupId) room = { ...room, ...normalized }
      } catch (error) {
        if (error instanceof Error && error.message === "resolved Managed DM has an unsupported room type") throw error
        // A DM lookup is still useful on workers that omit room metadata; the
        // lookup itself is authoritative for the direct-message relation.
      }
    }
    const roomType = room?.roomType ?? "DirectMessage"
    if (roomType !== "DirectMessage") throw publicError("resolved Managed DM has an unsupported room type")
    const peer = room?.dmMemberId ?? resolved.memberId
    if (peer !== id) throw publicError("resolved Managed DM belongs to another Member ID")
    return {
      groupId: resolved.groupId,
      roomType: "DirectMessage",
      dmMemberId: id,
      ...(room?.title !== undefined ? { title: room.title } : {}),
      ...(room?.description !== undefined ? { description: room.description } : {}),
    }
  }

  async getDmByMemberId(memberId: string, signal?: AbortSignal): Promise<KeetManagedDm> {
    return this.resolveDm(memberId, signal)
  }

  async listPendingDmRequests(signal?: AbortSignal): Promise<KeetPendingDmRequest[]> {
    ensureSignal(signal)
    const raw = await this.callWithSignal("getDmRequestsByStatus", [DM_REQUEST_PENDING, { reverse: true, limit: MAX_DM_REQUESTS }], signal)
    const values = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.requests) ? raw.requests : []
    const seen = new Set<string>()
    const result: KeetPendingDmRequest[] = []
    for (const value of values.slice(0, MAX_DM_REQUESTS)) {
      const request = normalizePendingDmRequest(value)
      if (!request || seen.has(request.memberId)) continue
      seen.add(request.memberId)
      result.push({ memberId: request.memberId, ...(request.displayName ? { displayName: request.displayName } : {}) })
    }
    return result
  }

  async getPendingDmRequests(signal?: AbortSignal): Promise<KeetPendingDmRequest[]> {
    return this.listPendingDmRequests(signal)
  }

  async acceptDmRequest(memberId: string, signal?: AbortSignal): Promise<KeetManagedDm> {
    const id = boundedMemberId(memberId, "DM Member ID")
    ensureSignal(signal)
    try {
      const already = await this.resolveDm(id, signal)
      if (already.groupId) throw publicError("DM request is already resolved")
    } catch (error) {
      if (!(error instanceof Error) || !/not resolved|operation failed/i.test(error.message)) throw error
    }
    const raw = await this.callWithSignal("getDmRequestsByStatus", [DM_REQUEST_PENDING, { reverse: true, limit: MAX_DM_REQUESTS }], signal)
    const values = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.requests) ? raw.requests : []
    const matches = values.map(normalizePendingDmRequestWithRoom).filter((request) => request?.memberId === id)
    if (matches.length === 0) throw publicError("DM request was not found or is stale")
    if (matches.length !== 1 || !matches[0]!.roomId) throw publicError("DM request is ambiguous")
    await this.callWithSignal("acceptDmRequest", [{ memberId: id, roomId: matches[0]!.roomId }], signal)
    const deadline = Date.now() + this.#pairingTimeoutMs
    for (let attempt = 0; attempt < MAX_POLL && Date.now() < deadline; attempt += 1) {
      ensureSignal(signal)
      try {
        return await this.resolveDm(id, signal)
      } catch (error) {
        if (error instanceof Error && /unsupported room type|belongs to another Member ID/.test(error.message)) throw error
        await delay(Math.min(100 * (attempt + 1), 1_000), signal)
      }
    }
    throw publicError("accepted DM did not become resolvable before the timeout")
  }

  /**
   * Create a disposable interoperability-test room. The DSH adapter never
   * calls this capability and does not expose it as a setting or tool.
   */
  async createRoom(options: CreateGroupOptions): Promise<string> {
    if (!options || typeof options.title !== "string" || !options.title.trim() || options.title.length > 512) {
      throw publicError("room title must be non-empty and at most 512 characters")
    }
    const config: { title: string; description?: string } = { title: options.title.trim() }
    if (options.description !== undefined) {
      if (typeof options.description !== "string" || options.description.length > 2_000) throw publicError("room description is invalid")
      config.description = options.description
    }
    const result = await this.callWithSignal("createRoom", [{ config }])
    if (typeof result !== "string" || !result.trim() || result.length > MAX_GROUP_ID) throw publicError("Keet returned an invalid Managed Group ID")
    return result.trim()
  }

  /**
   * Create a disposable interoperability-test invitation. Invitation tokens
   * are returned only to the explicit caller and are never logged by Core.
   */
  async createInvitation(groupId: string, options: Record<string, unknown> = {}): Promise<Invitation> {
    const id = boundedId(groupId, "Managed Group ID")
    if (!options || typeof options !== "object" || Array.isArray(options)) throw publicError("invitation options are invalid")
    const token = await this.callWithSignal("createInvitation", [id, options])
    if (typeof token !== "string" || !token.trim() || token.includes("://") || token.length > 8_192) throw publicError("Keet returned an invalid invitation token")
    const value = token.trim()
    return { token: value, url: `keet://chat/${value}` }
  }

  async validateGroup(groupId: string): Promise<ManagedGroup> {
    const id = boundedId(groupId, "Managed Group ID")
    const group = (await this.listGroups()).find((candidate) => candidate.groupId === id)
    if (!group) throw publicError("configured Managed Group is not joined")
    return group
  }

  async listMembers(groupId: string): Promise<KeetMember[]> {
    const id = boundedId(groupId, "Managed Group ID")
    const raw = await this.safeCall("getMembers", [id, { limit: 128 }])
    if (!Array.isArray(raw)) throw publicError("Keet returned an invalid member list")
    const byId = new Map<string, KeetMember>()
    for (const value of raw) {
      const member = normalizeMember(value)
      if (!member) continue
      const prior = byId.get(member.memberId)
      if (!prior || member.displayName < prior.displayName) byId.set(member.memberId, member)
    }
    return [...byId.values()]
      .sort((a, b) => a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : a.displayName.localeCompare(b.displayName))
      .slice(0, 128)
  }

  async readRecentMessages(groupId: string, last = MAX_MESSAGES, signal?: AbortSignal): Promise<KeetMessage[]> {
    const id = boundedId(groupId, "Managed Group ID")
    if (!Number.isInteger(last) || last < 1 || last > MAX_MESSAGES) throw publicError("recent message count must be an integer from 1 to 50")
    ensureSignal(signal)
    const raw = await this.callWithSignal("getChatMessages", [id, { limit: last, reverse: true }], signal)
    if (!Array.isArray(raw)) throw publicError("Keet returned an invalid message list")
    const messages: KeetMessage[] = []
    for (const value of raw) {
      const message = normalizeMessage(value, id)
      if (!message) continue
      messages.push(message)
    }
    messages.sort(compareMessages)
    return messages.slice(-last)
  }

  watchMessages(groupId: string, handler: (message: KeetMessage) => void, signal?: AbortSignal): KeetSubscription {
    const id = boundedId(groupId, "Managed Group ID")
    if (typeof handler !== "function") throw publicError("message subscription handler is required")
    ensureSignal(signal)
    let stream
    try {
      stream = this.sidecar.subscribe("subscribeChatMessages", [id, { limit: MAX_MESSAGES, reverse: true }])
    } catch {
      throw publicError("Keet message subscription is unavailable")
    }
    let closed = false
    let terminationReason: KeetSubscription["terminationReason"]
    let initialized = false
    const seen = new Set<string>()
    const terminationHandlers = new Set<(reason: "closed" | "connection-failed") => void>()
    let removeTerminalListener: () => void = () => {}
    const finish = (reason: "closed" | "connection-failed") => {
      if (closed && terminationReason) return
      closed = true
      terminationReason = reason
      signal?.removeEventListener("abort", abort)
      removeTerminalListener()
      for (const listener of terminationHandlers) {
        try { listener(reason) } catch { /* observers never affect teardown */ }
      }
    }
    const abort = () => { void subscription.close().catch(() => undefined) }
    const subscription = {
      get closed() { return closed },
      get terminationReason() { return terminationReason },
      onTerminate: (listener) => {
        terminationHandlers.add(listener)
        if (terminationReason) queueMicrotask(() => {
          try { listener(terminationReason!) } catch { /* observers never affect teardown */ }
        })
        return () => { terminationHandlers.delete(listener) }
      },
      close: async () => {
        if (closed) return
        finish("closed")
        try { stream.destroy() } catch { /* already destroyed */ }
        await pump.catch(() => undefined)
      },
    } as KeetSubscription
    removeTerminalListener = this.sidecar.onTerminal((reason) => {
      if (reason !== "error" && reason !== "exit") return
      if (closed) return
      finish("connection-failed")
      try { stream.destroy(new Error("Keet sidecar connection failed")) } catch { /* already destroyed */ }
    })
    signal?.addEventListener("abort", abort, { once: true })
    const pump = (async () => {
      try {
        for await (const value of stream as AsyncIterable<unknown>) {
          if (closed) break
          const records = Array.isArray(value) ? value : [value]
          const normalized = records.flatMap((record) => {
            const message = normalizeMessage(record, id)
            return message ? [message] : []
          })
          if (!initialized) {
            // The first stream frame is the worker's history snapshot. It is
            // consumed regardless of whether every record is ordinary text or
            // authored by this identity; subsequent frames are live intake.
            initialized = true
            for (const message of normalized) seen.add(messageKey(message.messageId))
            continue
          }
          for (const message of normalized) {
            const key = messageKey(message.messageId)
            if (seen.has(key)) continue
            seen.add(key)
            if (seen.size > 1024) seen.delete(seen.values().next().value as string)
            try { handler(message) } catch { /* subscriber errors never kill intake */ }
          }
        }
      } catch {
        if (!closed) finish(this.#closed ? "closed" : "connection-failed")
      } finally {
        if (!closed) finish(this.#closed ? "closed" : "connection-failed")
        else signal?.removeEventListener("abort", abort)
      }
    })()
    return subscription
  }

  async sendMessage(groupId: string, text: string, replyTo?: KeetMessageId, signal?: AbortSignal): Promise<KeetMessageId | undefined> {
    const id = boundedId(groupId, "Managed Group ID")
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) throw publicError("message text must be non-empty and at most 16,000 characters")
    ensureSignal(signal)
    let target: KeetMessageId | undefined
    if (replyTo !== undefined) {
      const room = (await this.listGroups()).find((candidate) => candidate.groupId === id)
      if (room?.roomType === "DirectMessage") throw publicError("reply targets are not supported for a Managed DM")
      target = normalizeMessageId(replyTo)
      if (!target) throw publicError("reply target is not a valid Keet message ID")
      const history = await this.readRecentMessages(id, MAX_MESSAGES, signal)
      if (!history.some((message) => sameMessageId(message.messageId, target!))) throw publicError("reply target was not found in the configured Managed Group")
    }
    const options = target ? { replyTo: target } : {}
    const result = await this.callWithSignal("addChatMessage", [id, text, options], signal)
    return extractMessageId(result)
  }

  async inspectInvitation(invitation: string, signal?: AbortSignal): Promise<InvitationInfo> {
    const value = validateInvitation(invitation)
    ensureSignal(signal)
    // The public setup surface accepts the canonical URL, while Keet Core's
    // Bare methods consume the opaque token after `keet://chat/`.
    const raw = await this.callWithSignal("getLinkInfo", [invitationToken(value)], signal)
    if (!isRecord(raw) || raw.isRoomInvitation !== true) throw publicError("input is not a Keet room invitation")
    return {
      isRoomInvitation: true,
      ...(typeof raw.title === "string" ? { title: raw.title.slice(0, 512) } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description.slice(0, 512) } : {}),
    }
  }

  async joinInvitation(invitation: string, signal?: AbortSignal): Promise<JoinResult> {
    const value = validateInvitation(invitation)
    await this.inspectInvitation(value, signal)
    ensureSignal(signal)
    const before = new Set((await this.listGroups()).map((group) => group.groupId))
    const started = await this.callWithSignal("startPairingRoom", [invitationToken(value)], signal)
    const startedGroup = normalizeGroup(started)
    if (startedGroup && !before.has(startedGroup.groupId)) return { groupId: startedGroup.groupId }
    const deadline = Date.now() + this.#pairingTimeoutMs
    for (let attempt = 0; attempt < MAX_POLL && Date.now() < deadline; attempt += 1) {
      ensureSignal(signal)
      const groups = await this.listGroups()
      const explicit = groups.find((group) => !before.has(group.groupId))
      if (explicit) return { groupId: explicit.groupId }
      if (startedGroup) {
        const matching = groups.find((group) => group.groupId === startedGroup.groupId)
        if (matching) return { groupId: matching.groupId }
      }
      await delay(Math.min(250 * (attempt + 1), 2_000), signal)
    }
    throw publicError("Keet did not finish joining the invitation before the timeout")
  }

  async updateDisplayName(displayName: string, signal?: AbortSignal): Promise<void> {
    if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 128) throw publicError("display name must be non-empty and at most 128 characters")
    await this.updateIdentityProfile({ displayName: displayName.trim() }, signal)
  }

  async updateIdentityProfile(profile: { readonly displayName?: string; readonly avatar?: PreparedAvatar }, signal?: AbortSignal): Promise<void> {
    if (!profile || typeof profile !== "object") throw publicError("profile update is invalid")
    let displayName: string | undefined
    if (profile.displayName !== undefined) {
      if (typeof profile.displayName !== "string" || !profile.displayName.trim() || profile.displayName.length > 128) throw publicError("display name must be non-empty and at most 128 characters")
      displayName = profile.displayName.trim()
    }
    if (profile.avatar === undefined && displayName === undefined) throw publicError("profile update requires a display name or avatar")
    if (profile.avatar !== undefined) validatePreparedAvatar(profile.avatar)
    if (displayName === undefined) {
      const identity = await this.loadIdentity()
      displayName = identity.label?.trim()
      if (!displayName) throw publicError("avatar update requires a current display name")
    }
    ensureSignal(signal)
    const payload: Record<string, unknown> = { displayName }
    if (profile.avatar !== undefined) payload.avatar = encodePreparedAvatar(profile.avatar)
    await this.callWithSignal("updateIdentityProfile", [payload], signal)
    this.#selfLabel = displayName
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.sidecar.close()
  }

  private async loadIdentity(): Promise<{ id: string; label?: string }> {
    if (this.#selfId) return {
      id: this.#selfId,
      ...(this.#selfLabel ? { label: this.#selfLabel } : {}),
    }
    try {
      const raw = await this.sidecar.call("getIdentity", [])
      if (isRecord(raw)) {
        this.#selfId = firstString(raw.memberId, raw.identityId, raw.id, raw.publicKey)
        this.#selfLabel = firstString(raw.displayName, raw.profile && isRecord(raw.profile) ? raw.profile.displayName : undefined)
      }
    } catch { throw publicError("Keet identity is unavailable") }
    if (!this.#selfId) throw publicError("Keet identity is unavailable")
    return {
      id: this.#selfId,
      ...(this.#selfLabel ? { label: this.#selfLabel } : {}),
    }
  }

  private async safeCall(name: Parameters<KeetSidecar["call"]>[0], args: unknown[]): Promise<unknown> {
    try { return await this.sidecar.call(name, args) } catch { throw publicError("Keet operation failed") }
  }

  private async callWithSignal(name: Parameters<KeetSidecar["call"]>[0], args: unknown[], signal?: AbortSignal): Promise<unknown> {
    ensureSignal(signal)
    const operation = this.sidecar.call(name, args)
    try {
      if (!signal) return await operation
      let abortHandler: (() => void) | undefined
      const cancelled = new Promise<never>((_, reject) => {
        abortHandler = () => reject(publicError("Keet operation cancelled"))
        signal.addEventListener("abort", abortHandler, { once: true })
      })
      try {
        return await Promise.race([operation, cancelled])
      } finally {
        if (abortHandler) signal.removeEventListener("abort", abortHandler)
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Keet operation cancelled") throw error
      throw publicError("Keet operation failed")
    }
  }
}

export function validateAdmission(options: KeetCoreOptions): void {
  try {
    validateKeetCompatibility(options)
  } catch (error) {
    throw publicError(error instanceof Error ? error.message : "unsupported Keet compatibility tuple")
  }
  if (options.runtimeManifest) {
    const manifest = options.runtimeManifest
    try {
      validateKeetCompatibility(manifest)
    } catch {
      throw publicError("official runtime compatibility tuple mismatch")
    }
    if (manifest.executablePath && manifest.executablePath !== options.executablePath) throw publicError("official runtime executable does not match its manifest")
    if (manifest.bundlePath && manifest.bundlePath !== options.bundlePath) throw publicError("official runtime bundle does not match its manifest")
    if (manifest.nativeAddonPaths && manifest.nativeAddonPaths.length !== KEET_NATIVE_ADDON_COUNT) throw publicError("official runtime native-addon closure is incomplete")
  }
  if (options.nativeAddonPaths && options.nativeAddonPaths.length !== KEET_NATIVE_ADDON_COUNT) throw publicError("official runtime native-addon closure is incomplete")
}

function normalizeGroup(value: unknown): ManagedGroup | undefined {
  if (!isRecord(value)) return undefined
  const config = isRecord(value.config) ? value.config : undefined
  const settings = isRecord(value.settings) ? value.settings : config && isRecord(config.settings) ? config.settings : undefined
  const groupId = firstString(value.groupId, value.roomId, value.id, config?.groupId, config?.roomId)
  if (!groupId) return undefined
  const rawRoomType = value.roomType ?? value.type ?? value.kind ?? config?.roomType ?? config?.type ?? settings?.roomType ?? settings?.type
  const roomType = normalizeRoomType(rawRoomType)
  if (rawRoomType !== undefined && !roomType) return undefined
  const dmMemberId = firstString(value.dmMemberId, value.recipient, config?.dmMemberId, config?.recipient)
  return {
    groupId: groupId.slice(0, MAX_GROUP_ID),
    ...(typeof value.title === "string" ? { title: value.title.slice(0, 512) } : typeof config?.title === "string" ? { title: config.title.slice(0, 512) } : {}),
    ...(typeof value.description === "string" ? { description: value.description.slice(0, 512) } : typeof config?.description === "string" ? { description: config.description.slice(0, 512) } : {}),
    ...(roomType ? { roomType } : {}),
    ...(dmMemberId ? { dmMemberId: dmMemberId.slice(0, MAX_MEMBER_ID) } : {}),
  }
}

function normalizeRoomType(value: unknown): KeetRoomType | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "number") {
    if (value === 0) return "Default"
    if (value === 1) return "Broadcast"
    if (value === 2) return "DirectMessage"
    return undefined
  }
  if (typeof value !== "string" || !value.trim()) return undefined
  value = value.trim()
  switch (value) {
    case "0": case "default": case "Default": case "group": case "regular": return "Default"
    case "1": case "broadcast": case "Broadcast": return "Broadcast"
    case "2": case "direct": case "direct-message": case "directMessage": case "DirectMessage": case "dm": return "DirectMessage"
    default: return undefined
  }
}

function hasUnsupportedRoomType(value: unknown): boolean {
  if (!isRecord(value)) return false
  const config = isRecord(value.config) ? value.config : undefined
  const settings = isRecord(value.settings) ? value.settings : config && isRecord(config.settings) ? config.settings : undefined
  const raw = value.roomType ?? value.type ?? value.kind ?? config?.roomType ?? config?.type ?? settings?.roomType ?? settings?.type
  return raw !== undefined && normalizeRoomType(raw) === undefined
}

function normalizeDmResolution(value: unknown, memberId: string): { groupId: string; memberId: string } | undefined {
  if (!isRecord(value)) return undefined
  const groupId = firstString(value.groupId, value.roomId, value.id)
  if (!groupId || groupId.length > MAX_GROUP_ID) return undefined
  const resolvedMember = firstString(value.dmMemberId, value.memberId, value.recipient) ?? memberId
  if (resolvedMember !== memberId) return undefined
  return { groupId: groupId.slice(0, MAX_GROUP_ID), memberId: resolvedMember.slice(0, MAX_MEMBER_ID) }
}

interface RawPendingDmRequest extends KeetPendingDmRequest { readonly roomId?: string }

function normalizePendingDmRequest(value: unknown): KeetPendingDmRequest | undefined {
  const normalized = normalizePendingDmRequestWithRoom(value)
  if (!normalized) return undefined
  return { memberId: normalized.memberId, ...(normalized.displayName ? { displayName: normalized.displayName } : {}) }
}

function normalizePendingDmRequestWithRoom(value: unknown): RawPendingDmRequest | undefined {
  if (!isRecord(value)) return undefined
  const sender = isRecord(value.senderContactInfo) ? value.senderContactInfo : isRecord(value.sender) ? value.sender : isRecord(value.contact) ? value.contact : undefined
  const id = isRecord(value.id) ? value.id : undefined
  const memberId = firstString(value.memberId, id?.memberId, sender?.memberId)
  if (!memberId || memberId.length > MAX_MEMBER_ID) return undefined
  const roomId = firstString(value.roomId, id?.roomId)
  const displayName = firstString(value.displayName, sender?.displayName, value.name)
  return { memberId: memberId.slice(0, MAX_MEMBER_ID), ...(displayName ? { displayName: displayName.slice(0, MAX_MEMBER_ID) } : {}), ...(roomId && roomId.length <= MAX_GROUP_ID ? { roomId: roomId.slice(0, MAX_GROUP_ID) } : {}) }
}

function normalizeMember(value: unknown): KeetMember | undefined {
  if (!isRecord(value)) return undefined
  const nestedMember = isRecord(value.member) ? value.member : undefined
  const memberId = firstString(value.memberId, value.id, value.key, value.deviceId, nestedMember?.memberId, nestedMember?.id)
  if (!memberId) return undefined
  const profile = isRecord(value.profile) ? value.profile : undefined
  const nestedProfile = nestedMember && isRecord(nestedMember.profile) ? nestedMember.profile : undefined
  const displayName = firstString(value.displayName, value.name, profile?.displayName, nestedMember?.displayName, nestedMember?.name, nestedProfile?.displayName) ?? memberId
  const avatar = normalizeAvatarObservation(value.avatar ?? profile?.avatar ?? nestedMember?.avatar ?? nestedProfile?.avatar)
  return {
    memberId: memberId.slice(0, MAX_MEMBER_ID),
    displayName: displayName.slice(0, MAX_MEMBER_ID) || memberId.slice(0, MAX_MEMBER_ID),
    ...(avatar ? { avatar } : {}),
  }
}

function normalizeAvatarObservation(value: unknown): KeetMember["avatar"] | undefined {
  if (!isRecord(value)) return undefined
  const variants = [value.small, value.medium, value.large].filter(isRecord)
  if (!variants.length) return undefined
  const candidate = variants[0]!
  const rawHash = candidate.hash ?? candidate.digest
  if (typeof rawHash === "string" && rawHash.trim()) return { present: true, digest: rawHash.trim().slice(0, 128) }
  if (Buffer.isBuffer(rawHash) || rawHash instanceof Uint8Array) return { present: true, digest: Buffer.from(rawHash).toString("hex").slice(0, 128) }
  const pointer = isRecord(candidate.pointer) ? candidate.pointer : undefined
  const bytes = pointer?.inlined
  if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
    return { present: true, digest: createHash("sha256").update(bytes).digest("hex") }
  }
  if (typeof bytes === "string") {
    try { return { present: true, digest: createHash("sha256").update(Buffer.from(bytes, "base64")).digest("hex") } } catch { /* presence is still safe */ }
  }
  return { present: true }
}

function normalizeMessage(value: unknown, groupId: string): KeetMessage | undefined {
  if (!isRecord(value)) return undefined
  const nestedMessage = isRecord(value.message) ? value.message : undefined
  const nestedContent = isRecord(value.content) ? value.content : undefined
  const chat = isRecord(value.chat) ? value.chat : undefined
  const text = firstText(value.text, value.body, nestedMessage?.text, nestedMessage?.body, nestedContent?.text, nestedContent?.body, chat?.text)
  if (!text || !text.trim() || text.length > MAX_TEXT) return undefined
  const rawGroupId = firstString(value.groupId, value.roomId, nestedMessage?.groupId, nestedMessage?.roomId)
  if (rawGroupId && rawGroupId !== groupId) return undefined
  const kind = firstString(value.type, value.messageType, value.eventType, nestedMessage?.type, nestedContent?.type, nestedContent?.msgtype)
  if (kind && !["text", "ordinary", "m.text"].includes(kind)) return undefined
  if (value.deleted === true || value.edited === true || value.isDeleted === true || value.isEdit === true || chat?.edited === true) return undefined
  if (isRecord(value.relatesTo) || isRecord(value["m.relates_to"])) return undefined
  const rawId = value.messageId ?? value.id ?? value.oplog ?? value.key ?? value
  const messageId = normalizeMessageId(rawId) ?? normalizeMessageId(value)
  if (!messageId) return undefined
  const member = isRecord(value.member) ? value.member : undefined
  const sender = isRecord(value.sender) ? value.sender : isRecord(value.author) ? value.author : isRecord(nestedMessage?.sender) ? nestedMessage.sender : member
  const senderId = firstString(value.senderId, value.memberId, sender?.memberId, sender?.id, member?.memberId, value.authorId, nestedMessage?.senderId, nestedMessage?.memberId)
  if (!senderId) return undefined
  const profile = sender && isRecord(sender.profile) ? sender.profile : undefined
  const senderLabel = firstString(member?.displayName, value.senderLabel, value.displayName, value.senderName, sender?.displayName, profile?.displayName, nestedMessage?.senderLabel) ?? senderId
  const timestamp = firstNumber(value.timestamp, value.sentAt, value.createdAt, value.time, nestedMessage?.timestamp) ?? 0
  const options = isRecord(value.options) ? value.options : undefined
  const replyCandidates: unknown[] = []
  const collectReply = (record: RawRecord | undefined, key: string) => {
    if (record !== undefined && Object.prototype.hasOwnProperty.call(record, key)) replyCandidates.push(record[key])
  }
  collectReply(value, "replyTo")
  collectReply(value, "replyToId")
  collectReply(options, "replyTo")
  collectReply(nestedMessage, "replyTo")
  const replyTargets = replyCandidates.map(normalizeMessageId)
  if (replyTargets.some((target) => !target)) return undefined
  const replyTo = replyTargets[0]
  if (replyTo && replyTargets.some((target) => target!.deviceId !== replyTo.deviceId || target!.seq !== replyTo.seq)) return undefined
  const metadata = isRecord(value.metadata) ? value.metadata : undefined
  const mentions = Array.isArray(chat?.mentions)
    ? normalizeMentions(chat.mentions)
    : Array.isArray(value.mentions)
      ? normalizeMentions(value.mentions)
      : Array.isArray(metadata?.mentions)
        ? normalizeMentions(metadata.mentions)
        : Array.isArray(nestedMessage?.mentions)
          ? normalizeMentions(nestedMessage.mentions)
          : undefined
  return {
    messageId,
    groupId,
    senderId: senderId.slice(0, MAX_MEMBER_ID),
    senderLabel: senderLabel.slice(0, MAX_MEMBER_ID) || senderId.slice(0, MAX_MEMBER_ID),
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    text: text.slice(0, MAX_TEXT),
    ...(mentions && mentions.length > 0 ? { mentions } : {}),
    ...(replyTo ? { replyTo } : {}),
  }
}

function normalizeMentions(values: readonly unknown[]): string[] {
  const mentions: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const memberId = typeof value === "string" ? firstString(value) : isRecord(value) ? firstString(value.memberId) : undefined
    if (!memberId || seen.has(memberId)) continue
    seen.add(memberId)
    mentions.push(memberId.slice(0, MAX_MEMBER_ID))
    if (mentions.length >= 128) break
  }
  return mentions
}

function normalizeMessageId(value: unknown): KeetMessageId | undefined {
  if (!isRecord(value)) return undefined
  const deviceId = firstString(value.deviceId, value.device, value.writerId, value.senderId, value.memberId)
  const seq = firstNumber(value.seq, value.sequence, value.index)
  if (!deviceId || seq === undefined || !Number.isSafeInteger(seq) || seq < 0) return undefined
  return { deviceId: deviceId.slice(0, MAX_MEMBER_ID), seq }
}

function extractMessageId(value: unknown): KeetMessageId | undefined {
  return normalizeMessageId(value) ?? (isRecord(value) ? normalizeMessageId(value.messageId ?? value.id) : undefined)
}

function compareMessages(a: KeetMessage, b: KeetMessage): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  const ak = messageKey(a.messageId); const bk = messageKey(b.messageId)
  return ak < bk ? -1 : ak > bk ? 1 : 0
}

function messageKey(value: KeetMessageId): string { return `${value.deviceId}\u0000${value.seq}` }
function sameMessageId(a: KeetMessageId, b: KeetMessageId): boolean { return a.deviceId === b.deviceId && a.seq === b.seq }
function boundedId(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_GROUP_ID) throw publicError(`${label} must be non-empty`)
  return value.trim()
}
function boundedMemberId(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_MEMBER_ID) throw publicError(`${label} must be non-empty`)
  return value.trim()
}
function validateInvitation(value: string): string {
  if (typeof value !== "string" || value.length > 8_192 || !/^keet:\/\/chat\/[A-Za-z0-9._~%!$&'()*+,;=:@/?-]+$/.test(value.trim())) throw publicError("input must be one Keet room invitation URL")
  return value.trim()
}
function invitationToken(value: string): string {
  return value.slice("keet://chat/".length)
}
function firstString(...values: unknown[]): string | undefined { return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() }
function firstText(...values: unknown[]): string | undefined { return values.find((value): value is string => typeof value === "string" && value.trim().length > 0) }
function firstNumber(...values: unknown[]): number | undefined { return values.find((value): value is number => typeof value === "number" && Number.isFinite(value)) }
function isRecord(value: unknown): value is RawRecord { return typeof value === "object" && value !== null }
function ensureSignal(signal?: AbortSignal): void { if (signal?.aborted) throw publicError("Keet operation cancelled") }
function publicError(message: string): Error { return new Error(message.slice(0, 512)) }

function validatePreparedAvatar(avatar: PreparedAvatar): void {
  if (!avatar || typeof avatar !== "object") throw publicError("avatar is invalid")
  for (const name of ["small", "medium", "large"] as const) {
    const variant = avatar[name] as PreparedAvatarVariant | undefined
    if (!variant || typeof variant !== "object") throw publicError("avatar variant is missing")
    const bytes = variant.bytes
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_AVATAR_BYTES) throw publicError("avatar variant is too large or invalid")
    const expectedSize = name === "small" ? 64 : name === "medium" ? 128 : 256
    if (variant.width !== expectedSize || variant.height !== expectedSize) throw publicError("avatar dimensions are invalid")
    if (typeof variant.contentType !== "string" || !/^image\/(?:png|jpeg|webp)$/.test(variant.contentType)) throw publicError("avatar format is unsupported")
    if (typeof variant.hash !== "string" || !/^[a-f0-9]{64}$/i.test(variant.hash)) throw publicError("avatar hash is invalid")
    if (createHash("sha256").update(bytes).digest("hex") !== variant.hash.toLowerCase()) throw publicError("avatar hash does not match its bytes")
  }
}

function encodePreparedAvatar(avatar: PreparedAvatar): Record<string, unknown> {
  const encode = (variant: PreparedAvatarVariant) => ({
    hash: Buffer.from(variant.hash, "hex"),
    metadata: {
      mimetype: variant.contentType,
      dimensions: { width: variant.width, height: variant.height },
      name: "avatar.png",
    },
    pointer: { inlined: Buffer.from(variant.bytes) },
  })
  return { small: encode(avatar.small), medium: encode(avatar.medium), large: encode(avatar.large) }
}
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const abort = () => finish(() => reject(publicError("Keet operation cancelled")))
    const finish = (settle: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      settle()
    }
    timer = setTimeout(() => finish(resolve), ms)
    if (signal) {
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    }
  })
}
