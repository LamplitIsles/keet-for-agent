import { chmod, lstat, mkdir, rm } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import type { KeetHeapProfile } from "./core-contract.js"

const SOCKET_NAME = "dsh-keet-heap.sock"
const MAX_REQUEST_CHARS = 64
const REQUEST_TIMEOUT_MS = 5_000
const MAX_NODE_TYPES = 64
const MAX_TYPE_CHARS = 64

/** The owner-only local endpoint used by the systemd memory watcher. */
export function keetHeapProfileSocketPath(dshHome: string): string {
  return path.join(path.resolve(dshHome), "run", SOCKET_NAME)
}

/**
 * Start a same-user Unix socket for one fixed diagnostic request. The socket
 * never returns V8 heap content: only Core's bounded structural accounting.
 */
export async function startKeetHeapProfileSocket(options: {
  readonly capture: () => Promise<KeetHeapProfile>
  readonly dshHome?: string
}): Promise<(() => Promise<void>) | undefined> {
  const dshHome = options.dshHome ?? process.env.DSH_HOME
  if (!dshHome) return undefined

  const runDirectory = path.join(path.resolve(dshHome), "run")
  await mkdir(runDirectory, { recursive: true, mode: 0o700 })
  await chmod(runDirectory, 0o700)
  const socketPath = keetHeapProfileSocketPath(dshHome)
  await removeSocket(socketPath)

  let closing = false
  const connections = new Set<net.Socket>()
  // The watcher half-closes after its one request; retain our write side until
  // the snapshot summary has completed and we have sent the response.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    connections.add(socket)
    socket.once("close", () => { connections.delete(socket) })
    socket.setEncoding("utf8")
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => { reply(socket, unavailableResponse()) })
    let request = ""
    let started = false
    socket.on("data", (chunk: string | Buffer) => {
      if (started) return
      request += chunk.toString()
      if (request.length > MAX_REQUEST_CHARS) { reply(socket, unavailableResponse()); return }
      if (!request.endsWith("\n")) return
      started = true
      socket.setTimeout(0)
      if (request !== "capture\n" || closing) { reply(socket, unavailableResponse()); return }
      void options.capture()
        .then((profile) => reply(socket, profileResponse(profile)))
        .catch(() => { reply(socket, unavailableResponse()) })
    })
    socket.on("error", () => undefined)
  })
  server.maxConnections = 4
  server.on("error", () => undefined)
  try {
    await listen(server, socketPath)
    await chmod(socketPath, 0o600)
  } catch (error) {
    server.close()
    await removeSocket(socketPath).catch(() => undefined)
    throw error
  }

  return async () => {
    closing = true
    for (const socket of connections) socket.destroy()
    if (server.listening) await close(server)
    await removeSocket(socketPath)
  }
}

function reply(socket: net.Socket, response: string): void {
  if (socket.destroyed || !socket.writable) return
  try { socket.end(response) } catch { socket.destroy() }
}

function unavailableResponse(): string {
  return "{\"ok\":false,\"error\":\"profile unavailable\"}\n"
}

function profileResponse(value: KeetHeapProfile): string {
  const profile = normalizeProfile(value)
  return profile ? `${JSON.stringify({ ok: true, value: profile })}\n` : unavailableResponse()
}

function normalizeProfile(value: KeetHeapProfile): KeetHeapProfile | undefined {
  if (!value || typeof value !== "object" || !safeInteger(value.nodeCount) || !safeInteger(value.selfSizeBytes)
    || !Array.isArray(value.nodeTypes) || value.nodeTypes.length > MAX_NODE_TYPES) return undefined
  const nodeTypes: Array<{ readonly type: string; readonly nodeCount: number; readonly selfSizeBytes: number }> = []
  for (const entry of value.nodeTypes) {
    if (!entry || typeof entry !== "object" || typeof entry.type !== "string" || !entry.type || entry.type.length > MAX_TYPE_CHARS
      || !safeInteger(entry.nodeCount) || !safeInteger(entry.selfSizeBytes)) return undefined
    nodeTypes.push(Object.freeze({ type: entry.type, nodeCount: entry.nodeCount, selfSizeBytes: entry.selfSizeBytes }))
  }
  return Object.freeze({ nodeCount: value.nodeCount, selfSizeBytes: value.selfSizeBytes, nodeTypes: Object.freeze(nodeTypes) })
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

async function removeSocket(socketPath: string): Promise<void> {
  try {
    const entry = await lstat(socketPath)
    if (!entry.isSocket()) throw new Error("Keet heap profile socket path is unavailable")
    await rm(socketPath, { force: true })
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => finish(() => reject(error))
    const onListening = () => finish(resolve)
    const finish = (settle: () => void) => {
      server.off("error", onError)
      server.off("listening", onListening)
      settle()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(socketPath)
  })
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
  })
}
