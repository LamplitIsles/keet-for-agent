import { afterEach, describe, expect, it, vi } from "vitest"
import { once } from "node:events"
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import WebSocket, { type RawData } from "ws"
import { configurationFromEnvironment, KeetMcpGateway, type GatewayConfig } from "../packages/keet-mcp/src/index.js"
import type { KeetCore, KeetMessage, KeetSubscription } from "@lamplitisles/keet-integration-core"

const PNG_1X1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JgP8AAAAASUVORK5CYII=", "base64"))
const gateways: KeetMcpGateway[] = []
let nextPort = 18765
afterEach(async () => { await Promise.all(gateways.splice(0).map((gateway) => gateway.close())) })

function fakeCore() {
  const events: string[] = []; let closed = false; let readState = 0; const watchers = new Map<string, (message: KeetMessage) => void>(); const terminateWatchers = new Map<string, (reason: "closed" | "connection-failed") => void>()
  const watchMessages = vi.fn((groupId: string, handler: (message: KeetMessage) => void) => {
    let subscriptionClosed = false; const terminated = new Set<(reason: "closed" | "connection-failed") => void>()
    watchers.set(groupId, handler)
    const finish = (reason: "closed" | "connection-failed") => { if (subscriptionClosed) return; subscriptionClosed = true; watchers.delete(groupId); terminateWatchers.delete(groupId); for (const listener of terminated) listener(reason) }
    terminateWatchers.set(groupId, finish)
    return {
      get closed() { return subscriptionClosed },
      close: async () => { finish("closed") },
      onTerminate: (listener: (reason: "closed" | "connection-failed") => void) => { terminated.add(listener); return () => { terminated.delete(listener) } },
    } as KeetSubscription
  })
  const core = {
    status: vi.fn(async () => ({ state: "ready" as const, appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: true, identityId: "bot" })),
    listPendingDmRequests: vi.fn(async () => []),
    listGroups: vi.fn(async () => [
      { groupId: "group", roomType: "Default" as const, title: "Group" },
      { groupId: "dm", roomType: "DirectMessage" as const, dmMemberId: "peer", title: "Peer DM" },
      { groupId: "broadcast", roomType: "Broadcast" as const, title: "News" },
    ]),
    listMembers: vi.fn(async () => [{ memberId: "alice", displayName: "Alice" }]),
    readRecentMessages: vi.fn(async () => { readState += 1; return [{ groupId: "group", messageId: { deviceId: "device", seq: 1 }, senderId: "alice", senderLabel: "Alice", timestamp: 1, text: "hello" }] }),
    sendMessage: vi.fn(async (_id: string, text: string) => { events.push(`text:${text}`); return { deviceId: "bot", seq: 2 } }),
    sendImage: vi.fn(async () => { events.push("image") }), close: vi.fn(async () => { closed = true }),
    watchMessages,
  } as unknown as KeetCore
  return { core, events, watchMessages, emit(groupId: string, message: KeetMessage) { watchers.get(groupId)?.(message) }, terminateWatcher(groupId: string) { terminateWatchers.get(groupId)?.("connection-failed") }, get closed() { return closed }, get readState() { return readState } }
}
async function start(core: KeetCore, overrides: Partial<GatewayConfig> = {}): Promise<{ gateway: KeetMcpGateway; root: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), "keet-mcp-test-")); const runtime = join(root, "runtime"); const workspace = join(root, "workspace"); const identity = join(root, "identity"); const state = join(root, "state")
  await Promise.all([mkdir(runtime), mkdir(workspace)]); await Promise.all([writeFile(join(runtime, "bare"), "fixture"), writeFile(join(runtime, "core-worker.bundle"), "fixture")])
  const token = "t".repeat(32); const config: GatewayConfig = { runtimeDir: runtime, identityDir: identity, workspaceRoot: workspace, stateDir: state, eventRetention: 10_000, listen: `127.0.0.1:${nextPort++}`, token, ...overrides }
  const gateway = new KeetMcpGateway({ config, createCore: async () => core }); gateways.push(gateway); await gateway.start(); return { gateway, root, token }
}
function json(result: unknown): unknown { const value = result as { content?: Array<{ type: string; text?: string }> }; const first = value.content?.find((item) => item.type === "text"); return JSON.parse(first?.text ?? "{}") }
function cflAddress(gateway: KeetMcpGateway): string { return gateway.address!.replace(/^http/, "ws").replace(/\/mcp$/, "/cfl") }
async function connectCfl(address: string, token?: string): Promise<WebSocket> {
  const socket = new WebSocket(address, token ? { headers: { authorization: `Bearer ${token}` } } : undefined)
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
  return socket
}
function cflFrame(raw: RawData): unknown { if (typeof raw === "string") return JSON.parse(raw); if (Array.isArray(raw)) return JSON.parse(Buffer.concat(raw).toString("utf8")); return JSON.parse(raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") : raw.toString("utf8")) }
function nextCflFrame(socket: WebSocket): Promise<unknown> { return new Promise((resolve, reject) => { socket.once("message", (raw) => { try { resolve(cflFrame(raw)) } catch (error) { reject(error) } }) }) }
function cflFrameStream(socket: WebSocket): { next(): Promise<unknown> } {
  const frames: unknown[] = []; const waiting: Array<{ resolve: (frame: unknown) => void; reject: (error: unknown) => void }> = []
  socket.on("message", (raw) => { try { const frame = cflFrame(raw); const next = waiting.shift(); if (next) next.resolve(frame); else frames.push(frame) } catch (error) { waiting.shift()?.reject(error) } })
  return { next: async () => frames.shift() ?? await new Promise<unknown>((resolve, reject) => { waiting.push({ resolve, reject }) }) }
}
function socketClosed(socket: WebSocket): Promise<number> { return new Promise((resolve) => { socket.once("close", (code) => { resolve(code) }) }) }
function closeCfl(socket: WebSocket): Promise<void> { return new Promise((resolve) => { if (socket.readyState === WebSocket.CLOSED) { resolve(); return }; socket.once("close", () => { resolve() }); socket.close(1000) }) }
function clientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text); if (payload.length > 125) throw new Error("test WebSocket frame is too large")
  const mask = Buffer.from([1, 2, 3, 4]); const frame = Buffer.allocUnsafe(6 + payload.length); frame[0] = 0x81; frame[1] = 0x80 | payload.length; mask.copy(frame, 2)
  for (const [index, byte] of payload.entries()) frame[6 + index] = byte ^ mask[index % mask.length]!
  return frame
}
async function connectStalledCfl(address: string, token: string): Promise<Socket> {
  const endpoint = new URL(address); const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) }); await once(socket, "connect")
  socket.write(`GET ${endpoint.pathname} HTTP/1.1\r\nHost: ${endpoint.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`)
  const [response] = await once(socket, "data") as [Buffer]; if (!response.toString("latin1").startsWith("HTTP/1.1 101 ")) { socket.destroy(); throw new Error("CFL test WebSocket upgrade failed") }
  socket.pause(); socket.write(clientTextFrame(JSON.stringify({ type: "hello" }))); return socket
}
function rawSocketClosed(socket: Socket): Promise<void> { return new Promise((resolve) => { socket.once("close", () => { resolve() }) }) }
function pause(milliseconds = 25): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
async function startPendingFailure(core: KeetCore, expected = "raw identity"): Promise<{ gateway: KeetMcpGateway; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "keet-mcp-test-")); const runtime = join(root, "runtime"); const workspace = join(root, "workspace")
  await Promise.all([mkdir(runtime), mkdir(workspace)]); await Promise.all([writeFile(join(runtime, "bare"), "fixture"), writeFile(join(runtime, "core-worker.bundle"), "fixture")])
  const gateway = new KeetMcpGateway({ config: { runtimeDir: runtime, identityDir: join(root, "identity"), workspaceRoot: workspace, stateDir: join(root, "state"), eventRetention: 10_000, listen: "127.0.0.1:18767", token: "t".repeat(32) }, createCore: async () => core })
  await expect(gateway.start()).rejects.toThrow(expected); return { gateway, root }
}

