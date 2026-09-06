import { KeetSidecar } from "./sidecar.js"
import type { Duplex } from "node:stream"
import {
  KEET_NATIVE_ADDON_COUNT,
  validateKeetCompatibility,
  type InvitationInfo,
  type Invitation,
  type CreateGroupOptions,
  type KeetCore,
  type JoinResult,
  type KeetUsernameResult,
  type KeetCoreOptions,
  type KeetMember,
  type KeetMessage,
  type KeetMessageId,
  type KeetReactionSummary,
  type KeetImageFile,
  type KeetImageMediaType,
  type KeetImagePreview,
  type PreparedKeetImage,
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
const MAX_USERNAME_LENGTH = 64
const DM_REQUEST_PENDING = 3
// The bridge acknowledges `chatIndex + 1`, so the retained position must
// leave one safe integer available for that read length.
const MAX_CHAT_INDEX = Number.MAX_SAFE_INTEGER - 1
const MAX_CHAT_LENGTH = Number.MAX_SAFE_INTEGER
const MAX_REACTIONS_PER_MESSAGE = 16
const MAX_REACTION_GRAPHEME_CODE_POINTS = 64
const MAX_REACTION_COUNT = 100_000
// Safe bounded inbound Keet wire-shortcode grammar: picker/custom tokens start
// with a lowercase letter or digit (then lowercase/digit/_+-), or use a
// signed numeric form such as `+1`. This is forward-compatible display
// normalization, not an authenticity assertion.
const KEET_WIRE_SHORTCODE_PATTERN = /^(?:[a-z0-9][a-z0-9_+-]*|[+-][0-9]+)$/
// RegExp's `v` flag keeps the accepted value tied to the runtime's anchored
// RGI emoji property without requiring a maintained Unicode sequence table.
const RGI_EMOJI_PATTERN = new RegExp("^\\p{RGI_Emoji}$", "v")
/** Transport-side bounds; DSH admission applies its own deployment limits. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_COUNT = 16
const MAX_IMAGE_MESSAGE_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_PIXELS = 100_000_000
const MAX_IMAGE_DIMENSION = 20_000
const IMAGE_MEDIA_TYPES = new Set<KeetImageMediaType>(["image/png", "image/jpeg", "image/webp", "image/gif"])
const DEFAULT_IMAGE_ADMISSION_TIMEOUT_MS = 60_000

type RawRecord = Record<string, unknown>

/**
 * Typed Integration Core over the official fd-3 sidecar. No DSH concepts live
 * here; adapters consume only normalized records and bounded destination operations.
 */
export class KeetIntegrationCore implements KeetCore {
  readonly sidecar: KeetSidecar
  readonly #pairingTimeoutMs: number
  /** Bounded Core-owned deadline used by the bridge for one inbound image batch. */
  readonly imageAdmissionTimeoutMs: number
  #selfId: string | undefined
  #selfLabel: string | undefined
  #selfUsername: string | undefined
  #closed = false

  constructor(options: KeetCoreOptions | KeetSidecar, timing: { readonly imageAdmissionTimeoutMs?: number } = {}) {
    this.sidecar = options instanceof KeetSidecar ? options : new KeetSidecar(options)
    this.#pairingTimeoutMs = options instanceof KeetSidecar ? DEFAULT_PAIRING_TIMEOUT_MS : Math.max(1, Math.min(options.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS, DEFAULT_PAIRING_TIMEOUT_MS))
    const configuredImageTimeout = options instanceof KeetSidecar ? timing.imageAdmissionTimeoutMs : options.imageAdmissionTimeoutMs ?? timing.imageAdmissionTimeoutMs
    this.imageAdmissionTimeoutMs = boundedTimeout(configuredImageTimeout, DEFAULT_IMAGE_ADMISSION_TIMEOUT_MS)
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
    return this.listGroupsFromRoomList()
  }

  /**
   * Read the worker's canonical room list and enrich compact recency records
   * with room metadata when necessary.  DM resolution deliberately uses this
   * same path; the pinned worker has no dedicated Member-ID lookup RPC.
   */
  private async listGroupsFromRoomList(signal?: AbortSignal): Promise<ManagedGroup[]> {
    ensureSignal(signal)
    const raw = await this.callWithSignal("getRecentRooms", [], signal)
    const values = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.rooms) ? raw.rooms : []
    const initial = values.slice(0, MAX_GROUPS).flatMap((value) => {
      const group = normalizeGroup(value)
      return group ? [group] : []
    })
    // getRecentRooms intentionally returns a compact recency record. Resolve
    // room metadata through the pinned getRoomInfo call when the compact
    // record did not carry its type or a DirectMessage peer identity. Test
    // workers may already include the metadata, so their fixture shape remains
    // accepted.
    return await Promise.all(initial.map(async (group) => {
      const needsMetadata = group.roomType === undefined || (group.roomType === "DirectMessage" && group.dmMemberId === undefined)
      if (!needsMetadata) return group
      try {
        const rawInfo = await this.callWithSignal("getRoomInfo", [group.groupId], signal)
        const info = normalizeGroup(rawInfo)
        if (info && info.groupId === group.groupId) return {
          ...group,
          ...info,
          ...(info.title === undefined && group.title !== undefined ? { title: group.title } : {}),
          ...(info.description === undefined && group.description !== undefined ? { description: group.description } : {}),
        }
      } catch (error) {
        if (error instanceof Error && error.message === "Keet operation cancelled") throw error
        // A compact room record can omit metadata. It remains visible until a
        // destination admission path requires an explicit room type.
      }
      return group
    }))
  }

  async resolveDm(memberId: string, signal?: AbortSignal): Promise<KeetManagedDm> {
    const id = boundedMemberId(memberId, "DM Member ID")
    ensureSignal(signal)
    const groups = await this.listGroupsFromRoomList(signal)
    const matches = groups.filter((group) => group.roomType === "DirectMessage" && group.dmMemberId === id)
    if (matches.length > 1) throw publicError("configured Managed DM is ambiguous")
    if (matches.length === 0) {
      // A room carrying this peer but a non-DM kind is an explicit mismatch,
      // not an unresolved direct room.  Fail closed instead of widening the
      // destination to a default or broadcast room.
      if (groups.some((group) => group.dmMemberId === id && group.roomType !== "DirectMessage")) {
        throw publicError("configured Managed DM has an unsupported room type")
      }
      throw publicError("configured Managed DM is not resolved")
    }
    const resolved = matches[0]!
    // A pending contact request is not a usable Managed DM until the human
    // acceptance operation has completed, even if the room list is already
    // converging on its direct-message record.
    const pending = await this.listPendingDmRequests(signal)
    if (pending.some((request) => request.memberId === id)) throw publicError("configured Managed DM is not resolved")
    return {
      groupId: resolved.groupId,
      roomType: "DirectMessage",
      dmMemberId: id,
      ...(resolved.title !== undefined ? { title: resolved.title } : {}),
      ...(resolved.description !== undefined ? { description: resolved.description } : {}),
    }
  }

  async listPendingDmRequests(signal?: AbortSignal): Promise<KeetPendingDmRequest[]> {
    ensureSignal(signal)
    const values = await this.pendingDmSnapshot(signal)
    const seen = new Set<string>()
    const result: KeetPendingDmRequest[] = []
    for (const request of values) {
      if (seen.has(request.memberId)) continue
      seen.add(request.memberId)
      result.push({ memberId: request.memberId, ...(request.displayName ? { displayName: request.displayName } : {}) })
    }
    return result
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
    const values = await this.pendingDmSnapshot(signal)
    const matches = values.filter((request) => request.memberId === id)
    if (matches.length === 0) throw publicError("DM request was not found or is stale")
    if (matches.length !== 1 || !matches[0]!.roomId) throw publicError("DM request is ambiguous")
    await this.callWithSignal("acceptDmRequest", [{ memberId: id, roomId: matches[0]!.roomId }], signal)
    const deadline = Date.now() + this.#pairingTimeoutMs
    for (let attempt = 0; attempt < MAX_POLL && Date.now() < deadline; attempt += 1) {
      ensureSignal(signal)
      try {
        return await this.resolveDm(id, signal)
      } catch (error) {
        if (error instanceof Error && /ambiguous|unsupported room type|belongs to another Member ID/.test(error.message)) throw error
        await delay(Math.min(100 * (attempt + 1), 1_000), signal)
      }
    }
    throw publicError("accepted DM did not become resolvable before the timeout")
  }

  private async pendingDmSnapshot(signal?: AbortSignal): Promise<RawPendingDmRequest[]> {
    const raw = await this.callWithSignal("getDmRequestsByStatus", [DM_REQUEST_PENDING, { reverse: true, limit: MAX_DM_REQUESTS }], signal)
    const values = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.requests) ? raw.requests : undefined
    if (!values) throw publicError("Keet returned an invalid pending DM request snapshot")
    const result: RawPendingDmRequest[] = []
    for (const value of values.slice(0, MAX_DM_REQUESTS)) {
      const request = normalizePendingDmRequestWithRoom(value)
      if (!request) throw publicError("Keet returned an invalid pending DM request")
      result.push(request)
    }
    return result
  }

  /**
   * Create a disposable interoperability-test room. The DSH adapter never
   * calls this capability and does not expose it as a setting or tool.
   */
  async createRoom(options: CreateGroupOptions): Promise<string> {
    if (!options || typeof options.title !== "string" || !options.title.trim() || options.title.length > 512) {
      throw publicError("room title must be non-empty and at most 512 characters")
    }
    const config: { title: string; description?: string; roomType?: "0" | "1" } = { title: options.title.trim() }
    if (options.description !== undefined) {
      if (typeof options.description !== "string" || options.description.length > 2_000) throw publicError("room description is invalid")
      config.description = options.description
    }
    if (options.roomType !== undefined) {
      if (options.roomType !== "Default" && options.roomType !== "Broadcast") throw publicError("room type is invalid")
      // The pinned worker's createRoom config uses string enum values: "0"
      // for Default and "1" for Broadcast.
      config.roomType = options.roomType === "Broadcast" ? "1" : "0"
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
      // Bounded explicit reads expose the worker's current edited text; live
      // subscriptions select edit suppression explicitly below.
      const message = normalizeMessage(value, id, { allowEdited: true })
      if (!message) continue
      messages.push(message)
    }
    messages.sort(compareMessages)
    return messages.slice(-last)
  }

  async addReaction(groupId: string, messageId: KeetMessageId, reaction: string, signal?: AbortSignal): Promise<void> {
    const id = boundedId(groupId, "Managed Group ID")
    const target = normalizeMessageId(messageId)
    if (!target) throw publicError("reaction target is not a valid Keet message ID")
    const emoji = validateKeetReaction(reaction)
    ensureSignal(signal)
    const result = await this.callWithSignal("addReaction", [id, target, emoji], signal)
    validateReactionResult(result)
  }

  /**
   * Read one external-blob image through the pinned streaming RPC.  The
   * stream is always destroyed on cancellation, terminal failure, or an
   * exceeded bound; no file pointer or transport detail escapes the public
   * error.
   */
  async readImage(groupId: string, image: KeetImageFile, signal?: AbortSignal): Promise<Uint8Array> {
    const id = boundedId(groupId, "Managed Group ID")
    const descriptor = validateImageFileForRead(image)
    ensureSignal(signal)
    let stream: Duplex
    const readController = new AbortController()
    let timedOut = false
    let parentAbort: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const readSignal = readController.signal
    const abortStream = () => {
      try { stream?.destroy?.(publicError(timedOut ? "Keet image read timed out" : "Keet operation cancelled")) } catch { /* stream is already closed */ }
    }
    try {
      if (signal) {
        parentAbort = () => readController.abort()
        signal.addEventListener("abort", parentAbort, { once: true })
      }
      timer = setTimeout(() => {
        timedOut = true
        readController.abort()
      }, this.imageAdmissionTimeoutMs)
      readSignal.addEventListener("abort", abortStream, { once: true })
      stream = this.sidecar.requestStream("readFileStream", [id, descriptor.file, { includeProgress: false }]) as typeof stream
      if (readSignal.aborted) abortStream()
    } catch {
      if (timer) clearTimeout(timer)
      readSignal.removeEventListener("abort", abortStream)
      if (parentAbort) signal?.removeEventListener("abort", parentAbort)
      throw publicError("Keet image read is unavailable")
    }
    const closeStream = (error?: Error) => {
      try { stream.destroy?.(error) } catch { /* stream is already closed */ }
    }
    try {
      const chunks: Uint8Array[] = []
      let total = 0
      if (signal) {
        if (signal.aborted) throw publicError("Keet operation cancelled")
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const cleanup = () => {
          stream.removeListener("data", onData)
          stream.removeListener("end", onEnd)
          stream.removeListener("close", onClose)
          stream.removeListener("error", onError)
        }
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          cleanup()
          if (error) reject(error)
          else resolve()
        }
        const onData = (value: unknown) => {
          try {
            if (signal?.aborted) throw publicError("Keet operation cancelled")
            if (timedOut) throw publicError("Keet image read timed out")
            const chunk = imageChunk(value)
            if (!chunk || chunk.byteLength < 1) throw publicError("Keet image stream was invalid")
            total += chunk.byteLength
            if (total > MAX_IMAGE_BYTES || total > MAX_IMAGE_MESSAGE_BYTES) throw publicError("Keet image exceeds the supported size")
            chunks.push(chunk)
          } catch (error) {
            finish(error instanceof Error ? error : publicError("Keet image read failed"))
          }
        }
        const onEnd = () => finish()
        const onClose = () => finish(publicError("Keet image stream closed"))
        const onError = (error: unknown) => finish(error instanceof Error ? error : publicError("Keet image read failed"))
        stream.on("data", onData)
        stream.once("end", onEnd)
        stream.once("close", onClose)
        stream.once("error", onError)
        if (signal?.aborted || timedOut) abortStream()
      })
      if (total < 1) throw publicError("Keet image stream was empty")
      if (descriptor.bytes !== undefined && descriptor.bytes !== total) throw publicError("Keet image size did not match its descriptor")
      const result = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
      return result
    } catch (error) {
      closeStream(error instanceof Error ? error : undefined)
      if (signal?.aborted || error instanceof Error && error.message === "Keet operation cancelled") throw publicError("Keet operation cancelled")
      if (timedOut || error instanceof Error && error.message === "Keet image read timed out") throw publicError("Keet image read timed out")
      throw error instanceof Error && /^Keet image/.test(error.message) ? error : publicError("Keet image read failed")
    } finally {
      if (timer) clearTimeout(timer)
      readSignal.removeEventListener("abort", abortStream)
      if (parentAbort) signal?.removeEventListener("abort", parentAbort)
      closeStream()
    }
  }

  /** Save the source bytes and publish one native file/image record. */
  async sendImage(groupId: string, image: PreparedKeetImage, signal?: AbortSignal): Promise<void> {
    const id = boundedId(groupId, "Managed Group ID")
    const prepared = validatePreparedKeetImage(image)
    ensureSignal(signal)
    const metadata: Record<string, unknown> = {
      mimetype: prepared.mediaType,
      dimensions: { width: prepared.width, height: prepared.height },
      ...(prepared.name ? { name: prepared.name } : {}),
    }
    const saved = await this.callWithSignal("saveFileBlob", [id, Buffer.from(prepared.bytes), metadata], signal)
    const file = validateSavedFile(saved)
    const payload = {
      ...file,
      ...(prepared.preview ? { preview: makeNativePreview(prepared.preview, prepared.name) } : {}),
    }
    await this.callWithSignal("sendFile", [id, payload], signal)
  }
  async setUnreadAnchor(groupId: string, length: number, signal?: AbortSignal): Promise<void> {
    const id = boundedId(groupId, "Managed Group ID")
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CHAT_LENGTH) {
      throw publicError("unread anchor length must be a non-negative safe integer")
    }
    ensureSignal(signal)
    const result = await this.callWithSignal("setUnreadAnchor", [id, length], signal)
    validateVoidResult(result, "unread anchor")
  }

  async updateTypingIndicator(groupId: string, signal?: AbortSignal): Promise<void> {
    const id = boundedId(groupId, "Managed Group ID")
    ensureSignal(signal)
    const result = await this.callWithSignal("updateTypingIndicator", [id], signal)
    validateVoidResult(result, "typing indicator")
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
            const message = normalizeMessage(record, id, { allowEdited: false })
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

  async setUsername(username: string, signal?: AbortSignal): Promise<KeetUsernameResult> {
    const requested = validateKeetUsername(username)
    ensureSignal(signal)
    const identity = await this.loadIdentity()
    let submitted = false
    if (identity.username !== requested) {
      const available = await this.callWithSignal("checkUsername", [requested], signal)
      if (typeof available !== "boolean") throw publicError("Keet returned an invalid username availability result")
      if (!available) throw publicError("Keet username is unavailable")

      const operation = identity.username === undefined ? "registerUsername" : "updateUsername"
      const accepted = await this.callWithSignal(operation, [requested], signal)
      if (accepted !== true) throw publicError("Keet did not accept the username update")
      submitted = true
    }

    const deadline = Date.now() + this.#pairingTimeoutMs
    let backoff = 100
    while (Date.now() < deadline) {
      ensureSignal(signal)
      const raw = await this.callWithSignal("lookupUsername", [requested], signal)
      if (raw === null) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await delay(Math.min(backoff, remaining), signal)
        backoff = Math.min(backoff + 100, 1_000)
        continue
      }
      if (!isRecord(raw) || Array.isArray(raw) || raw.username !== requested || typeof raw.memberId !== "string" || !raw.memberId.trim() || raw.memberId.length > MAX_MEMBER_ID) {
        throw publicError("Keet returned an invalid username lookup result")
      }
      if (raw.memberId !== identity.id) throw publicError("Keet username became unavailable")
      this.#selfUsername = requested
      return { status: "searchable", submitted }
    }
    return { status: "pending", submitted }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.sidecar.close()
  }

  private async loadIdentity(): Promise<{ id: string; label?: string; username?: string }> {
    if (this.#selfId) return {
      id: this.#selfId,
      ...(this.#selfLabel ? { label: this.#selfLabel } : {}),
      ...(this.#selfUsername ? { username: this.#selfUsername } : {}),
    }
    try {
      const raw = await this.sidecar.call("getIdentity", [])
      if (isRecord(raw)) {
        const profile = raw.profile && isRecord(raw.profile) ? raw.profile : undefined
        this.#selfId = firstString(raw.memberId, raw.identityId, raw.id, raw.publicKey)
        this.#selfLabel = firstString(raw.displayName, profile?.displayName)
        const username = raw.username ?? profile?.username
        if (username !== undefined) {
          if (typeof username !== "string" || !username || username.length > MAX_USERNAME_LENGTH) throw publicError("Keet identity username is invalid")
          this.#selfUsername = username
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Keet identity username is invalid") throw error
      throw publicError("Keet identity is unavailable")
    }
    if (!this.#selfId) throw publicError("Keet identity is unavailable")
    return {
      id: this.#selfId,
      ...(this.#selfLabel ? { label: this.#selfLabel } : {}),
      ...(this.#selfUsername ? { username: this.#selfUsername } : {}),
    }
  }

  private async safeCall(name: Parameters<KeetSidecar["call"]>[0], args: unknown[]): Promise<unknown> {
    try { return await this.sidecar.call(name, args) } catch { throw publicError("Keet operation failed") }
  }

  private async callWithSignal(name: Parameters<KeetSidecar["call"]>[0], args: unknown[], signal?: AbortSignal): Promise<unknown> {
    ensureSignal(signal)
    let operation: Promise<unknown>
    try { operation = this.sidecar.call(name, args) } catch { throw publicError("Keet operation failed") }
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

export function validateKeetUsername(username: string): string {
  if (typeof username !== "string" || username.length < 3 || username.length > MAX_USERNAME_LENGTH) {
    throw publicError("username must be between 3 and 64 characters")
  }
  if (!/^[A-Za-z0-9_]+$/.test(username) || !/[A-Za-z]/.test(username) || !/[0-9]/.test(username)) {
    throw publicError("username must contain a Latin letter and digit and use only Latin letters, digits, or underscore")
  }
  return username
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

interface RawPendingDmRequest extends KeetPendingDmRequest { readonly roomId?: string }

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

/**
 * Validate the one native reaction grammar shared by every Core caller. The
 * runtime's RGI emoji property is the authority for complete emoji sequences;
 * the small bound prevents pathological input before the property check.
 */
export function validateKeetReaction(value: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) throw publicError("reaction must be exactly one Unicode emoji")
  const codePoints = Array.from(value)
  if (codePoints.length === 0 || codePoints.length > MAX_REACTION_GRAPHEME_CODE_POINTS || Buffer.byteLength(value, "utf8") > MAX_REACTION_GRAPHEME_CODE_POINTS * 4) {
    throw publicError("reaction must be exactly one bounded Unicode emoji")
  }
  if (!RGI_EMOJI_PATTERN.test(value)) throw publicError("reaction must be exactly one Unicode emoji")
  return value
}

function normalizeInboundReaction(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.trim() !== value) return undefined
  try { return validateKeetReaction(value) } catch {
    // Keet wire values may be picker/custom tokens. The bounded grammar is a
    // forward-compatible display boundary, not an authenticity assertion.
  }
  if (Array.from(value).length > MAX_REACTION_GRAPHEME_CODE_POINTS || Buffer.byteLength(value, "utf8") > MAX_REACTION_GRAPHEME_CODE_POINTS * 4 || !KEET_WIRE_SHORTCODE_PATTERN.test(value)) return undefined
  return `:${value}:`
}

function normalizeReactionSummaries(value: RawRecord): readonly KeetReactionSummary[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, "reactions")) return undefined
  const reactions = isRecord(value.reactions) ? value.reactions : undefined
  const digest = reactions && isRecord(reactions.digest) ? reactions.digest : undefined
  const entries = digest && Array.isArray(digest.reactions) ? digest.reactions : []
  const mine = new Set<string>()
  if (reactions && Array.isArray(reactions.mine)) {
    for (const value of reactions.mine.slice(0, MAX_REACTIONS_PER_MESSAGE * 8)) {
      const reaction = normalizeInboundReaction(value)
      if (reaction) mine.add(reaction)
      if (mine.size >= MAX_REACTIONS_PER_MESSAGE) break
    }
  }
  const aggregate = new Map<string, KeetReactionSummary>()
  for (const entry of entries.slice(0, MAX_REACTIONS_PER_MESSAGE * 8)) {
    if (!isRecord(entry) || typeof entry.text !== "string") continue
    const count = entry.count
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > MAX_REACTION_COUNT) continue
    const emoji = normalizeInboundReaction(entry.text)
    if (!emoji) continue
    const prior = aggregate.get(emoji)
    if (!prior) aggregate.set(emoji, { emoji, count, own: mine.has(emoji) })
    else aggregate.set(emoji, { emoji, count: Math.min(MAX_REACTION_COUNT, prior.count + count), own: prior.own || mine.has(emoji) })
  }
  if (!aggregate.size) return []
  return Object.freeze([...aggregate.values()]
    .sort((left, right) => left.emoji < right.emoji ? -1 : left.emoji > right.emoji ? 1 : 0)
    .slice(0, MAX_REACTIONS_PER_MESSAGE)
    .map((reaction) => Object.freeze(reaction)))
}

interface NormalizeMessageOptions {
  readonly allowEdited?: boolean
}

function normalizeMessage(value: unknown, groupId: string, normalizeOptions: NormalizeMessageOptions): KeetMessage | undefined {
  if (!isRecord(value)) return undefined
  const nestedMessage = isRecord(value.message) ? value.message : undefined
  const nestedContent = isRecord(value.content) ? value.content : undefined
  const chat = isRecord(value.chat) ? value.chat : undefined
  const text = firstText(value.text, value.body, nestedMessage?.text, nestedMessage?.body, nestedContent?.text, nestedContent?.body, chat?.text)
  const files = messageFiles(value, nestedMessage, nestedContent)
  const images = normalizeImageFiles(files, groupId)
  // A file-bearing record is admitted only when every file is a supported
  // image.  Text-only records retain their original non-empty requirement;
  // image-only records are valid and carry an empty caption.
  if (files.length > 0 && (!images || images.length !== files.length)) return undefined
  if ((!text || !text.trim()) && (!images || images.length < 1)) return undefined
  if (text && text.length > MAX_TEXT) return undefined
  const rawGroupId = firstString(value.groupId, value.roomId, nestedMessage?.groupId, nestedMessage?.roomId)
  if (rawGroupId && rawGroupId !== groupId) return undefined
  const kind = firstString(value.type, value.messageType, value.eventType, nestedMessage?.type, nestedContent?.type, nestedContent?.msgtype)
  if (kind && !["text", "ordinary", "m.text", "file", "image"].includes(kind)) return undefined
  const edited = value.edited === true || value.isEdit === true || chat?.edited === true
  if (value.deleted === true || value.isDeleted === true || (edited && !normalizeOptions.allowEdited)) return undefined
  if (isRecord(value.relatesTo) || isRecord(value["m.relates_to"])) return undefined
  const rawId = value.messageId ?? value.id ?? value.oplog ?? value.key ?? value
  const messageId = normalizeMessageId(rawId) ?? normalizeMessageId(value)
  if (!messageId) return undefined
  const chatIndex = [value.chatIndex, value.clock, chat?.chatIndex, chat?.clock]
    .map(normalizeChatIndex)
    .find((candidate): candidate is number => candidate !== undefined)
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
    if (record === undefined || !Object.prototype.hasOwnProperty.call(record, key)) return
    const candidate = record[key]
    // Official ordinary text records explicitly carry nullable reply fields.
    // Null/undefined means “no reply”; only present non-null candidates are
    // validated below so malformed or conflicting targets still fail closed.
    if (candidate !== null && candidate !== undefined) replyCandidates.push(candidate)
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
  const reactions = normalizeReactionSummaries(value)
  return {
    messageId,
    groupId,
    senderId: senderId.slice(0, MAX_MEMBER_ID),
    senderLabel: senderLabel.slice(0, MAX_MEMBER_ID) || senderId.slice(0, MAX_MEMBER_ID),
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    text: text?.slice(0, MAX_TEXT) ?? "",
    ...(images && images.length > 0 ? { images } : {}),
    ...(chatIndex !== undefined ? { chatIndex } : {}),
    ...(mentions && mentions.length > 0 ? { mentions } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(reactions ? { reactions } : {}),
  }
}

function messageFiles(value: RawRecord, nestedMessage: RawRecord | undefined, nestedContent: RawRecord | undefined): unknown[] {
  const candidates: unknown[] = [value.files, nestedMessage?.files, nestedContent?.files, value.file, nestedMessage?.file]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      if (candidate.length > 0) return candidate
      continue
    }
    if (candidate !== undefined && candidate !== null) return [candidate]
  }
  return []
}

function normalizeImageFiles(files: readonly unknown[], groupId: string): KeetImageFile[] | undefined {
  if (!files.length) return undefined
  if (files.length > MAX_IMAGE_COUNT) return undefined
  const images: KeetImageFile[] = []
  let total = 0
  for (const value of files) {
    if (!isRecord(value)) return undefined
    const rawRoomId = firstString(value.roomId, value.groupId, value.roomKey)
    if (rawRoomId && rawRoomId !== groupId) return undefined
    const metadata = isRecord(value.metadata) ? value.metadata : undefined
    const pointer = isRecord(value.pointer) ? value.pointer : undefined
    // Only external blobs are readable through the official stream RPC. An
    // inline/drive pointer is a different lifecycle and is rejected here.
    if (!pointer || !hasExternalBlobPointer(pointer.externalBlob)) return undefined
    const rawType = firstString(metadata?.mimetype, metadata?.mimeType, metadata?.mediaType, value.mimetype, value.mimeType, value.mediaType, value.type)
    const mediaType = normalizeImageMediaType(rawType)
    if (!mediaType) return undefined
    const rawDimensions = metadata?.dimensions ?? value.dimensions ?? (value.width !== undefined || value.height !== undefined ? { width: value.width, height: value.height } : undefined)
    if (rawDimensions !== undefined && !isRecord(rawDimensions)) return undefined
    const dimensions = isRecord(rawDimensions) ? rawDimensions : undefined
    const width = normalizeImageDimension(dimensions?.width)
    const height = normalizeImageDimension(dimensions?.height)
    if (rawDimensions !== undefined && (width === undefined || height === undefined)) return undefined
    if (width !== undefined && height !== undefined && (width * height > MAX_IMAGE_PIXELS || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION)) return undefined
    const rawBytes = metadata?.size ?? metadata?.bytes ?? value.bytes ?? value.size
    if (rawBytes !== undefined && normalizeImageByteLength(rawBytes) === undefined) return undefined
    // `externalBlob.blob` is the worker's opaque blob identifier (often a
    // fixed-size key), not the encoded image length.  Trust an explicit
    // metadata/record size only; the streaming read remains authoritative.
    const bytes = normalizeImageByteLength(rawBytes)
    if (bytes !== undefined) {
      if (bytes < 1 || bytes > MAX_IMAGE_BYTES) return undefined
      total += bytes
      if (total > MAX_IMAGE_MESSAGE_BYTES) return undefined
    }
    const rawName = firstString(metadata?.name, value.name)
    const name = rawName ? sanitizeFileName(rawName) : undefined
    images.push({ file: value, mediaType, ...(name ? { name } : {}), ...(bytes !== undefined ? { bytes } : {}), ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) })
  }
  return images
}

function normalizeImageMediaType(value: unknown): KeetImageMediaType | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase().split(";", 1)[0]
  return IMAGE_MEDIA_TYPES.has(normalized as KeetImageMediaType) ? normalized as KeetImageMediaType : undefined
}

function normalizeImageByteLength(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength
  return undefined
}

function normalizeImageDimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_IMAGE_DIMENSION ? value : undefined
}

