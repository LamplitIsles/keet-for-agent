import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import path from "node:path"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import type { KeetCore, KeetImageFile, KeetImageMediaType, KeetMessage, KeetMessageId, KeetSubscription } from "@lamplitisles/keet-integration-core"

const MAX_TEXT = 16_000
const MAX_NAME = 512
const MAX_CLIENT_FRAME_BYTES = 4 * 1024
const MAX_PENDING_SOCKET_BYTES = 1024 * 1024
const MAX_PERSISTENCE_QUEUE = 1024
const MAX_CFL_CLIENTS = 64
const HELLO_TIMEOUT_MS = 10_000
const MAX_IMAGES = 16
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_BATCH_BYTES = 32 * 1024 * 1024
const IMAGE_BATCH_TIMEOUT_MS = 60_000
const IMAGE_TYPES = new Set<KeetImageMediaType>(["image/png", "image/jpeg", "image/webp", "image/gif"])

export type CflDestinationKind = "group" | "broadcast" | "dm"
type CflTrigger = "mention" | "label" | "reply" | "dm"
export interface CflDestination {
  readonly groupId: string
  readonly groupName: string
  readonly kind: CflDestinationKind
}
interface PublicDestination { readonly groupName: string; readonly kind: CflDestinationKind }
interface SequenceRange { readonly first: number; readonly last: number }
interface CflMessageFrame {
  readonly type: "message"
  readonly sequence: number
  readonly messageId: KeetMessageId
  readonly timestamp: number
  readonly destination: PublicDestination
  readonly senderLabel: string
  readonly text: string
  readonly images?: readonly CflImage[]
  readonly replyTo?: KeetMessageId
  readonly trigger?: CflTrigger
}
interface CflImage { readonly filename: string; readonly mediaType: KeetImageMediaType; readonly name?: string }
interface CflEventFeedOptions {
  readonly stateDir: string
  readonly mediaDir: string
  readonly retention: number
  readonly core: KeetCore
  readonly identityId: string
  readonly identityLabel?: string
  readonly destinations: readonly CflDestination[]
  readonly isAuthorized: (request: IncomingMessage) => boolean
  readonly onFatal: (error: Error) => void
}

export class CflEventFeed {
  readonly #journalPath: string
  readonly #replacementPath: string
  readonly #mediaAbort = new AbortController()
  readonly #webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_CLIENT_FRAME_BYTES })
  readonly #destinations: readonly CflDestination[]
  readonly #publicDestinations: readonly PublicDestination[]
  readonly #subscriptions: KeetSubscription[] = []
  readonly #subscribers = new Set<WebSocket>()
  readonly #ownMessageIds = new Map<string, Set<string>>()
  #events: readonly CflMessageFrame[] = []
  #nextSequence = 1
  #serialTail = Promise.resolve()
  #queuedPersistence = 0
  #started = false
  #closed = false
  #failure: Error | undefined

  constructor(readonly options: CflEventFeedOptions) {
    this.#journalPath = path.join(options.stateDir, "cfl-events.ndjson")
    this.#replacementPath = path.join(options.stateDir, "cfl-events.ndjson.replacement")
    this.#destinations = Object.freeze(options.destinations.map((destination) => ({ ...destination })))
    this.#publicDestinations = Object.freeze(this.#destinations.map(({ groupName, kind }) => Object.freeze({ groupName, kind })))
  }