describe("Keet MCP gateway", () => {
  it("fails configuration or Core ownership before exposing a listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "keet-mcp-test-")); const runtime = join(root, "runtime"); const workspace = join(root, "workspace")
    try {
      await Promise.all([mkdir(runtime), mkdir(workspace)]); await Promise.all([writeFile(join(runtime, "bare"), "fixture"), writeFile(join(runtime, "core-worker.bundle"), "fixture")])
      const config: GatewayConfig = { runtimeDir: runtime, identityDir: join(root, "identity"), workspaceRoot: workspace, stateDir: join(root, "state"), eventRetention: 10_000, listen: "0.0.0.0:9999", token: "t".repeat(32) }
      const invalid = new KeetMcpGateway({ config, createCore: async () => fakeCore().core }); await expect(invalid.start()).rejects.toThrow("loopback"); expect(invalid.address).toBeUndefined()
      const locked = new KeetMcpGateway({ config: { ...config, listen: "127.0.0.1:18766" }, createCore: async () => { throw new Error("identity is already owned") } }); await expect(locked.start()).rejects.toThrow("identity is already owned"); expect(locked.address).toBeUndefined()
      const overlapping = new KeetMcpGateway({ config: { ...config, stateDir: workspace, listen: "127.0.0.1:18770" }, createCore: async () => fakeCore().core }); await expect(overlapping.start()).rejects.toThrow("must not overlap")
      expect(() => configurationFromEnvironment({ KEET_MCP_RUNTIME_DIR: runtime, KEET_MCP_IDENTITY_DIR: join(root, "identity"), KEET_MCP_WORKSPACE_ROOT: workspace, KEET_MCP_LISTEN: "127.0.0.1:8765", KEET_MCP_TOKEN: "t".repeat(32) })).toThrow("KEET_MCP_STATE_DIR")
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("authenticates a real MCP client and exposes the five-tool snapshot", async () => {
    const fake = fakeCore(); const { gateway, root, token } = await start(fake.core)
    try {
      const denied = await fetch(gateway.address!, { method: "POST" }); expect(denied.status).toBe(401)
      const deniedPut = await fetch(gateway.address!, { method: "PUT" }); expect(deniedPut.status).toBe(401); expect(deniedPut.headers.get("www-authenticate")).toBe("Bearer")
      expect((await fetch(gateway.address!, { method: "PUT", headers: { authorization: `Bearer ${token}` } })).status).toBe(405)
      const client = new Client({ name: "test", version: "1" }); const transport = new StreamableHTTPClientTransport(new URL(gateway.address!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }); await client.connect(transport as never)
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["keet_list_groups", "keet_list_members", "keet_read_recent_messages", "keet_send_image", "keet_send_message"])
      expect(json(await client.callTool({ name: "keet_list_groups", arguments: {} }))).toEqual({ groups: [{ groupName: "Group", kind: "group" }, { groupName: "Peer DM", kind: "dm" }, { groupName: "News", kind: "broadcast" }] })
      expect(json(await client.callTool({ name: "keet_list_members", arguments: { groupName: "Group" } }))).toEqual({ members: [{ displayName: "Alice" }] })
      expect(json(await client.callTool({ name: "keet_read_recent_messages", arguments: { groupName: "Peer DM", last: 1 } }))).toEqual({ messages: [{ senderLabel: "Alice", timestamp: 1, text: "hello" }] })
      expect(json(await client.callTool({ name: "keet_read_recent_messages", arguments: { groupName: "Group", last: 50 } }))).toMatchObject({ messages: [{ text: "hello" }] }); expect(fake.readState).toBe(2)
      expect((await client.callTool({ name: "keet_read_recent_messages", arguments: { groupName: "Group", last: 51 } })).isError).toBe(true)
      const unknown = await client.callTool({ name: "keet_list_members", arguments: { groupName: "Unknown" } }); expect(unknown.isError).toBe(true); expect(JSON.stringify(json(unknown))).toContain("not an allowed")
      expect(gateway.sessionCount).toBe(1); const terminated = await fetch(gateway.address!, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": transport.sessionId! } }); expect(terminated.status).toBe(200); await new Promise((resolve) => setTimeout(resolve)); expect(gateway.sessionCount).toBe(0); await client.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("streams durable incoming text to independent authenticated CFL clients", async () => {
    const fake = fakeCore(); const { gateway, root, token } = await start(fake.core)
    try {
      await expect(connectCfl(cflAddress(gateway))).rejects.toThrow()
      const first = await connectCfl(cflAddress(gateway), token); const second = await connectCfl(cflAddress(gateway), token)
      const firstReady = nextCflFrame(first); first.send(JSON.stringify({ type: "hello" }))
      const secondReady = nextCflFrame(second); second.send(JSON.stringify({ type: "hello", afterSequence: 0 }))
      const destinations = [{ groupName: "Group", kind: "group" }, { groupName: "Peer DM", kind: "dm" }, { groupName: "News", kind: "broadcast" }]
      await expect(firstReady).resolves.toEqual({ type: "ready", retained: null, destinations })
      await expect(secondReady).resolves.toEqual({ type: "ready", retained: null, destinations })
      const firstEvent = nextCflFrame(first); const secondEvent = nextCflFrame(second)
      fake.emit("group", { groupId: "group", messageId: { deviceId: "alice-device", seq: 5 }, senderId: "alice", senderLabel: "Alice", timestamp: 123, text: "hello", replyTo: { deviceId: "thread", seq: 3 } })
      const expected = { type: "message", sequence: 1, messageId: { deviceId: "alice-device", seq: 5 }, timestamp: 123, destination: { groupName: "Group", kind: "group" }, senderLabel: "Alice", text: "hello", replyTo: { deviceId: "thread", seq: 3 } }
      await expect(firstEvent).resolves.toEqual(expected); await expect(secondEvent).resolves.toEqual(expected)
      const firstDm = nextCflFrame(first); const secondDm = nextCflFrame(second)
      fake.emit("dm", { groupId: "dm", messageId: { deviceId: "peer-device", seq: 6 }, senderId: "peer", senderLabel: "Peer", timestamp: 124, text: "direct message" })
      const dmExpected = { type: "message", sequence: 2, messageId: { deviceId: "peer-device", seq: 6 }, timestamp: 124, destination: { groupName: "Peer DM", kind: "dm" }, senderLabel: "Peer", text: "direct message" }
      await expect(firstDm).resolves.toEqual(dmExpected); await expect(secondDm).resolves.toEqual(dmExpected); expect(fake.readState).toBe(0)
      const firstCaption = nextCflFrame(first); const secondCaption = nextCflFrame(second)
      fake.emit("broadcast", { groupId: "broadcast", messageId: { deviceId: "news-device", seq: 7 }, senderId: "author", senderLabel: "Author", timestamp: 125, text: "caption only", images: [{ file: {}, mediaType: "image/png" }] })
      const captionExpected = { type: "message", sequence: 3, messageId: { deviceId: "news-device", seq: 7 }, timestamp: 125, destination: { groupName: "News", kind: "broadcast" }, senderLabel: "Author", text: "caption only" }
      await expect(firstCaption).resolves.toEqual(captionExpected); await expect(secondCaption).resolves.toEqual(captionExpected)
      let unexpected = false; first.once("message", () => { unexpected = true })
      fake.emit("group", { groupId: "group", messageId: { deviceId: "bot-device", seq: 6 }, senderId: "bot", senderLabel: "Bot", timestamp: 124, text: "self" })
      fake.emit("group", { groupId: "group", messageId: { deviceId: "alice-device", seq: 7 }, senderId: "alice", senderLabel: "Alice", timestamp: 125, text: "", images: [] })
      await pause(); expect(unexpected).toBe(false)
      const malformed = await connectCfl(cflAddress(gateway), token); const malformedClosed = socketClosed(malformed); malformed.send("[]"); await expect(malformedClosed).resolves.toBe(1008)
      const postHello = await connectCfl(cflAddress(gateway), token); const postHelloReady = nextCflFrame(postHello); postHello.send(JSON.stringify({ type: "hello" })); await postHelloReady; const postHelloClosed = socketClosed(postHello); postHello.send(JSON.stringify({ type: "hello" })); await expect(postHelloClosed).resolves.toBe(1008)
      await Promise.all([closeCfl(first), closeCfl(second)])
      expect(fake.watchMessages).toHaveBeenCalledTimes(3)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("replays the retained journal and explicitly rejects an unresolvable checkpoint", async () => {
    const firstCore = fakeCore(); const { gateway, root, token } = await start(firstCore.core, { eventRetention: 2 })
    try {
      const live = await connectCfl(cflAddress(gateway), token); const ready = nextCflFrame(live); live.send(JSON.stringify({ type: "hello" })); await ready
      for (const sequence of [1, 2, 3]) {
        const event = nextCflFrame(live)
        firstCore.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: sequence }, senderId: "alice", senderLabel: "Alice", timestamp: sequence, text: `message ${sequence}` })
        await event
      }
      await closeCfl(live); await gateway.close()
      const secondCore = fakeCore(); const restarted = new KeetMcpGateway({ config: gateway.options.config, createCore: async () => secondCore.core }); gateways.push(restarted); await restarted.start()
      const replay = await connectCfl(cflAddress(restarted), token); const replayFrames = cflFrameStream(replay); replay.send(JSON.stringify({ type: "hello", afterSequence: 2 }))
      await expect(replayFrames.next()).resolves.toMatchObject({ type: "ready", retained: { first: 2, last: 3 } })
      await expect(replayFrames.next()).resolves.toMatchObject({ type: "message", sequence: 3, text: "message 3" })
      const omitted = await connectCfl(cflAddress(restarted), token); const omittedFrames = cflFrameStream(omitted); omitted.send(JSON.stringify({ type: "hello" }))
      await expect(omittedFrames.next()).resolves.toMatchObject({ type: "ready", retained: { first: 2, last: 3 } })
      await expect(omittedFrames.next()).resolves.toMatchObject({ type: "message", sequence: 2, text: "message 2" }); await expect(omittedFrames.next()).resolves.toMatchObject({ type: "message", sequence: 3, text: "message 3" })
      const duplicate = await connectCfl(cflAddress(restarted), token); const duplicateFrames = cflFrameStream(duplicate); duplicate.send(JSON.stringify({ type: "hello", afterSequence: 2 }))
      await expect(duplicateFrames.next()).resolves.toMatchObject({ type: "ready", retained: { first: 2, last: 3 } }); await expect(duplicateFrames.next()).resolves.toMatchObject({ type: "message", sequence: 3, text: "message 3" })
      const racing = await connectCfl(cflAddress(restarted), token); const racingFrames = cflFrameStream(racing); racing.send(JSON.stringify({ type: "hello", afterSequence: 3 })); secondCore.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: 4 }, senderId: "alice", senderLabel: "Alice", timestamp: 4, text: "message 4" })
      await expect(racingFrames.next()).resolves.toMatchObject({ type: "ready" }); await expect(racingFrames.next()).resolves.toMatchObject({ type: "message", sequence: 4, text: "message 4" })
      const stale = await connectCfl(cflAddress(restarted), token); const staleFrame = nextCflFrame(stale); const staleClosed = socketClosed(stale); stale.send(JSON.stringify({ type: "hello", afterSequence: 0 }))
      await expect(staleFrame).resolves.toEqual({ type: "resync_required", retained: { first: 3, last: 4 } }); await expect(staleClosed).resolves.toBe(1000)
      await Promise.all([closeCfl(replay), closeCfl(omitted), closeCfl(duplicate), closeCfl(racing)]); await restarted.close()
      const reducedCore = fakeCore(); const reduced = new KeetMcpGateway({ config: { ...gateway.options.config, eventRetention: 1 }, createCore: async () => reducedCore.core }); gateways.push(reduced); await reduced.start()
      expect((await readFile(join(root, "state", "cfl-events.ndjson"), "utf8")).trim()).toBe(JSON.stringify({ type: "message", sequence: 4, messageId: { deviceId: "alice", seq: 4 }, timestamp: 4, destination: { groupName: "Group", kind: "group" }, senderLabel: "Alice", text: "message 4" }))
      const reducedClient = await connectCfl(cflAddress(reduced), token); const reducedFrames = cflFrameStream(reducedClient); reducedClient.send(JSON.stringify({ type: "hello" })); await expect(reducedFrames.next()).resolves.toMatchObject({ type: "ready", retained: { first: 4, last: 4 } }); await expect(reducedFrames.next()).resolves.toMatchObject({ type: "message", sequence: 4, text: "message 4" }); await closeCfl(reducedClient); await reduced.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("recovers a partial terminal record but fails closed for complete journal corruption", async () => {
    const firstCore = fakeCore(); const { gateway, root, token } = await start(firstCore.core)
    try {
      const live = await connectCfl(cflAddress(gateway), token); const ready = nextCflFrame(live); live.send(JSON.stringify({ type: "hello" })); await ready
      const event = nextCflFrame(live); firstCore.emit("broadcast", { groupId: "broadcast", messageId: { deviceId: "news", seq: 1 }, senderId: "author", senderLabel: "Author", timestamp: 1, text: "published" }); await event
      await closeCfl(live); await gateway.close(); await writeFile(join(root, "state", "cfl-events.ndjson"), "{\"type\":", { flag: "a" }); await writeFile(join(root, "state", "cfl-events.ndjson.replacement"), "uncommitted replacement")
      const restartedCore = fakeCore(); const restarted = new KeetMcpGateway({ config: gateway.options.config, createCore: async () => restartedCore.core }); gateways.push(restarted); await restarted.start()
      await expect(readFile(join(root, "state", "cfl-events.ndjson.replacement"))).rejects.toMatchObject({ code: "ENOENT" })
      const replay = await connectCfl(cflAddress(restarted), token); const frames = cflFrameStream(replay); replay.send(JSON.stringify({ type: "hello" })); await expect(frames.next()).resolves.toMatchObject({ type: "ready", retained: { first: 1, last: 1 } }); await expect(frames.next()).resolves.toMatchObject({ type: "message", text: "published" }); await closeCfl(replay); await restarted.close()
      await writeFile(join(root, "state", "cfl-events.ndjson"), "{}\n")
      const corrupt = new KeetMcpGateway({ config: gateway.options.config, createCore: async () => fakeCore().core }); await expect(corrupt.start()).rejects.toThrow("invalid sequence")
      await writeFile(join(root, "state", "cfl-events.ndjson"), `${JSON.stringify({ type: "message", sequence: 1, messageId: { deviceId: "news", seq: 1 }, timestamp: 1, destination: { groupName: "News", kind: "broadcast" }, senderLabel: "Author", text: "published", credentials: "must not load" })}\n`)
      const privateRecord = new KeetMcpGateway({ config: gateway.options.config, createCore: async () => fakeCore().core }); await expect(privateRecord.start()).rejects.toThrow("invalid sequence")
      await writeFile(join(root, "state", "cfl-events.ndjson"), `${JSON.stringify({ type: "message", sequence: 1, messageId: { deviceId: "news", seq: 1 }, timestamp: 1, destination: { groupName: "", kind: "broadcast" }, senderLabel: "", text: "published" })}\n`)
      const emptyRecord = new KeetMcpGateway({ config: gateway.options.config, createCore: async () => fakeCore().core }); await expect(emptyRecord.start()).rejects.toThrow("invalid sequence")
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("fails the gateway closed when a Core message watcher terminates", async () => {
    const fake = fakeCore(); const { gateway, root, token } = await start(fake.core)
    try {
      const endpoint = gateway.address!; fake.terminateWatcher("group"); await pause()
      expect(fake.closed).toBe(true); expect(gateway.address).toBeUndefined(); await expect(fetch(endpoint, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("fails the gateway closed when its journal cannot accept an event", async () => {
    const fake = fakeCore(); const { gateway, root, token } = await start(fake.core)
    try {
      const endpoint = cflAddress(gateway); const client = await connectCfl(endpoint, token); const ready = nextCflFrame(client); client.send(JSON.stringify({ type: "hello" })); await ready; let messages = 0; client.on("message", () => { messages += 1 })
      await mkdir(join(root, "state", "cfl-events.ndjson")); fake.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: 1 }, senderId: "alice", senderLabel: "Alice", timestamp: 1, text: "journal failure" })
      await pause(100); expect(messages).toBe(0); expect(fake.closed).toBe(true); expect(gateway.address).toBeUndefined(); await expect(fetch(endpoint, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("fails the gateway closed instead of growing an unbounded persistence queue", async () => {
    const fake = fakeCore(); const { gateway, root } = await start(fake.core)
    try {
      for (let sequence = 1; sequence <= 1025; sequence += 1) fake.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: sequence }, senderId: "alice", senderLabel: "Alice", timestamp: sequence, text: "queued" })
      await pause(100); expect(fake.closed).toBe(true); expect(gateway.address).toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("terminates a stalled CFL socket without delaying a healthy consumer", async () => {
    const fake = fakeCore(); const { gateway, root, token } = await start(fake.core); const stalled = await connectStalledCfl(cflAddress(gateway), token)
    try {
      const healthy = await connectCfl(cflAddress(gateway), token); const frames = cflFrameStream(healthy); healthy.send(JSON.stringify({ type: "hello" })); await expect(frames.next()).resolves.toMatchObject({ type: "ready" })
      const text = "x".repeat(16_000); const started = performance.now()
      for (let sequence = 1; sequence <= 256; sequence += 1) fake.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: sequence }, senderId: "alice", senderLabel: "Alice", timestamp: sequence, text })
      expect(performance.now() - started).toBeLessThan(250)
      for (let sequence = 1; sequence <= 256; sequence += 1) await expect(frames.next()).resolves.toMatchObject({ type: "message", sequence })
      const closed = rawSocketClosed(stalled); stalled.resume(); await expect(Promise.race([closed.then(() => "closed"), pause(1_000).then(() => "timed out")])).resolves.toBe("closed")
      await closeCfl(healthy)
    } finally { stalled.destroy(); await rm(root, { recursive: true, force: true }) }
  }, 10_000)

  it("bounds pre-hello CFL connections", async () => {
    const fake = fakeCore(); const { gateway, root, token } = await start(fake.core)
    try {
      const clients = await Promise.all(Array.from({ length: 64 }, async () => await connectCfl(cflAddress(gateway), token)))
      await expect(connectCfl(cflAddress(gateway), token)).rejects.toThrow()
      await Promise.all(clients.map(closeCfl))
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("filters pending DMs, fails closed on pending lookup, and keeps an existing start usable", async () => {
    const fake = fakeCore(); fake.core.listPendingDmRequests = vi.fn(async () => [{ memberId: " peer " }])
    const { gateway, root, token } = await start(fake.core)
    try {
      expect(gateway.destinations.map((destination) => destination.groupName)).not.toContain("Peer DM")
      await expect(gateway.start()).rejects.toThrow("already started")
      const client = new Client({ name: "test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(gateway.address!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as never)
      expect(json(await client.callTool({ name: "keet_list_groups", arguments: {} }))).toEqual({ groups: [{ groupName: "Group", kind: "group" }, { groupName: "News", kind: "broadcast" }] }); await client.close()
    } finally { await rm(root, { recursive: true, force: true }) }
    const broken = fakeCore(); broken.core.listPendingDmRequests = vi.fn(async () => { throw new Error("raw identity /secret") }); const failed = await startPendingFailure(broken.core); expect(failed.gateway.address).toBeUndefined(); expect(broken.closed).toBe(true); await rm(failed.root, { recursive: true, force: true })
  })

  it("fails closed for duplicate normalized destination names", async () => {
    const fake = fakeCore(); fake.core.listGroups = vi.fn(async () => [{ groupId: "one", roomType: "Default" as const, title: " Same\nName " }, { groupId: "two", roomType: "Broadcast" as const, title: "Same Name" }])
    const failed = await startPendingFailure(fake.core, "ambiguous"); expect(failed.gateway.address).toBeUndefined(); expect(fake.closed).toBe(true); await rm(failed.root, { recursive: true, force: true })
  })

  it("maps Core errors safely and enforces text-tool restrictions before native mutation", async () => {
    const fake = fakeCore(); const { gateway, root, token } = await start(fake.core)
    try {
      const client = new Client({ name: "test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(gateway.address!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as never)
      for (const args of [{ replyTo: { deviceId: "x", seq: 1 } }, { mentions: ["Alice"] }]) { const result = await client.callTool({ name: "keet_send_message", arguments: { groupName: "News", text: "x", ...args } }); expect(result.isError).toBe(true) }
      expect(json(await client.callTool({ name: "keet_send_message", arguments: { groupName: "Group", text: "reply", replyTo: { deviceId: "device", seq: 1 }, mentions: ["Alice"] } }))).toEqual({ sent: true })
      let release!: () => void; let sends = 0; fake.core.sendMessage = vi.fn(async (_group, text) => { fake.events.push(`start:${text}`); if (++sends === 1) await new Promise<void>((resolve) => { release = resolve }); fake.events.push(`done:${text}`); return { deviceId: "bot", seq: sends } })
      const first = client.callTool({ name: "keet_send_message", arguments: { groupName: "Group", text: "one" } }); while (!release) await new Promise((resolve) => setTimeout(resolve)); const second = client.callTool({ name: "keet_send_message", arguments: { groupName: "Group", text: "two" } }); await new Promise((resolve) => setTimeout(resolve)); expect(fake.events.slice(-1)).toEqual(["start:one"]); release(); await Promise.all([first, second]); expect(fake.events.slice(-4)).toEqual(["start:one", "done:one", "start:two", "done:two"])
      fake.core.readRecentMessages = vi.fn(async () => { throw new Error("/runtime/secret /identity/raw group-id") })
      const failed = await client.callTool({ name: "keet_read_recent_messages", arguments: { groupName: "Group", last: 50 } }); expect(JSON.stringify(json(failed))).toContain("Keet recent messages are unavailable."); expect(JSON.stringify(json(failed))).not.toContain("secret")
      expect((await client.callTool({ name: "keet_read_recent_messages", arguments: { groupName: "Group", last: 0 } })).isError).toBe(true); await client.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("serializes image/caption delivery and reports a caption partial failure", async () => {
    const fake = fakeCore(); const { gateway, root, token } = await start(fake.core)
    try {
      await writeFile(join(root, "workspace", "image.png"), PNG_1X1)
      const client = new Client({ name: "test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(gateway.address!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as never)
      expect(json(await client.callTool({ name: "keet_send_image", arguments: { groupName: "Group", path: "image.png", caption: "caption" } }))).toEqual({ sent: true })
      expect(fake.events).toEqual(["image", "text:caption"])
      let release!: () => void; let images = 0; fake.core.sendImage = vi.fn(async () => { fake.events.push(`image:${++images}`); if (images === 1) await new Promise<void>((resolve) => { release = resolve }) }); fake.core.sendMessage = vi.fn(async (_group, text) => { fake.events.push(`caption:${text}`); return { deviceId: "bot", seq: images } })
      const first = client.callTool({ name: "keet_send_image", arguments: { groupName: "Group", path: "image.png", caption: "one" } }); while (!release) await new Promise((resolve) => setTimeout(resolve)); const second = client.callTool({ name: "keet_send_image", arguments: { groupName: "Group", path: "image.png", caption: "two" } }); await new Promise((resolve) => setTimeout(resolve)); expect(fake.events.slice(-1)).toEqual(["image:1"]); release(); await Promise.all([first, second]); expect(fake.events.slice(-4)).toEqual(["image:1", "caption:one", "image:2", "caption:two"])
      fake.core.sendMessage = vi.fn(async () => { throw new Error("failed") })
      const partial = await client.callTool({ name: "keet_send_image", arguments: { groupName: "Group", path: "image.png", caption: "caption" } })
      expect(partial.isError).toBe(true); expect(JSON.stringify(json(partial))).toContain("Image was delivered, but its caption was not sent; do not retry.")
      await writeFile(join(root, "outside.png"), PNG_1X1); await symlink(join(root, "outside.png"), join(root, "workspace", "escape.png")); const escaped = await client.callTool({ name: "keet_send_image", arguments: { groupName: "Group", path: "escape.png" } }); expect(escaped.isError).toBe(true); expect(JSON.stringify(json(escaped))).toContain("workspace image could not be read.")
      await client.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("renders IPv6 listener URLs with brackets", async () => {
    const fake = fakeCore(); const { gateway, root } = await start(fake.core, { listen: "::1:18768" })
    try { expect(gateway.address).toMatch(/^http:\/\/\[::1\]:18768\/mcp$/) } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("does not publish a delayed startup after close begins", async () => {
    const root = await mkdtemp(join(tmpdir(), "keet-mcp-test-")); const runtime = join(root, "runtime"); const workspace = join(root, "workspace"); const fake = fakeCore(); let release!: () => void
    try {
      await Promise.all([mkdir(runtime), mkdir(workspace)]); await Promise.all([writeFile(join(runtime, "bare"), "fixture"), writeFile(join(runtime, "core-worker.bundle"), "fixture")])
      const gateway = new KeetMcpGateway({ config: { runtimeDir: runtime, identityDir: join(root, "identity"), workspaceRoot: workspace, stateDir: join(root, "state"), eventRetention: 10_000, listen: "127.0.0.1:18769", token: "t".repeat(32) }, createCore: async () => await new Promise<KeetCore>((resolve) => { release = () => resolve(fake.core) }) })
      const startup = gateway.start(); while (!release) await new Promise((resolve) => setTimeout(resolve)); const shutdown = gateway.close(); release(); await expect(startup).rejects.toThrow("closing"); await shutdown; expect(gateway.address).toBeUndefined(); expect(fake.closed).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("propagates a Streamable HTTP cancellation to the Core without sending", async () => {
    const fake = fakeCore(); let observed = false; const send = vi.fn(async (_group: string, _text: string, _reply: unknown, signal: AbortSignal | undefined): Promise<undefined> => await new Promise((resolve, reject) => { signal?.addEventListener("abort", () => { observed = true; reject(new Error("cancelled")) }, { once: true }) })); fake.core.sendMessage = send
    const { gateway, root, token } = await start(fake.core)
    try {
      const client = new Client({ name: "test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(gateway.address!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as never)
      const controller = new AbortController(); const call = client.callTool({ name: "keet_send_message", arguments: { groupName: "Group", text: "cancel me" } }, undefined, { signal: controller.signal }); while (!send.mock.calls.length) await new Promise((resolve) => setTimeout(resolve)); controller.abort(); await expect(call).rejects.toThrow("aborted"); while (!observed) await new Promise((resolve) => setTimeout(resolve)); expect(fake.events).not.toContain("text:cancel me"); await client.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("never routes a queued pre-close request to a restarted Core", async () => {
    const first = fakeCore(); const second = fakeCore(); const secondSend = vi.fn(async (_group: string, text: string, _reply: unknown, signal: AbortSignal | undefined): Promise<undefined> => { expect(signal?.aborted).toBe(false); second.events.push(`text:${text}`) }); second.core.sendMessage = secondSend; const cancelled: string[] = []; const firstSend = vi.fn(async (_group: string, text: string, _reply: unknown, signal: AbortSignal | undefined): Promise<undefined> => await new Promise<undefined>((_resolve, reject) => { const cancel = () => { cancelled.push(text); reject(new Error("cancelled")) }; if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true }) })); first.core.sendMessage = firstSend
    const { gateway, root, token } = await start(first.core)
    try {
      const firstClient = new Client({ name: "first", version: "1" }); const queuedClient = new Client({ name: "queued", version: "1" }); const transport = () => new StreamableHTTPClientTransport(new URL(gateway.address!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }); await firstClient.connect(transport() as never); await queuedClient.connect(transport() as never)
      const firstAbort = new AbortController(); const queuedAbort = new AbortController(); const firstCall = firstClient.callTool({ name: "keet_send_message", arguments: { groupName: "Group", text: "first" } }, undefined, { signal: firstAbort.signal }); void firstCall.catch(() => undefined); while (!firstSend.mock.calls.length) await new Promise((resolve) => setTimeout(resolve)); expect(firstSend.mock.calls.map((call) => call[1])).toEqual(["first"])
      const queuedCall = queuedClient.callTool({ name: "keet_send_message", arguments: { groupName: "Group", text: "queued" } }, undefined, { signal: queuedAbort.signal }); void queuedCall.catch(() => undefined); await new Promise((resolve) => setTimeout(resolve)); expect(firstSend.mock.calls.map((call) => call[1])).toEqual(["first"])
      const endpoint = gateway.address!; await gateway.close(); expect(cancelled).toContain("first"); expect(gateway.address).toBeUndefined(); await expect(fetch(endpoint, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow(); (gateway.options as unknown as { createCore?: (_options: unknown) => Promise<KeetCore> }).createCore = async () => second.core; await gateway.start(); firstAbort.abort(); queuedAbort.abort(); await Promise.allSettled([firstCall, queuedCall]); expect(second.events).not.toContain("text:first"); expect(second.events).not.toContain("text:queued"); expect(secondSend).not.toHaveBeenCalled(); const restarted = new Client({ name: "restarted", version: "1" }); await restarted.connect(transport() as never); expect(json(await restarted.callTool({ name: "keet_send_message", arguments: { groupName: "Group", text: "after restart" } }))).toEqual({ sent: true }); expect(second.events).toEqual(["text:after restart"]); await restarted.close(); await firstClient.close().catch(() => undefined); await queuedClient.close().catch(() => undefined)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