function sanitizeFileName(value: string): string {
  const base = value.replace(/\\/g, "/").split("/").at(-1)?.trim() ?? ""
  return base ? Array.from(base).slice(0, 255).join("") : ""
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
  if (!deviceId || deviceId.length > MAX_MEMBER_ID || seq === undefined || !Number.isSafeInteger(seq) || seq < 0) return undefined
  return { deviceId, seq }
}

function normalizeChatIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_CHAT_INDEX ? value : undefined
}

function extractMessageId(value: unknown): KeetMessageId | undefined {
  return normalizeMessageId(value) ?? (isRecord(value) ? normalizeMessageId(value.messageId ?? value.id) : undefined)
}

function validateImageFileForRead(image: KeetImageFile): KeetImageFile {
  if (!image || typeof image !== "object" || !IMAGE_MEDIA_TYPES.has(image.mediaType)) throw publicError("Keet image descriptor is invalid")
  if (image.bytes !== undefined && (!Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > MAX_IMAGE_BYTES)) throw publicError("Keet image descriptor is invalid")
  if (image.width !== undefined || image.height !== undefined) {
    if (!normalizeImageDimension(image.width) || !normalizeImageDimension(image.height)) throw publicError("Keet image dimensions are invalid")
    if (image.width! * image.height! > MAX_IMAGE_PIXELS) throw publicError("Keet image dimensions are invalid")
  }
  const file = image.file
  if (!isRecord(file) || !isRecord(file.pointer) || !hasExternalBlobPointer(file.pointer.externalBlob)) throw publicError("Keet image descriptor is invalid")
  return image
}

