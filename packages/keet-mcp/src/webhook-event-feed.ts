import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { KeetCore, KeetMessage, KeetMessageId, KeetSubscription } from "@lamplitisles/keet-integration-core"

const MAX_TEXT = 16_000
const MAX_NAME = 512
const MAX_PENDING = 1024
const REQUEST_TIMEOUT_MS = 10_000
const RETRY_MIN_MS = 50
const RETRY_MAX_MS = 5_000

export type WebhookDestinationKind = "group" | "broadcast" | "dm"
type Trigger = "mention" | "label" | "reply" | "dm"
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
  readonly trigger?: Trigger
}
interface Options {
  readonly stateDir: string
  readonly url: URL
  readonly bearerToken?: string
  readonly core: KeetCore
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
  readonly #ownMessageIds = new Map<string, Set<string>>()
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
    await this.#primeOwnMessageIds()
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
    if (!message.text?.trim() || !canonicalId(message.messageId)) return
    if (this.#queued >= MAX_PENDING) { this.#fail(new Error("Webhook event persistence queue is full.")); return }
    this.#queued += 1
    void this.#serialized(async () => {
      try {
        if (this.#failure) return
        const trigger = await this.#trigger(destination, message)
        const event = eventFromMessage(destination, message, this.#nextSequence, trigger)
        if (!event) return
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
    const id = canonicalId(messageId); if (destination.kind !== "group" || !id) return
    let ids = this.#ownMessageIds.get(destination.groupId); if (!ids) { ids = new Set(); this.#ownMessageIds.set(destination.groupId, ids) }; ids.add(key(id))
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
  async #primeOwnMessageIds(): Promise<void> { for (const destination of this.#destinations) if (destination.kind === "group") await this.#refreshOwnMessageIds(destination) }
  async #trigger(destination: WebhookDestination, message: KeetMessage): Promise<Trigger | undefined> { if (destination.kind === "dm") return "dm"; if (destination.kind !== "group") return undefined; if (message.mentions?.some((id) => id === this.options.identityId)) return "mention"; if (this.options.identityLabel?.trim() && message.text.includes(this.options.identityLabel.trim())) return "label"; const reply = canonicalId(message.replyTo); if (reply && !this.#ownMessageIds.get(destination.groupId)?.has(key(reply))) await this.#refreshOwnMessageIds(destination); return reply && this.#ownMessageIds.get(destination.groupId)?.has(key(reply)) ? "reply" : undefined }
  async #refreshOwnMessageIds(destination: WebhookDestination): Promise<void> { try { for (const message of await this.options.core.readRecentMessages(destination.groupId, 50)) if (message.senderId === this.options.identityId) this.rememberOwnMessage(destination, message.messageId) } catch { /* Reply history is best effort. */ } }
  async #serialized<T>(operation: () => Promise<T>): Promise<T> { const previous = this.#tail; let release!: () => void; this.#tail = new Promise((resolve) => { release = resolve }); await previous; try { return await operation() } finally { release() } }
  #fail(error: Error): void { if (this.#failure) return; this.#failure = error; this.options.onFatal(error) }
}

function eventFromMessage(destination: WebhookDestination, message: KeetMessage, sequence: number, trigger?: Trigger): Event | undefined {
  const messageId = canonicalId(message.messageId)
  if (!message.text?.trim() || !messageId || !Number.isSafeInteger(sequence) || sequence < 1) return undefined
  const sourceText = Array.from(message.text).slice(0, MAX_TEXT).join("")
  const text = sourceText.trim() ? sourceText : Array.from(message.text.trim()).slice(0, MAX_TEXT).join("")
  const replyTo = canonicalId(message.replyTo)
  return {
    type: "message", eventId: randomUUID(), sequence, messageId,
    timestamp: Number.isSafeInteger(message.timestamp) ? message.timestamp : 0,
    destination: { groupName: bounded(destination.groupName, "Managed Destination"), kind: destination.kind },
    senderLabel: bounded(message.senderLabel === message.senderId ? undefined : message.senderLabel, "Unknown sender"), text,
    ...(replyTo ? { replyTo } : {}), ...(trigger ? { trigger } : {}),
  }
}
function eventFromJournal(value: unknown): Event | undefined {
  if (!record(value) || !onlyKeys(value, ["type", "eventId", "sequence", "messageId", "timestamp", "destination", "senderLabel", "text", "replyTo", "trigger"])) return undefined
  const destination = value.destination
  if (value.type !== "message" || typeof value.eventId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.eventId) || !positive(value.sequence) || !strictId(value.messageId) || !Number.isSafeInteger(value.timestamp)) return undefined
  if (!record(destination) || !onlyKeys(destination, ["groupName", "kind"]) || !boundedExact(destination.groupName) || !kind(destination.kind) || !boundedExact(value.senderLabel)) return undefined
  if (typeof value.text !== "string" || !value.text.trim() || Array.from(value.text).length > MAX_TEXT) return undefined
  const replyTo = value.replyTo === undefined ? undefined : strictId(value.replyTo)
  const trigger = value.trigger === undefined ? undefined : triggerValue(value.trigger)
  if ((value.replyTo !== undefined && !replyTo) || (value.trigger !== undefined && !trigger)) return undefined
  if ((destination.kind === "dm" && trigger !== "dm") || (destination.kind !== "dm" && trigger === "dm") || (destination.kind === "broadcast" && trigger)) return undefined
  return {
    type: "message", eventId: value.eventId, sequence: value.sequence, messageId: strictId(value.messageId)!, timestamp: value.timestamp,
    destination: { groupName: destination.groupName, kind: destination.kind }, senderLabel: value.senderLabel, text: value.text,
    ...(replyTo ? { replyTo } : {}), ...(trigger ? { trigger } : {}),
  }
}
function canonicalId(value: unknown): KeetMessageId | undefined { return record(value) && typeof value.deviceId === "string" && value.deviceId.trim().length > 0 && Array.from(value.deviceId).length <= MAX_NAME && Number.isSafeInteger(value.seq) && value.seq >= 0 ? { deviceId: value.deviceId, seq: value.seq } : undefined }
function bounded(value: unknown, fallback: string): string { const text = typeof value === "string" ? Array.from(value).slice(0, MAX_NAME).join("").replace(/[\r\n\u2028\u2029]+/g, " ").trim() : ""; return text || fallback }
function boundedExact(value: unknown): value is string { return typeof value === "string" && value.length > 0 && bounded(value, "") === value }
function kind(value: unknown): value is WebhookDestinationKind { return value === "group" || value === "broadcast" || value === "dm" }
function triggerValue(value: unknown): Trigger | undefined { return value === "mention" || value === "label" || value === "reply" || value === "dm" ? value : undefined }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 }
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value) }
function key(value: KeetMessageId): string { return `${value.deviceId}:${value.seq}` }

function strictId(value: unknown): KeetMessageId | undefined { return record(value) && onlyKeys(value, ["deviceId", "seq"]) ? canonicalId(value) : undefined }
function onlyKeys(value: Record<string, any>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)) }
function parseJournalLine(line: string): Event | undefined { try { return eventFromJournal(JSON.parse(line)) } catch { throw new Error("Webhook event journal contains invalid data.") } }
