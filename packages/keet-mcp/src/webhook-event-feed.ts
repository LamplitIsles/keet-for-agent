import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import sharp from "sharp"
import { validateKeetReaction, type KeetCore, type KeetMessage, type KeetMessageId, type KeetSubscription } from "@lamplitisles/keet-integration-core"
import { InboundImageStore } from "./inbound-image-store.js"

const MAX_TEXT = 16_000
const MAX_NAME = 512
const MAX_PENDING = 1024
const REQUEST_TIMEOUT_MS = 10_000
const RETRY_MIN_MS = 50
const RETRY_MAX_MS = 5_000
const MAX_REACTION_CONTEXT = 16
const MAX_REACTION_READS = 16
const MAX_REACTION_EXCERPT = 48
const MAX_EVENT_BYTES = 112 * 1024
const MAX_IMAGE_MESSAGE_BYTES = 32 * 1024 * 1024

export type WebhookDestinationKind = "group" | "broadcast" | "dm"
interface Addressing { readonly mentionsIdentity: boolean; readonly replyToIdentity?: boolean; readonly identityLabel?: string }
export interface WebhookDestination { readonly groupId: string; readonly groupName: string; readonly kind: WebhookDestinationKind }
interface Event {
  readonly type: "message"
  readonly eventId: string
  readonly sequence: number
  readonly messageId: KeetMessageId
  readonly timestamp: number
  readonly destination: { readonly groupName: string; readonly kind: WebhookDestinationKind }
  readonly senderLabel: string
  readonly text: string
  readonly replyTo?: KeetMessageId
  readonly addressing: Addressing
  readonly reactionContext?: readonly ReactionContext[]
  readonly images?: readonly ImageEntry[]
}
type ImageEntry = { readonly status: "available"; readonly mediaType: string; readonly name?: string; readonly ref: string } | { readonly status: "unavailable"; readonly mediaType: string; readonly name?: string }
interface ReactionContext { readonly targetMessageId: KeetMessageId; readonly targetText: string; readonly emoji: string; readonly externalCount: number }
interface Options {
  readonly stateDir: string
  readonly url: URL
  readonly bearerToken?: string
  readonly core: KeetCore
  readonly imageStore: InboundImageStore
  readonly identityId: string
  readonly identityLabel?: string
  readonly destinations: readonly WebhookDestination[]
  readonly onFatal: (error: Error) => void
}

export class WebhookEventFeed {
  readonly #journalPath: string
  readonly #replacementPath: string
  readonly #sequencePath: string
  readonly #destinations: readonly WebhookDestination[]
  readonly #subscriptions: KeetSubscription[] = []
  readonly #messageOwners = new Map<string, Map<string, boolean>>()
  #events: Event[] = []
  #nextSequence = 1
  #tail = Promise.resolve()
  #queued = 0
  #started = false
  #closed = false
  #failure: Error | undefined
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #delivering = false
  #deliveryPromise: Promise<void> | undefined
  readonly #closeAbort = new AbortController()
  #retryDelay = RETRY_MIN_MS

  constructor(readonly options: Options) {
    this.#journalPath = path.join(options.stateDir, "webhook-events.ndjson")
    this.#replacementPath = path.join(options.stateDir, "webhook-events.ndjson.replacement")
    this.#sequencePath = path.join(options.stateDir, "webhook-sequence")
    this.#destinations = Object.freeze(options.destinations.map((destination) => ({ ...destination })))
  }