function hasExternalBlobPointer(value: unknown): value is RawRecord {
  // The blob descriptor is opaque. Presence is the only transport fact Core
  // relies on; its bytes are obtained exclusively through readFileStream.
  return isRecord(value)
    && Object.prototype.hasOwnProperty.call(value, "id")
    && value.id !== null
    && value.id !== undefined
    && Object.prototype.hasOwnProperty.call(value, "blob")
    && value.blob !== null
    && value.blob !== undefined
}

function imageChunk(value: unknown): Uint8Array | undefined {
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  if (value instanceof Uint8Array) return value
  if (isRecord(value) && (Buffer.isBuffer(value.data) || value.data instanceof Uint8Array)) return new Uint8Array(value.data as Uint8Array)
  return undefined
}

function validatePreparedKeetImage(image: PreparedKeetImage): PreparedKeetImage {
  if (!image || typeof image !== "object" || !IMAGE_MEDIA_TYPES.has(image.mediaType)) throw publicError("Keet image is unsupported")
  if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength < 1 || image.bytes.byteLength > MAX_IMAGE_BYTES) throw publicError("Keet image exceeds the supported size")
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width > MAX_IMAGE_DIMENSION || image.height > MAX_IMAGE_DIMENSION || image.width * image.height > MAX_IMAGE_PIXELS) throw publicError("Keet image dimensions are invalid")
  const detected = detectImageMediaType(image.bytes)
  if (detected !== image.mediaType) throw publicError("Keet image format is unsupported")
  if (image.preview !== undefined) {
    const preview = image.preview
    if (!(preview.bytes instanceof Uint8Array) || preview.bytes.byteLength < 1 || preview.bytes.byteLength > 512 * 1024 || !IMAGE_MEDIA_TYPES.has(preview.mediaType)) throw publicError("Keet image preview is invalid")
    if (!Number.isSafeInteger(preview.width) || !Number.isSafeInteger(preview.height) || preview.width < 1 || preview.height < 1 || preview.width > 2_048 || preview.height > 2_048 || preview.width * preview.height > 4_000_000) throw publicError("Keet image preview is invalid")
    if (detectImageMediaType(preview.bytes) !== preview.mediaType) throw publicError("Keet image preview is invalid")
  }
  const name = image.name ? sanitizeFileName(image.name) : ""
  return name ? { ...image, name } : {
    bytes: image.bytes,
    mediaType: image.mediaType,
    width: image.width,
    height: image.height,
    ...(image.preview ? { preview: image.preview } : {}),
  }
}

