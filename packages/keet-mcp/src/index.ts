import { createServer, type Server } from "node:http"
import { constants } from "node:fs"
import { chmod, mkdir, open, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { lookup as lookupMediaType } from "mime-types"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { KeetIntegrationCore, KEET_COMPATIBILITY, validateKeetReaction, type KeetCore, type KeetCoreOptions, type KeetMember, type KeetMessage, type KeetMessageId, type PreparedKeetFile } from "@lamplitisles/keet-integration-core"
import * as z from "zod/v4"
import { WebhookEventFeed, type WebhookDestination } from "./webhook-event-feed.js"

export type DestinationKind = "group" | "broadcast" | "dm"
export interface Destination { readonly groupId: string; readonly groupName: string; readonly kind: DestinationKind }
export interface GatewayConfig { readonly runtimeDir: string; readonly identityDir: string; readonly workspaceRoot: string; readonly stateDir: string; readonly listen: string; readonly token: string; readonly webhookUrl?: string; readonly webhookBearerToken?: string }
export interface GatewayOptions { readonly config: GatewayConfig; readonly createCore?: (options: KeetCoreOptions) => Promise<KeetCore>; readonly onFatal?: () => void }

const MAX_TEXT = 16_000
const MAX_NAME = 512
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_PIXELS = 100_000_000
const MAX_DIMENSION = 20_000
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
const MAX_SESSIONS = 64

export function configurationFromEnvironment(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const webhookUrl = optional(env, "KEET_WEBHOOK_URL"); const webhookBearerToken = optional(env, "KEET_WEBHOOK_BEARER_TOKEN")
  if (webhookBearerToken && !webhookUrl) throw new Error("KEET_WEBHOOK_BEARER_TOKEN requires KEET_WEBHOOK_URL.")
  if (webhookUrl) validateWebhookUrl(webhookUrl)
  return {
    runtimeDir: required(env, "KEET_MCP_RUNTIME_DIR"), identityDir: required(env, "KEET_MCP_IDENTITY_DIR"),
    workspaceRoot: required(env, "KEET_MCP_WORKSPACE_ROOT"), stateDir: required(env, "KEET_MCP_STATE_DIR"), listen: required(env, "KEET_MCP_LISTEN"), token: required(env, "KEET_MCP_TOKEN"), ...(webhookUrl ? { webhookUrl } : {}), ...(webhookBearerToken ? { webhookBearerToken } : {}),
  }
}
function required(env: NodeJS.ProcessEnv, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`Missing ${name}.`); return value }
function optional(env: NodeJS.ProcessEnv, name: string): string | undefined { const value = env[name]?.trim(); return value || undefined }
function textResult(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] } }
function toolError(error: unknown, fallback: string, signal?: AbortSignal) {
  const message = error instanceof Error ? error.message : ""
  const allowed = ["destinationName is not an allowed Managed Destination.", "Managed Destination name is ambiguous.", "Managed Broadcast rosters are unavailable.", "Managed Broadcast sends do not support reactions.", "reaction target is not a valid Keet message ID.", "reaction must be exactly one Unicode emoji", "reaction must be exactly one bounded Unicode emoji", "DM sends do not support replyTo.", "Managed Broadcast sends do not support replyTo.", "native mentions are supported only for regular Managed Groups.", "each mention must name one current unique member.", "text must be non-empty and at most 16,000 characters.", "path must be a workspace-contained file path.", "path must stay inside the workspace.", "workspace file could not be read.", "workspace file is missing or exceeds the 100 MiB limit.", "workspace image format is unsupported or corrupt."]
  const publicMessage = signal?.aborted ? "Keet operation cancelled." : allowed.includes(message) ? message : fallback
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: publicMessage }) }], isError: true }
}
function normalizeName(value: unknown, fallback: string): string { const name = typeof value === "string" ? Array.from(value).slice(0, MAX_NAME).join("").replace(/[\r\n\u2028\u2029]+/g, " ").trim() : ""; return name || fallback }
function destinationFromRoom(room: { groupId: string; roomType?: string; dmMemberId?: string; title?: string }, pending: ReadonlySet<string>): Destination | undefined {
  if (!room.groupId) return undefined
  if (room.roomType === "Default") return { groupId: room.groupId, groupName: normalizeName(room.title, "Managed Group"), kind: "group" }
  if (room.roomType === "Broadcast") return { groupId: room.groupId, groupName: normalizeName(room.title, "Managed Broadcast"), kind: "broadcast" }
  if (room.roomType === "DirectMessage" && room.dmMemberId && !pending.has(room.dmMemberId.trim())) return { groupId: room.groupId, groupName: normalizeName(room.title, "Managed DM"), kind: "dm" }
  return undefined
}
function validMessageId(value: unknown): value is KeetMessageId { return !!value && typeof value === "object" && typeof (value as KeetMessageId).deviceId === "string" && (value as KeetMessageId).deviceId.trim().length > 0 && typeof (value as KeetMessageId).seq === "number" && Number.isSafeInteger((value as KeetMessageId).seq) && (value as KeetMessageId).seq >= 0 }
function messageRecord(message: KeetMessage, kind: DestinationKind): object | undefined {
  if (!message.text?.trim()) return undefined
  const base = { senderLabel: normalizeName(message.senderLabel === message.senderId ? undefined : message.senderLabel, "Unknown sender"), timestamp: Number.isFinite(message.timestamp) ? message.timestamp : 0, text: Array.from(message.text).slice(0, MAX_TEXT).join("") }
  if (kind === "dm") return base
  if (!validMessageId(message.messageId)) return undefined
  return { messageId: message.messageId, ...base, ...(kind === "group" && validMessageId(message.replyTo) ? { replyTo: message.replyTo } : {}) }
}
function mediaType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | undefined {
  if (bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png"
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.byteLength >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif"
  if (bytes.byteLength >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
}

export class KeetMcpGateway {
  #core: KeetCore | undefined; #destinations: readonly Destination[] = []; #server: Server | undefined; #workspaceRoot: string | undefined; #starting = false; #closing = false; #startPromise: Promise<void> | undefined; #closePromise: Promise<void> | undefined; #operationAbort = new AbortController()
  #sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>(); #sendTails = new Map<string, Promise<void>>()
  #eventFeed: WebhookEventFeed | undefined; #failure: Error | undefined
  constructor(readonly options: GatewayOptions) {}
  get address(): string | undefined { const address = this.#server?.address(); return address && typeof address !== "string" ? `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}/mcp` : undefined }
  get destinations(): readonly Destination[] { return this.#destinations.map((item) => ({ ...item })) }
  get sessionCount(): number { return this.#sessions.size }
  async start(): Promise<void> {
    if (this.#failure) throw this.#failure
    if (this.#closing || this.#starting || this.#server || this.#core) throw new Error("Keet gateway is already started.")
    if (this.#operationAbort.signal.aborted) this.#operationAbort = new AbortController()
    this.#starting = true
    const attempt = this.startImpl(); this.#startPromise = attempt
    try { await attempt } finally { if (this.#startPromise === attempt) this.#startPromise = undefined; this.#starting = false }
  }
  private async startImpl(): Promise<void> {
    let created: KeetCore | undefined; let createdFeed: WebhookEventFeed | undefined
    try {
      const config = await validateConfig(this.options.config)
      const coreOptions: KeetCoreOptions = { executablePath: path.join(config.runtimeDir, "bare"), bundlePath: path.join(config.runtimeDir, "core-worker.bundle"), dataPath: config.identityDir, appVersion: KEET_COMPATIBILITY.appVersion, expectedCoreVersion: KEET_COMPATIBILITY.coreVersion, expectedAbi: KEET_COMPATIBILITY.abi }
      const core = this.options.createCore ? await this.options.createCore(coreOptions) : await KeetIntegrationCore.start(coreOptions); created = core
      if (this.#closing) throw new Error("Keet gateway is closing."); this.#core = core
      const readiness = await core.status()
      const pending = await core.listPendingDmRequests()
      const pendingMembers = new Set(pending.map((request) => request.memberId.trim()).filter(Boolean))
      const rooms = await core.listGroups(); const destinations = rooms.map((room) => destinationFromRoom(room, pendingMembers)).filter((value): value is Destination => !!value)
      if (new Set(destinations.map((value) => value.groupId)).size !== destinations.length) throw new Error("Keet destination snapshot contains duplicate rooms.")
      if (new Set(destinations.map((value) => value.groupName)).size !== destinations.length) throw new Error("Keet destination names are ambiguous.")
      if (this.#closing) throw new Error("Keet gateway is closing."); this.#workspaceRoot = config.workspaceRoot; this.#destinations = Object.freeze(destinations)
      if (config.webhookUrl) {
        const feed = new WebhookEventFeed({ stateDir: config.stateDir, url: new URL(config.webhookUrl), ...(config.webhookBearerToken ? { bearerToken: config.webhookBearerToken } : {}), core, identityId: readiness.identityId, ...(readiness.displayName ? { identityLabel: readiness.displayName } : {}), destinations: destinations as readonly WebhookDestination[], onFatal: (error) => { this.fail(error) } })
        createdFeed = feed; await feed.start(); if (this.#closing) throw new Error("Keet gateway is closing."); this.#eventFeed = feed
      }
      this.#server = createServer((request, response) => { void this.handle(request, response) })
      await new Promise<void>((resolve, reject) => { this.#server!.once("error", reject); this.#server!.listen(config.port, config.host, () => { this.#server!.off("error", reject); resolve() }) })
      if (this.#closing) throw new Error("Keet gateway is closing.")
    } catch (error) { const server = this.#server; const serverClosed = server && new Promise<void>((resolve) => server.close(() => resolve())); server?.closeAllConnections(); this.#server = undefined; const feed = this.#eventFeed ?? createdFeed; this.#eventFeed = undefined; await feed?.close().catch(() => undefined); await serverClosed; const core = this.#core ?? created; this.#core = undefined; this.#workspaceRoot = undefined; if (core) await core.close().catch(() => undefined); throw error }
  }
  async close(): Promise<void> { if (this.#closePromise) return await this.#closePromise; const closing = this.closeImpl(); this.#closePromise = closing; try { await closing } finally { if (this.#closePromise === closing) this.#closePromise = undefined } }
  private async closeImpl(): Promise<void> { this.#closing = true; this.#operationAbort.abort(); try { await this.#startPromise?.catch(() => undefined); const server = this.#server; const serverClosed = server && new Promise<void>((resolve) => server.close(() => resolve())); server?.closeAllConnections(); for (const { transport, server } of this.#sessions.values()) { await transport.close().catch(() => undefined); await server.close().catch(() => undefined) }; this.#sessions.clear(); this.#sendTails.clear(); this.#server = undefined; const feed = this.#eventFeed; this.#eventFeed = undefined; await feed?.close().catch(() => undefined); await serverClosed; const core = this.#core; this.#core = undefined; this.#workspaceRoot = undefined; if (core) await core.close() } finally { this.#closing = false } }
  private async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") { response.writeHead(404).end(); return }
    if (!authorized(request, this.options.config.token)) { response.writeHead(401, { "www-authenticate": "Bearer" }).end(); return }
    if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) { response.writeHead(405, { allow: "GET, POST, DELETE" }).end(); return }
    const sessionId = request.headers["mcp-session-id"]
    let session = typeof sessionId === "string" ? this.#sessions.get(sessionId) : undefined
    if (!session && sessionId) { response.writeHead(404).end(); return }
    if (!session) {
      if (request.method !== "POST") { response.writeHead(400).end(); return }
      if (this.#sessions.size >= MAX_SESSIONS) { response.writeHead(429).end(); return }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (id) => { this.#sessions.set(id, session!) }, onsessionclosed: (id) => { this.#sessions.delete(id) } })
      const server = this.mcpServer(); session = { transport, server }; transport.onclose = () => { const id = transport.sessionId; if (id) this.#sessions.delete(id) }; await server.connect(transport as never)
    }
    try { await session.transport.handleRequest(request, response) } catch { if (!response.headersSent) response.writeHead(500).end() }
  }
  private destination(name: string): Destination { const found = this.#destinations.filter((item) => item.groupName === name.trim()); if (found.length !== 1) throw new Error(found.length ? "Managed Destination name is ambiguous." : "destinationName is not an allowed Managed Destination."); return found[0]! }
  private async serialized<T>(id: string, operation: () => Promise<T>): Promise<T> { const previous = this.#sendTails.get(id) ?? Promise.resolve(); const result = previous.catch(() => undefined).then(operation); const tail = result.then(() => undefined, () => undefined); this.#sendTails.set(id, tail); try { return await result } finally { if (this.#sendTails.get(id) === tail) this.#sendTails.delete(id) } }
  private operationSignal(signal: AbortSignal): AbortSignal { return AbortSignal.any([signal, this.#operationAbort.signal]) }
  private mcpServer(): McpServer {
    const server = new McpServer({ name: "keet-mcpd", version: "0.1.0" })
    server.registerTool("list_destinations", { description: "List destinations admitted in this daemon's immutable startup snapshot.", inputSchema: {} }, async () => textResult({ destinations: this.#destinations.map(({ groupName, kind }) => ({ destinationName: groupName, kind })) }))
    server.registerTool("list_members", { description: "List current members of an admitted group or DM. Broadcast rosters are unavailable.", inputSchema: { destinationName: z.string() } }, async ({ destinationName }, extra) => { const signal = this.operationSignal(extra.signal); try { const destination = this.destination(destinationName); if (destination.kind === "broadcast") throw new Error("Managed Broadcast rosters are unavailable."); const members = await this.core().listMembers(destination.groupId, signal); return textResult({ members: members.slice(0, 128).map((member: KeetMember) => ({ displayName: normalizeName(member.displayName, "Unknown member") })) }) } catch (error) { return toolError(error, "Keet member roster is unavailable.", signal) } })
    server.registerTool("read_recent_messages", { description: "Read 1-50 latest text messages without changing read state.", inputSchema: { destinationName: z.string(), last: z.number().int().min(1).max(50) } }, async ({ destinationName, last }, extra) => { const signal = this.operationSignal(extra.signal); try { const destination = this.destination(destinationName); const messages = await this.core().readRecentMessages(destination.groupId, last, signal); return textResult({ messages: messages.slice(-last).map((message) => messageRecord(message, destination.kind)).filter(Boolean) }) } catch (error) { return toolError(error, "Keet recent messages are unavailable.", signal) } })
    server.registerTool("send_message", {
      description: "Send required text to an admitted destination, then optionally add one Unicode emoji reaction to a specified message in that Group or DM.",
      inputSchema: {
        destinationName: z.string(), text: z.string().min(1).max(MAX_TEXT),
        replyTo: z.object({ deviceId: z.string().min(1).max(MAX_NAME), seq: z.number().int().nonnegative() }).optional(),
        mentions: z.array(z.string().min(1).max(MAX_NAME)).min(1).max(128).optional(),
        reaction: z.object({ targetMessageId: z.object({ deviceId: z.string(), seq: z.number() }).strict(), emoji: z.string() }).strict().optional(),
      },
    }, async ({ destinationName, text, replyTo, mentions, reaction }, extra) => {
      const signal = this.operationSignal(extra.signal)
      try {
        const destination = this.destination(destinationName)
        const core = this.core()
        if (!text.trim()) throw new Error("text must be non-empty and at most 16,000 characters.")
        if (destination.kind !== "group" && replyTo) throw new Error(destination.kind === "dm" ? "DM sends do not support replyTo." : "Managed Broadcast sends do not support replyTo.")
        if (destination.kind !== "group" && mentions) throw new Error("native mentions are supported only for regular Managed Groups.")
        if (reaction) {
          if (destination.kind === "broadcast") throw new Error("Managed Broadcast sends do not support reactions.")
          if (!validMessageId(reaction.targetMessageId) || Array.from(reaction.targetMessageId.deviceId).length > MAX_NAME) throw new Error("reaction target is not a valid Keet message ID.")
          validateKeetReaction(reaction.emoji)
        }
        let ids: readonly string[] | undefined
        if (mentions) {
          const members = await core.listMembers(destination.groupId, signal)
          ids = mentions.map((name) => {
            const match = members.filter((member) => member.displayName === name.trim())
            if (match.length !== 1 || !match[0]!.memberId) throw new Error("each mention must name one current unique member.")
            return match[0]!.memberId
          })
        }
        return await this.serialized(destination.groupId, async () => {
          const messageId = await core.sendMessage(destination.groupId, text, replyTo, signal, ids)
          this.#eventFeed?.rememberOwnMessage(destination, messageId)
          if (!reaction) return textResult({ sent: true })
          try {
            await core.addReaction(destination.groupId, reaction.targetMessageId, reaction.emoji, signal)
            return textResult({ sent: true, reacted: true })
          } catch {
            return textResult({ sent: true, reacted: false, reactionError: "Keet reaction could not be added." })
          }
        })
      } catch (error) { return toolError(error, "Keet message was not sent.", signal) }
    })
    server.registerTool("send_file", { description: "Send one ordinary workspace-contained file up to 100 MiB. Supported images retain native image presentation and preview metadata.", inputSchema: { destinationName: z.string(), path: z.string().min(1).max(4096) } }, async ({ destinationName, path: input }, extra) => { const signal = this.operationSignal(extra.signal); try { const destination = this.destination(destinationName); const file = await prepareFile(this.workspaceRoot(), input, signal); if (signal.aborted) throw new Error("cancelled"); await this.serialized(destination.groupId, async () => { if (signal.aborted) throw new Error("cancelled"); await this.core().sendFile(destination.groupId, file, signal) }); return textResult({ sent: true }) } catch (error) { return toolError(error, "Keet file was not sent.", signal) } })
    return server
  }
  private core(): KeetCore { if (!this.#core) throw new Error("Keet gateway is not ready."); return this.#core }
  private workspaceRoot(): string { if (!this.#workspaceRoot) throw new Error("Keet file was not sent."); return this.#workspaceRoot }
  private fail(error: Error): void { if (this.#failure) return; this.#failure = error; this.options.onFatal?.(); if (!this.#closing) void this.close().catch(() => undefined) }
}

interface CheckedConfig extends GatewayConfig { readonly host: "127.0.0.1" | "::1"; readonly port: number }
async function validateConfig(config: GatewayConfig): Promise<CheckedConfig> {
  for (const [name, value] of Object.entries({ runtimeDir: config.runtimeDir, identityDir: config.identityDir, workspaceRoot: config.workspaceRoot, stateDir: config.stateDir })) if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`)
  if (config.token.length < 32) throw new Error("KEET_MCP_TOKEN must be at least 32 characters.")
  if (config.webhookBearerToken && !config.webhookUrl) throw new Error("KEET_WEBHOOK_BEARER_TOKEN requires KEET_WEBHOOK_URL.")
  if (config.webhookUrl) validateWebhookUrl(config.webhookUrl)
  const match = /^(127\.0\.0\.1|::1):(\d{1,5})$/.exec(config.listen); if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error("KEET_MCP_LISTEN must be a loopback host and port.")
  const runtime = await realpath(config.runtimeDir); const workspace = await realpath(config.workspaceRoot); await stat(path.join(runtime, "bare")); await stat(path.join(runtime, "core-worker.bundle")); assertSeparate([runtime, workspace, await existingOrAbsolute(config.identityDir), await existingOrAbsolute(config.stateDir)]); await mkdir(config.identityDir, { recursive: true, mode: 0o700 }); const identity = await realpath(config.identityDir); await mkdir(config.stateDir, { recursive: true, mode: 0o700 }); await chmod(config.stateDir, 0o700); const state = await realpath(config.stateDir)
  assertSeparate([runtime, identity, workspace, state])
  return { ...config, runtimeDir: runtime, identityDir: identity, workspaceRoot: workspace, stateDir: state, host: match[1] as "127.0.0.1" | "::1", port: Number(match[2]) }
}
function validateWebhookUrl(value: string): void { let url: URL; try { url = new URL(value) } catch { throw new Error("KEET_WEBHOOK_URL must be an HTTPS URL or loopback HTTP URL.") }; if (url.username || url.password || value.includes("#") || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) throw new Error("KEET_WEBHOOK_URL must be an HTTPS URL or loopback HTTP URL.") }
function authorized(request: import("node:http").IncomingMessage, token: string): boolean { const presented = request.headers.authorization; const expected = `Bearer ${token}`; return !!presented && presented.length === expected.length && timingSafeEqual(Buffer.from(presented), Buffer.from(expected)) }
async function existingOrAbsolute(input: string): Promise<string> { try { return await realpath(input) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(input); throw error } }
function assertSeparate(locations: readonly string[]): void { for (const [index, left] of locations.entries()) for (const right of locations.slice(index + 1)) if (left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)) throw new Error("runtime, identity, workspace, and state locations must not overlap.") }
async function prepareFile(root: string, input: string, signal: AbortSignal): Promise<PreparedKeetFile> {
  if (signal.aborted) throw new Error("cancelled")
  if (input.includes("\0") || /^[a-z][a-z\d+.-]*:/i.test(input) || input.includes("://")) throw new Error("path must be a workspace-contained file path.")
  const candidate = path.resolve(root, input); if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error("path must stay inside the workspace.")
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW)
    const target = await realpath(`/proc/self/fd/${handle.fd}`)
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("path must stay inside the workspace.")
    const info = await handle.stat(); if (!info.isFile() || info.size < 1 || info.size > MAX_FILE_BYTES) throw new Error("workspace file is missing or exceeds the 100 MiB limit.")
    if (signal.aborted) throw new Error("cancelled")
    const bytes = new Uint8Array(await handle.readFile()); const imageType = mediaType(bytes)
    const name = path.basename(target); const inferredType = lookupMediaType(name) || "application/octet-stream"
    if (!imageType) {
      if (inferredType === "image/png" || inferredType === "image/jpeg" || inferredType === "image/webp" || inferredType === "image/gif") throw new Error("workspace image format is unsupported or corrupt.")
      return { bytes, mediaType: inferredType, name }
    }
    if (signal.aborted) throw new Error("cancelled")
    const sharp = (await import("sharp")).default; const image = sharp(Buffer.from(bytes), { limitInputPixels: MAX_PIXELS, failOn: "error" }); const metadata = await image.metadata(); const format = metadata.format === "jpg" ? "jpeg" : metadata.format
    if (!imageTypes.has(imageType) || format !== imageType.slice(6) || !metadata.width || !metadata.height || metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION || metadata.width * metadata.height > MAX_PIXELS) throw new Error("workspace image format is unsupported or corrupt.")
    if (signal.aborted) throw new Error("cancelled")
    const previewResult = await image.clone().resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true }).webp({ quality: 70 }).toBuffer({ resolveWithObject: true })
    if (!previewResult.info.width || !previewResult.info.height || previewResult.data.byteLength > 512 * 1024) throw new Error("workspace image format is unsupported or corrupt.")
    return { bytes, mediaType: imageType, width: metadata.width, height: metadata.height, name, preview: { bytes: new Uint8Array(previewResult.data), mediaType: "image/webp", width: previewResult.info.width, height: previewResult.info.height } }
  } catch (error) { if (error instanceof Error && ["cancelled", "path must stay inside the workspace.", "workspace file is missing or exceeds the 100 MiB limit.", "workspace image format is unsupported or corrupt."].includes(error.message)) throw error; throw new Error("workspace file could not be read.") } finally { await handle?.close().catch(() => undefined) }
}