  async start(): Promise<void> {
    if (this.#started || this.#closed) throw new Error("CFL event feed is already started.")
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 })
    await chmod(this.options.stateDir, 0o700)
    const info = await stat(this.options.stateDir)
    if (!info.isDirectory()) throw new Error("KEET_MCP_STATE_DIR must be a directory.")
    await mkdir(this.options.mediaDir, { recursive: true, mode: 0o700 })
    await chmod(this.options.mediaDir, 0o700)
    if (!(await stat(this.options.mediaDir)).isDirectory()) throw new Error("KEET_CFL_MEDIA_DIR must be a directory.")
    await rm(this.#replacementPath, { force: true })
    this.#events = await this.#readJournal()
    await this.#verifyRecoveredMedia(this.#events)
    const last = this.#events.at(-1)
    if (last && last.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("CFL event journal sequence is exhausted.")
    this.#nextSequence = (last?.sequence ?? 0) + 1
    if (this.#events.length > this.options.retention) await this.#compact()
    await this.#primeOwnMessageIds()
    this.#started = true
    try {
      for (const destination of this.#destinations) {
        const subscription = this.options.core.watchMessages(destination.groupId, (message) => { this.observe(destination, message) })
        this.#subscriptions.push(subscription)
        subscription.onTerminate?.((reason) => {
          if (!this.#closed && reason === "connection-failed") this.#fail(new Error("Keet message watcher terminated."))
        })
        if (subscription.terminationReason === "connection-failed") throw new Error("Keet message watcher terminated.")
      }
    } catch (error) {
      await this.close()
      throw asError(error, "CFL event feed could not attach Keet watchers.")
    }
  }

  observe(destination: CflDestination, message: KeetMessage): void {
    if (!this.#started || this.#closed || this.#failure) return
    if (message.senderId === this.options.identityId) {
      this.rememberOwnMessage(destination, message.messageId)
      return
    }
    const frame = eventFromMessage(destination, message, this.#nextSequence + this.#queuedPersistence)
    if (!frame) return
    if (this.#queuedPersistence >= MAX_PERSISTENCE_QUEUE) {
      this.#fail(new Error("CFL event persistence queue is full."))
      return
    }
    this.#queuedPersistence += 1
    void this.#serialized(async () => {
      let committed: CflMessageFrame | undefined
      try {
        if (this.#closed || this.#failure) return
        const trigger = await this.#trigger(destination, message)
        committed = await this.#materialize(destination, message, { ...frame, sequence: this.#nextSequence, ...(trigger ? { trigger } : {}) })
        if (!committed) return
        await this.#append(committed)
        this.#nextSequence += 1
        this.#events = Object.freeze([...this.#events, committed])
        if (this.#events.length > this.options.retention) await this.#compact()
        for (const socket of this.#subscribers) this.#send(socket, committed)
      } catch (error) {
        this.#fail(asError(error, "CFL event journal failed."))
      } finally {
        this.#queuedPersistence -= 1
      }
    })
  }

  rememberOwnMessage(destination: CflDestination, messageId: KeetMessageId | undefined): void {
    const id = canonicalId(messageId)
    if (destination.kind !== "group" || !id) return
    let known = this.#ownMessageIds.get(destination.groupId)
    if (!known) { known = new Set(); this.#ownMessageIds.set(destination.groupId, known) }
    known.add(messageIdKey(id))
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.#started || this.#closed || this.#failure || !this.options.isAuthorized(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    if (this.#webSockets.clients.size >= MAX_CFL_CLIENTS) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    try {
      this.#webSockets.handleUpgrade(request, socket, head, (client) => { this.#accept(client) })
    } catch {
      socket.destroy()
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#mediaAbort.abort()
    await this.#serialized(async () => undefined)
    this.#subscribers.clear()
    for (const socket of this.#webSockets.clients) socket.terminate()
    await Promise.all(this.#subscriptions.splice(0).map((subscription) => subscription.close().catch(() => undefined)))
    await new Promise<void>((resolve) => { this.#webSockets.close(() => { resolve() }) })
  }

  #accept(socket: WebSocket): void {
    let helloStarted = false
    const timeout = setTimeout(() => { this.#reject(socket) }, HELLO_TIMEOUT_MS)
    const clearHelloTimeout = () => { clearTimeout(timeout) }
    socket.on("error", () => { clearHelloTimeout(); this.#subscribers.delete(socket) })
    socket.on("close", () => { clearHelloTimeout(); this.#subscribers.delete(socket) })
    socket.on("message", (raw, isBinary) => {
      if (helloStarted) { this.#reject(socket); return }
      helloStarted = true
      clearHelloTimeout()
      void this.#handleHello(socket, raw, isBinary)
    })
  }

  async #handleHello(socket: WebSocket, raw: RawData, isBinary: boolean): Promise<void> {
    const hello = !isBinary ? parseHello(raw) : undefined
    if (!hello) { this.#reject(socket); return }
    await this.#serialized(async () => {
      if (this.#closed || this.#failure || socket.readyState !== WebSocket.OPEN) return
      const range = retainedRange(this.#events)
      if (hello.afterSequence !== undefined && range && hello.afterSequence < range.first - 1) {
        this.#send(socket, { type: "resync_required", retained: range })
        socket.close(1000)
        return
      }
      this.#send(socket, { type: "ready", retained: range, destinations: this.#publicDestinations })
      const after = hello.afterSequence ?? 0
      for (const event of this.#events) if (event.sequence > after) this.#send(socket, event)
      if (socket.readyState === WebSocket.OPEN) this.#subscribers.add(socket)
    }).catch(() => { this.#reject(socket) })
  }

  #send(socket: WebSocket, frame: object): boolean {
    if (socket.readyState !== WebSocket.OPEN) { this.#subscribers.delete(socket); return false }
    const encoded = JSON.stringify(frame)
    if (Buffer.byteLength(encoded) + socket.bufferedAmount > MAX_PENDING_SOCKET_BYTES) {
      this.#subscribers.delete(socket)
      socket.terminate()
      return false
    }
    try {
      socket.send(encoded, { compress: false }, (error) => {
        if (!error) return
        this.#subscribers.delete(socket)
        socket.terminate()
      })
      return true
    } catch {
      this.#subscribers.delete(socket)
      socket.terminate()
      return false
    }
  }

  #reject(socket: WebSocket): void { if (socket.readyState === WebSocket.OPEN) socket.close(1008) }

  #fail(error: Error): void {
    if (this.#closed || this.#failure) return
    this.#failure = error
    queueMicrotask(() => { this.options.onFatal(error) })
  }

  async #append(event: CflMessageFrame): Promise<void> {
    const handle = await open(this.#journalPath, "a", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async #compact(): Promise<void> {
    const retained = this.#events.slice(-this.options.retention)
    const handle = await open(this.#replacementPath, "w", 0o600)
    try {
      await handle.writeFile(retained.map((event) => JSON.stringify(event)).join("\n") + (retained.length ? "\n" : ""), "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(this.#replacementPath, this.#journalPath)
    this.#events = Object.freeze(retained)
  }

  async #primeOwnMessageIds(): Promise<void> {
    for (const destination of this.#destinations) {
      if (destination.kind !== "group") continue
      await this.#refreshOwnMessageIds(destination)
    }
  }

  async #trigger(destination: CflDestination, message: KeetMessage): Promise<CflTrigger | undefined> {
    if (destination.kind === "dm") return "dm"
    if (destination.kind !== "group") return undefined
    if (Array.isArray(message.mentions) && message.mentions.some((memberId) => memberId === this.options.identityId)) return "mention"
    const label = this.options.identityLabel?.trim()
    if (label && message.text.includes(label)) return "label"
    const replyTo = canonicalId(message.replyTo)
    if (replyTo && !this.#ownMessageIds.get(destination.groupId)?.has(messageIdKey(replyTo))) await this.#refreshOwnMessageIds(destination)
    return replyTo && this.#ownMessageIds.get(destination.groupId)?.has(messageIdKey(replyTo)) ? "reply" : undefined
  }

  async #refreshOwnMessageIds(destination: CflDestination): Promise<void> {
    try {
      const messages = await this.options.core.readRecentMessages(destination.groupId, 50)
      for (const message of messages) if (message.senderId === this.options.identityId) this.rememberOwnMessage(destination, message.messageId)
    } catch { /* Reply anchors are best-effort until a watcher or send observes one. */ }
  }

  async #readJournal(): Promise<readonly CflMessageFrame[]> {
    let contents: string
    try { contents = await readFile(this.#journalPath, "utf8") } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    if (!contents) return []
    const completeContents = contents.endsWith("\n") ? contents : contents.slice(0, contents.lastIndexOf("\n") + 1)
    const completeLines = completeContents ? completeContents.slice(0, -1).split("\n") : []
    const events: CflMessageFrame[] = []
    for (const line of completeLines) {
      if (!line) throw new Error("CFL event journal contains an empty record.")
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { throw new Error("CFL event journal contains malformed data.") }
      const event = journalEvent(parsed)
      if (!event || (events.length && event.sequence <= events.at(-1)!.sequence)) throw new Error("CFL event journal contains invalid sequence data.")
      events.push(event)
    }
    if (completeContents !== contents) {
      const handle = await open(this.#journalPath, "r+")
      try {
        await handle.truncate(Buffer.byteLength(completeContents))
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    return Object.freeze(events)
  }

  async #materialize(destination: CflDestination, message: KeetMessage, frame: CflMessageFrame): Promise<CflMessageFrame | undefined> {
    if (destination.kind !== "dm" || !message.images?.length) return frame
    if (message.images.length > MAX_IMAGES) throw new Error("CFL image batch exceeds the supported limit.")
    const published: string[] = []
    const temporary: string[] = []
    const deadline = new AbortController()
    const timeout = setTimeout(() => { deadline.abort() }, IMAGE_BATCH_TIMEOUT_MS)
    const signal = AbortSignal.any([this.#mediaAbort.signal, deadline.signal])
    try {
      const images: CflImage[] = []
      let total = 0
      for (const image of message.images) {
        if (this.#closed || signal.aborted) throw new Error("CFL media materialization cancelled.")
        if (!validImage(image)) throw new Error("CFL image descriptor is invalid.")
        const bytes = await this.options.core.readImage(destination.groupId, image, signal)
        if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES || detectMediaType(bytes) !== image.mediaType) throw new Error("CFL image is unsupported or invalid.")
        total += bytes.byteLength
        if (total > MAX_IMAGE_BATCH_BYTES) throw new Error("CFL image batch exceeds the supported limit.")
        const suffix = extension(image.mediaType)
        const filename = `${randomUUID()}.${suffix}`
        const temporaryName = `.${filename}.tmp`
        temporary.push(temporaryName)
        const temporaryPath = path.join(this.options.mediaDir, temporaryName)
        const finalPath = path.join(this.options.mediaDir, filename)
        const handle = await open(temporaryPath, "wx", 0o600)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        if (this.#closed || signal.aborted) throw new Error("CFL media materialization cancelled.")
        await rename(temporaryPath, finalPath)
        temporary.pop()
        published.push(filename)
        const name = boundedName(image.name, "")
        images.push({ filename, mediaType: image.mediaType, ...(name ? { name } : {}) })
      }
      return { ...frame, images }
    } catch (error) {
      await Promise.all([...published, ...temporary].map(async (filename) => await rm(path.join(this.options.mediaDir, filename), { force: true })))
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async #verifyRecoveredMedia(events: readonly CflMessageFrame[]): Promise<void> {
    for (const image of events.flatMap((event) => event.images ?? [])) {
      let info: Awaited<ReturnType<typeof lstat>>
      try { info = await lstat(path.join(this.options.mediaDir, image.filename)) } catch { throw new Error("CFL event journal references unavailable media.") }
      if (!info.isFile()) throw new Error("CFL event journal references unavailable media.")
    }
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#serialTail
    let release!: () => void
    this.#serialTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }
}

function eventFromMessage(destination: CflDestination, message: KeetMessage, sequence: number): CflMessageFrame | undefined {
  const hasImages = destination.kind === "dm" && !!message.images?.length
  if ((!message.text?.trim() && !hasImages) || !canonicalId(message.messageId) || !Number.isSafeInteger(sequence) || sequence < 1) return undefined
  return {
    type: "message",
    sequence,
    messageId: canonicalId(message.messageId)!,
    timestamp: Number.isSafeInteger(message.timestamp) ? message.timestamp : 0,
    destination: { groupName: boundedName(destination.groupName, "Managed Destination"), kind: destination.kind },
    senderLabel: boundedName(message.senderLabel, "Unknown sender"),
    text: Array.from(message.text ?? "").slice(0, MAX_TEXT).join(""),
    ...(canonicalId(message.replyTo) ? { replyTo: canonicalId(message.replyTo)! } : {}),
  }
}

function journalEvent(value: unknown): CflMessageFrame | undefined {
  if (!isRecord(value) || !onlyKeys(value, ["type", "sequence", "messageId", "timestamp", "destination", "senderLabel", "text", "replyTo", "images", "trigger"]) || !hasKeys(value, ["type", "sequence", "messageId", "timestamp", "destination", "senderLabel", "text"])) return undefined
  const { sequence, messageId, timestamp, destination, senderLabel, text } = value
  const images = value.images === undefined ? undefined : strictImages(value.images)
  if (value.type !== "message" || !positiveSequence(sequence) || !strictId(messageId) || typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || !strictDestination(destination) || !boundedExactString(senderLabel) || !boundedExactText(text, !!images) || (value.images !== undefined && (!images || destination.kind !== "dm"))) return undefined
  const replyTo = value.replyTo === undefined ? undefined : strictId(value.replyTo)
  const trigger = value.trigger === undefined ? undefined : strictTrigger(value.trigger)
  if ((value.replyTo !== undefined && !replyTo) || (value.trigger !== undefined && !trigger) || (destination.kind === "dm" && trigger !== "dm") || (destination.kind !== "dm" && trigger === "dm") || (trigger && trigger !== "dm" && destination.kind !== "group")) return undefined
  return {
    type: "message", sequence, messageId: strictId(messageId)!, timestamp,
    destination: { groupName: destination.groupName, kind: destination.kind }, senderLabel, text, ...(images ? { images } : {}), ...(replyTo ? { replyTo } : {}), ...(trigger ? { trigger } : {}),
  }
}

function parseHello(raw: RawData): { readonly afterSequence?: number } | undefined {
  let value: unknown
  try { value = JSON.parse(rawText(raw)) } catch { return undefined }
  if (!isRecord(value) || value.type !== "hello" || Object.keys(value).some((key) => key !== "type" && key !== "afterSequence")) return undefined
  if (value.afterSequence !== undefined && !nonNegativeSequence(value.afterSequence)) return undefined
  return value.afterSequence === undefined ? {} : { afterSequence: value.afterSequence }
}

function rawText(raw: RawData): string {
  if (typeof raw === "string") return raw
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8")
  return raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") : raw.toString("utf8")
}
function retainedRange(events: readonly CflMessageFrame[]): SequenceRange | null { const first = events[0]; const last = events.at(-1); return first && last ? { first: first.sequence, last: last.sequence } : null }
function canonicalId(value: unknown): KeetMessageId | undefined { return isRecord(value) && typeof value.deviceId === "string" && value.deviceId.trim().length > 0 && Array.from(value.deviceId).length <= MAX_NAME && nonNegativeSequence(value.seq) ? { deviceId: value.deviceId, seq: value.seq } : undefined }
function boundedName(value: unknown, fallback: string): string { const name = typeof value === "string" ? Array.from(value).slice(0, MAX_NAME).join("").replace(/[\r\n\u2028\u2029]+/g, " ").trim() : ""; return name || fallback }
function strictId(value: unknown): KeetMessageId | undefined { return isRecord(value) && onlyKeys(value, ["deviceId", "seq"]) && hasKeys(value, ["deviceId", "seq"]) ? canonicalId(value) : undefined }
function strictTrigger(value: unknown): CflTrigger | undefined { return value === "mention" || value === "label" || value === "reply" || value === "dm" ? value : undefined }
function strictDestination(value: unknown): value is PublicDestination { return isRecord(value) && onlyKeys(value, ["groupName", "kind"]) && hasKeys(value, ["groupName", "kind"]) && typeof value.groupName === "string" && boundedExactString(value.groupName) && destinationKind(value.kind) }
function boundedExactString(value: unknown): value is string { return typeof value === "string" && value.length > 0 && boundedName(value, "") === value }
function boundedExactText(value: unknown, allowEmpty = false): value is string { return typeof value === "string" && (allowEmpty || value.trim().length > 0) && Array.from(value).length <= MAX_TEXT }
function strictImages(value: unknown): readonly CflImage[] | undefined { if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IMAGES) return undefined; const names = new Set<string>(); const images: CflImage[] = []; for (const image of value) { const mediaType = isRecord(image) && IMAGE_TYPES.has(image.mediaType as KeetImageMediaType) ? image.mediaType as KeetImageMediaType : undefined; if (!isRecord(image) || !onlyKeys(image, ["filename", "mediaType", "name"]) || !hasKeys(image, ["filename", "mediaType"]) || typeof image.filename !== "string" || !safeFilename(image.filename) || !mediaType || !image.filename.endsWith(`.${extension(mediaType)}`) || (image.name !== undefined && !boundedExactString(image.name)) || names.has(image.filename)) return undefined; names.add(image.filename); images.push({ filename: image.filename, mediaType, ...(image.name ? { name: image.name } : {}) }) } return Object.freeze(images) }
function safeFilename(value: string): boolean { return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:png|jpg|webp|gif)$/.test(value) }
function validImage(image: KeetImageFile): boolean { return IMAGE_TYPES.has(image.mediaType) && (image.bytes === undefined || Number.isSafeInteger(image.bytes) && image.bytes > 0 && image.bytes <= MAX_IMAGE_BYTES) }
function extension(mediaType: KeetImageMediaType): string { return mediaType === "image/jpeg" ? "jpg" : mediaType.slice(6) }
function detectMediaType(bytes: Uint8Array): KeetImageMediaType | undefined { if (bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png"; if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"; if (bytes.byteLength >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif"; if (bytes.byteLength >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"; return undefined }
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)) }
function hasKeys(value: Record<string, unknown>, required: readonly string[]): boolean { return required.every((key) => Object.hasOwn(value, key)) }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
function destinationKind(value: unknown): value is CflDestinationKind { return value === "group" || value === "broadcast" || value === "dm" }
function nonNegativeSequence(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 }
function positiveSequence(value: unknown): value is number { return nonNegativeSequence(value) && value > 0 }
function messageIdKey(value: KeetMessageId): string { return `${value.deviceId}:${value.seq}` }
function asError(value: unknown, fallback: string): Error { return value instanceof Error ? value : new Error(fallback) }