function detectImageMediaType(bytes: Uint8Array): KeetImageMediaType | undefined {
  if (bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png"
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.byteLength >= 6 && ((bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && bytes[5] === 0x61))) return "image/gif"
  if (bytes.byteLength >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  return undefined
}

function validateSavedFile(value: unknown): RawRecord {
  if (!isRecord(value) || !isRecord(value.pointer) || !hasExternalBlobPointer(value.pointer.externalBlob)) throw publicError("Keet image save failed")
  return value
}

function makeNativePreview(preview: KeetImagePreview, name: string | undefined): RawRecord {
  const variant = {
    metadata: {
      mimetype: preview.mediaType,
      dimensions: { width: preview.width, height: preview.height },
      ...(name ? { name } : {}),
    },
    pointer: { inlined: Buffer.from(preview.bytes) },
  }
  // Keet's display schema accepts any subset of these image variants. One
  // bounded variant is enough for native presentation and avoids duplicating
  // preview bytes in the RPC payload.
  return { small: variant, medium: variant, large: variant }
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
function boundedTimeout(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value), fallback)) : fallback
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

function validateVoidResult(value: unknown, operation: string): void {
  if (value === undefined || value === null) return
  if (!isRecord(value) || Array.isArray(value) || Object.keys(value).length > 0) {
    throw publicError(`Keet returned an invalid ${operation} result`)
  }
}

function validateReactionResult(value: unknown): void {
  // Pinned Keet 4.21.5 API v1 `_addReaction` delegates to room.dispatch(),
  // whose successful dispatch result is exactly `{ key, length }`. RPC 156 is
  // registered with tiny-buffer-rpc/any, so failed/no-op dispatches arrive as
  // undefined or null and must not be treated as confirmed mutations.
  const key = isRecord(value) ? value.key : undefined
  const length = isRecord(value) ? value.length : undefined
  if (!isRecord(value) || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.prototype.hasOwnProperty.call(value, "key") || !Object.prototype.hasOwnProperty.call(value, "length") || !Buffer.isBuffer(key) || key.byteLength !== 32 || typeof length !== "number" || !Number.isSafeInteger(length) || length < 1) {
    throw publicError("Keet returned an invalid reaction result")
  }
}

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