  async start(): Promise<void> {
    if (this.#started || this.#closed) throw new Error("Webhook event feed is already started.")
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 }); await chmod(this.options.stateDir, 0o700)
    if (!(await stat(this.options.stateDir)).isDirectory()) throw new Error("KEET_MCP_STATE_DIR must be a directory.")
    await rm(this.#replacementPath, { force: true })
    this.#events = await this.#readJournal()
    this.#nextSequence = await this.#readNextSequence()
    this.#started = true
    try {
      for (const destination of this.#destinations) {
        const subscription = this.options.core.watchMessages(destination.groupId, (message) => { this.observe(destination, message) })
        this.#subscriptions.push(subscription)
        subscription.onTerminate?.((reason) => { if (!this.#closed && reason === "connection-failed") this.#fail(new Error("Keet message watcher terminated.")) })
        if (subscription.terminationReason === "connection-failed") throw new Error("Keet message watcher terminated.")
      }
      this.#scheduleDelivery(0)
    } catch (error) { await this.close(); throw error instanceof Error ? error : new Error("Webhook event feed could not attach Keet watchers.") }
  }

  observe(destination: WebhookDestination, message: KeetMessage): void {
    if (!this.#started || this.#closed || this.#failure) return
    if (message.senderId === this.options.identityId) { this.rememberOwnMessage(destination, message.messageId); return }
    if ((!message.text?.trim() && !message.images?.length) || !canonicalId(message.messageId)) return
    if (this.#queued >= MAX_PENDING) { this.#fail(new Error("Webhook event persistence queue is full.")); return }
    this.#queued += 1
    void this.#serialized(async () => {
      try {
        if (this.#failure) return
        let history: readonly KeetMessage[] = []
        if (destination.kind !== "broadcast" || canonicalId(message.replyTo)) {
          try { history = (await this.options.core.readRecentMessages(destination.groupId, 50)).slice(-50) }
          catch { /* Ownership remains unknown and reactions unavailable. */ }
          for (const prior of history) this.#rememberOwner(destination, prior)
        }
        const reply = canonicalId(message.replyTo)
        const replyToIdentity = reply ? this.#messageOwners.get(destination.groupId)?.get(key(reply)) : undefined
        const identityLabel = bounded(this.options.identityLabel, "")
        const addressing: Addressing = { mentionsIdentity: message.mentions?.includes(this.options.identityId) ?? false, ...(replyToIdentity === undefined ? {} : { replyToIdentity }), ...(identityLabel ? { identityLabel } : {}) }
        this.#rememberOwner(destination, message)
        const event = eventFromMessage(destination, message, this.#nextSequence, addressing)
        if (!event) return
        if (message.images?.length) {
          const images: ImageEntry[] = []
          let imageBytes = 0
          for (const image of message.images) {
            const name = safeImageName(image.name)
            const base = { mediaType: image.mediaType, ...(name ? { name } : {}) }
            let bytes: Uint8Array
            try {
              bytes = await this.options.core.readImage(destination.groupId, image, this.#closeAbort.signal)
              imageBytes += bytes.byteLength
              if (imageBytes > MAX_IMAGE_MESSAGE_BYTES) throw new Error("Inbound image message exceeds the supported size.")
              await validateImage(bytes, image.mediaType)
            }
            catch { images.push({ ...base, status: "unavailable" }); continue }
            const ref = await this.options.imageStore.save(bytes, image.mediaType)
            images.push({ ...base, status: "available", ref })
          }
          Object.assign(event, { images })
        }
        if (destination.kind !== "broadcast") {
          try {
            const context = await reactionContext(this.options.core, destination.groupId, history, this.options.identityId)
            while (context.length && Buffer.byteLength(JSON.stringify({ ...event, reactionContext: context }), "utf8") > MAX_EVENT_BYTES) context.pop()
            if (context.length) Object.assign(event, { reactionContext: context })
          } catch { /* Snapshot collection is best effort; the message event still persists. */ }
        }
        if (Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_EVENT_BYTES) throw new Error("Webhook event exceeds the supported size.")
        await this.#writeNextSequence(this.#nextSequence + 1)
        await this.#append(event)
        this.#nextSequence += 1
        this.#events.push(event)
        this.#scheduleDelivery(0)
      } catch (error) { this.#fail(error instanceof Error ? error : new Error("Webhook event journal failed.")) }
      finally { this.#queued -= 1 }
    })
  }

  rememberOwnMessage(destination: WebhookDestination, messageId: KeetMessageId | undefined): void {
    this.#rememberOwner(destination, { messageId, senderId: this.options.identityId })
  }

  #rememberOwner(destination: WebhookDestination, message: { readonly messageId?: KeetMessageId | undefined; readonly senderId: string }): void {
    const id = canonicalId(message.messageId); if (!id || !message.senderId?.trim()) return
    let owners = this.#messageOwners.get(destination.groupId)
    if (!owners) { owners = new Map(); this.#messageOwners.set(destination.groupId, owners) }
    owners.set(key(id), message.senderId === this.options.identityId)
    if (owners.size > 100) owners.delete(owners.keys().next().value!)
  }

  async close(): Promise<void> {
    this.#closed = true; this.#closeAbort.abort(); if (this.#retryTimer) clearTimeout(this.#retryTimer)
    await Promise.all(this.#subscriptions.splice(0).map(async (subscription) => await subscription.close().catch(() => undefined)))
    await this.#tail
    await this.#deliveryPromise
  }

  #scheduleDelivery(delay: number): void {
    if (this.#closed || this.#failure || this.#retryTimer || this.#delivering || !this.#events.length) return
    this.#retryTimer = setTimeout(() => { this.#retryTimer = undefined; const delivery = this.#deliver(); this.#deliveryPromise = delivery; void delivery.then(() => { if (this.#deliveryPromise === delivery) this.#deliveryPromise = undefined }) }, delay)
  }
  async #deliver(): Promise<void> {
    if (this.#closed || this.#failure || this.#delivering) return
    this.#delivering = true
    let nextDelay = 0
    try {
      const event = this.#events[0]; if (!event) return
      let acknowledged = false
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(this.options.url, { method: "POST", redirect: "manual", signal: AbortSignal.any([controller.signal, this.#closeAbort.signal]), headers: { "content-type": "application/json", ...(this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {}) }, body: JSON.stringify(event) })
        acknowledged = response.status >= 200 && response.status < 300
      } catch { /* Retry network and timeout failures. */ }
      finally { clearTimeout(timeout) }
      if (this.#closed || this.#failure) return
      if (acknowledged) {
        try {
          await this.#serialized(async () => {
            if (this.#events[0] !== event) return
            const remaining = this.#events.slice(1)
            await this.#rewriteJournal(remaining)
            this.#events = remaining
          })
          this.#retryDelay = RETRY_MIN_MS
        } catch { this.#fail(new Error("Webhook event acknowledgement could not be persisted.")); return }
      } else { nextDelay = this.#retryDelay; this.#retryDelay = Math.min(RETRY_MAX_MS, this.#retryDelay * 2) }
    } finally {
      this.#delivering = false
      if (!this.#closed && !this.#failure) this.#scheduleDelivery(nextDelay)
    }
  }
  async #append(event: Event): Promise<void> { const handle = await open(this.#journalPath, "a", 0o600); try { await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8"); await handle.sync() } finally { await handle.close() } }
  async #rewriteJournal(events: readonly Event[]): Promise<void> { const handle = await open(this.#replacementPath, "w", 0o600); try { await handle.writeFile(events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""), "utf8"); await handle.sync() } finally { await handle.close() }; await rename(this.#replacementPath, this.#journalPath) }
  async #readNextSequence(): Promise<number> { const last = this.#events.at(-1)?.sequence ?? 0; try { const value = Number((await readFile(this.#sequencePath, "utf8")).trim()); if (!Number.isSafeInteger(value) || value <= last) throw new Error("Webhook event sequence is invalid."); return value } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; if (last >= Number.MAX_SAFE_INTEGER) throw new Error("Webhook event sequence is exhausted."); await this.#writeNextSequence(last + 1); return last + 1 } }
  async #writeNextSequence(value: number): Promise<void> { const temporary = `${this.#sequencePath}.replacement`; const handle = await open(temporary, "w", 0o600); try { await handle.writeFile(`${value}\n`, "utf8"); await handle.sync() } finally { await handle.close() }; await rename(temporary, this.#sequencePath) }
  async #readJournal(): Promise<Event[]> { let contents: string; try { contents = await readFile(this.#journalPath, "utf8") } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }; if (!contents) return []; if (!contents.endsWith("\n")) { const complete = contents.slice(0, contents.lastIndexOf("\n") + 1); const handle = await open(this.#journalPath, "r+"); try { await handle.truncate(Buffer.byteLength(complete)); await handle.sync() } finally { await handle.close() }; contents = complete }; const events = contents.slice(0, -1).split("\n").map((line) => parseJournalLine(line)); if (events.some((event) => !event) || events.some((event, index) => index && event!.sequence <= events[index - 1]!.sequence)) throw new Error("Webhook event journal contains invalid data."); return events as Event[] }
  async #serialized<T>(operation: () => Promise<T>): Promise<T> { const previous = this.#tail; let release!: () => void; this.#tail = new Promise((resolve) => { release = resolve }); await previous; try { return await operation() } finally { release() } }
  #fail(error: Error): void { if (this.#failure) return; this.#failure = error; this.options.onFatal(error) }
}

function eventFromMessage(destination: WebhookDestination, message: KeetMessage, sequence: number, addressing: Addressing): Event | undefined {
  const messageId = canonicalId(message.messageId)
  if ((!message.text?.trim() && !message.images?.length) || !messageId || !Number.isSafeInteger(sequence) || sequence < 1) return undefined
  const sourceText = Array.from(message.text).slice(0, MAX_TEXT).join("")
  const text = sourceText.trim() ? sourceText : Array.from(message.text.trim()).slice(0, MAX_TEXT).join("")
  const replyTo = canonicalId(message.replyTo)
  return {
    type: "message", eventId: randomUUID(), sequence, messageId,
    timestamp: Number.isSafeInteger(message.timestamp) ? message.timestamp : 0,
    destination: { groupName: bounded(destination.groupName, "Managed Destination"), kind: destination.kind },
    senderLabel: bounded(message.senderLabel === message.senderId ? undefined : message.senderLabel, "Unknown sender"), text,
    ...(replyTo ? { replyTo } : {}), addressing,
  }
}
function eventFromJournal(value: unknown): Event | undefined {
  if (!record(value) || !onlyKeys(value, ["type", "eventId", "sequence", "messageId", "timestamp", "destination", "senderLabel", "text", "replyTo", "addressing", "reactionContext", "images"])) return undefined
  const destination = value.destination
  if (value.type !== "message" || typeof value.eventId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.eventId) || !positive(value.sequence) || !strictId(value.messageId) || !Number.isSafeInteger(value.timestamp)) return undefined
  if (!record(destination) || !onlyKeys(destination, ["groupName", "kind"]) || !boundedExact(destination.groupName) || !kind(destination.kind) || !boundedExact(value.senderLabel)) return undefined
  if (typeof value.text !== "string" || Array.from(value.text).length > MAX_TEXT || (!value.text.trim() && !value.images?.length)) return undefined
  const images = value.images
  if (images !== undefined && (!Array.isArray(images) || !images.length || images.length > 16 || !images.every(validImageEntry))) return undefined
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_EVENT_BYTES) return undefined
  const replyTo = value.replyTo === undefined ? undefined : strictId(value.replyTo)
  const addressing = value.addressing
  if ((value.replyTo !== undefined && !replyTo) || !validAddressing(addressing) || (addressing.replyToIdentity !== undefined && !replyTo)) return undefined
  const reactionContext = value.reactionContext
  if (reactionContext !== undefined && (destination.kind === "broadcast" || !Array.isArray(reactionContext) || !reactionContext.length || reactionContext.length > MAX_REACTION_CONTEXT || !reactionContext.every(validReactionContext) || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_EVENT_BYTES)) return undefined
  return {
    type: "message", eventId: value.eventId, sequence: value.sequence, messageId: strictId(value.messageId)!, timestamp: value.timestamp,
    destination: { groupName: destination.groupName, kind: destination.kind }, senderLabel: value.senderLabel, text: value.text,
    ...(replyTo ? { replyTo } : {}), addressing, ...(reactionContext ? { reactionContext } : {}), ...(images ? { images } : {}),
  }
}
async function reactionContext(core: KeetCore, groupId: string, history: readonly KeetMessage[], identityId: string): Promise<ReactionContext[]> {
  const result: ReactionContext[] = []
  let reads = 0
  for (const message of history.slice(-50).reverse()) {
    if (message.senderId !== identityId || !strictId(message.messageId) || Array.from(message.messageId.deviceId).length > 128 || !message.text?.trim() || !message.reactions?.length) continue
    const targetText = Array.from(message.text).slice(0, MAX_REACTION_EXCERPT).join("").trim()
    if (!targetText) continue
    if (reads >= MAX_REACTION_READS) break
    reads += 1
    let complete: Awaited<ReturnType<KeetCore["readReactions"]>>
    try { complete = await core.readReactions(groupId, message.messageId) }
    catch { continue }
    if (!complete) continue
    for (const reaction of complete) {
      const externalCount = reaction.count - (reaction.own ? 1 : 0)
      if (!validEmoji(reaction.emoji) || !positive(externalCount) || externalCount > 100_000) continue
      result.push({ targetMessageId: message.messageId, targetText, emoji: reaction.emoji, externalCount })
      if (result.length >= MAX_REACTION_CONTEXT) return result
    }
  }
  return result
}
function validEmoji(value: unknown): value is string { if (typeof value !== "string" || Array.from(value).length > 66 || Buffer.byteLength(value, "utf8") > 258) return false; try { validateKeetReaction(value); return true } catch { return /^:(?:[a-z0-9][a-z0-9_+-]*|[+-][0-9]+):$/.test(value) } }
function validReactionContext(value: unknown): boolean { return record(value) && onlyKeys(value, ["targetMessageId", "targetText", "emoji", "externalCount"]) && !!strictId(value.targetMessageId) && Array.from(value.targetMessageId.deviceId).length <= 128 && typeof value.targetText === "string" && value.targetText.trim().length > 0 && Array.from(value.targetText).length <= MAX_REACTION_EXCERPT && validEmoji(value.emoji) && positive(value.externalCount) && value.externalCount <= 100_000 }
function validImageEntry(value: unknown): boolean { return record(value) && onlyKeys(value, ["status", "mediaType", "name", "ref"]) && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(value.mediaType) && (value.name === undefined || boundedExact(value.name)) && (value.status === "unavailable" && value.ref === undefined || value.status === "available" && typeof value.ref === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:png|jpg|webp|gif)$/.test(value.ref)) }
function safeImageName(value: string | undefined): string | undefined { const name = bounded(value?.replace(/\\/g, "/").split("/").at(-1), ""); return name && name !== "." && name !== ".." ? name : undefined }
async function validateImage(bytes: Uint8Array, mediaType: string): Promise<void> {
  const image = sharp(Buffer.from(bytes), { limitInputPixels: 100_000_000, failOn: "error" })
  const metadata = await image.metadata()
  const expected = mediaType === "image/jpeg" ? "jpeg" : mediaType.slice(6)
  if (metadata.format !== expected || !metadata.width || !metadata.height || metadata.width > 20_000 || metadata.height > 20_000 || metadata.width * metadata.height > 100_000_000) throw new Error("Inbound image format is invalid.")
  await image.stats()
}
function canonicalId(value: unknown): KeetMessageId | undefined { return record(value) && typeof value.deviceId === "string" && value.deviceId.trim().length > 0 && Array.from(value.deviceId).length <= MAX_NAME && Number.isSafeInteger(value.seq) && value.seq >= 0 ? { deviceId: value.deviceId, seq: value.seq } : undefined }
function bounded(value: unknown, fallback: string): string { const text = typeof value === "string" ? Array.from(value).slice(0, MAX_NAME).join("").replace(/[\r\n\u2028\u2029]+/g, " ").trim() : ""; return text || fallback }
function boundedExact(value: unknown): value is string { return typeof value === "string" && value.length > 0 && bounded(value, "") === value }
function kind(value: unknown): value is WebhookDestinationKind { return value === "group" || value === "broadcast" || value === "dm" }
function validAddressing(value: unknown): value is Addressing { return record(value) && onlyKeys(value, ["mentionsIdentity", "replyToIdentity", "identityLabel"]) && typeof value.mentionsIdentity === "boolean" && (value.replyToIdentity === undefined || typeof value.replyToIdentity === "boolean") && (value.identityLabel === undefined || boundedExact(value.identityLabel)) }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 }
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value) }
function key(value: KeetMessageId): string { return `${value.deviceId}:${value.seq}` }

function strictId(value: unknown): KeetMessageId | undefined { return record(value) && onlyKeys(value, ["deviceId", "seq"]) ? canonicalId(value) : undefined }
function onlyKeys(value: Record<string, any>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)) }
function parseJournalLine(line: string): Event | undefined { try { return eventFromJournal(JSON.parse(line)) } catch { throw new Error("Webhook event journal contains invalid data.") } }
