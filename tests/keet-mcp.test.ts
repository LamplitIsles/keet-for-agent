import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import sharp from "sharp"
import { configurationFromEnvironment, KeetMcpGateway, type GatewayConfig } from "../packages/keet-mcp/src/index.js"
import type { KeetCore, KeetMessage, KeetSubscription } from "@lamplitisles/keet-integration-core"

const PNG_1X1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"))
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
    status: vi.fn(async () => ({ state: "ready" as const, appVersion: "4.22.0", coreVersion: "4.22.20", abi: 35, swarming: true, identityId: "bot", displayName: "Bot" })),
    listPendingDmRequests: vi.fn(async () => []),
    listGroups: vi.fn(async () => [
      { groupId: "group", roomType: "Default" as const, title: "Group" },
      { groupId: "dm", roomType: "DirectMessage" as const, dmMemberId: "peer", title: "Peer DM" },
      { groupId: "broadcast", roomType: "Broadcast" as const, title: "News" },
    ]),
    listMembers: vi.fn(async () => [{ memberId: "alice", displayName: "Alice" }]),
    readRecentMessages: vi.fn(async () => { readState += 1; return [{ groupId: "group", messageId: { deviceId: "device", seq: 1 }, senderId: "alice", senderLabel: "Alice", timestamp: 1, text: "hello" }] }),
    sendMessage: vi.fn(async (_id: string, text: string) => { events.push(`text:${text}`); return { deviceId: "bot", seq: 2 } }), readImage: vi.fn(async () => PNG_1X1),
    sendFile: vi.fn(async () => { events.push("file") }), close: vi.fn(async () => { closed = true }),
    watchMessages,
  } as unknown as KeetCore
  return { core, events, watchMessages, emit(groupId: string, message: KeetMessage) { watchers.get(groupId)?.(message) }, terminateWatcher(groupId: string) { terminateWatchers.get(groupId)?.("connection-failed") }, get closed() { return closed }, get readState() { return readState } }
}
async function start(core: KeetCore, overrides: Partial<GatewayConfig> = {}, onFatal?: () => void): Promise<{ gateway: KeetMcpGateway; root: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), "keet-mcp-test-")); const runtime = join(root, "runtime"); const workspace = join(root, "workspace"); const identity = join(root, "identity"); const state = join(root, "state")
  await Promise.all([mkdir(runtime), mkdir(workspace)]); await Promise.all([writeFile(join(runtime, "bare"), "fixture"), writeFile(join(runtime, "core-worker.bundle"), "fixture")])
  const token = "t".repeat(32); const config: GatewayConfig = { runtimeDir: runtime, identityDir: identity, workspaceRoot: workspace, stateDir: state, listen: `127.0.0.1:${nextPort++}`, token, ...overrides }
  const gateway = new KeetMcpGateway({ config, createCore: async () => core, ...(onFatal ? { onFatal } : {}) }); gateways.push(gateway); await gateway.start(); return { gateway, root, token }
}
function json(result: unknown): unknown { const value = result as { content?: Array<{ type: string; text?: string }> }; const first = value.content?.find((item) => item.type === "text"); return JSON.parse(first?.text ?? "{}") }
function pause(milliseconds = 25): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
async function receiver(statuses: number[]) { const received: Array<{ body: any; auth: string | undefined; method: string | undefined }> = []; const server = createServer(async (request, response) => { let raw = ""; for await (const chunk of request) raw += chunk; received.push({ body: raw ? JSON.parse(raw) : undefined, auth: request.headers.authorization, method: request.method }); const status = statuses.shift() ?? 204; response.writeHead(status, status === 302 ? { location: "/redirect-target" } : {}).end() }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address()! as import("node:net").AddressInfo; return { url: `http://127.0.0.1:${address.port}/api/keet/events`, received, server } }
async function startPendingFailure(core: KeetCore, expected = "raw identity"): Promise<{ gateway: KeetMcpGateway; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "keet-mcp-test-")); const runtime = join(root, "runtime"); const workspace = join(root, "workspace")
  await Promise.all([mkdir(runtime), mkdir(workspace)]); await Promise.all([writeFile(join(runtime, "bare"), "fixture"), writeFile(join(runtime, "core-worker.bundle"), "fixture")])
  const gateway = new KeetMcpGateway({ config: { runtimeDir: runtime, identityDir: join(root, "identity"), workspaceRoot: workspace, stateDir: join(root, "state"), listen: "127.0.0.1:18767", token: "t".repeat(32) }, createCore: async () => core })
  await expect(gateway.start()).rejects.toThrow(expected); return { gateway, root }
}

describe("Keet MCP gateway", () => {
  it("fails configuration or Core ownership before exposing a listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "keet-mcp-test-")); const runtime = join(root, "runtime"); const workspace = join(root, "workspace")
    try {
      await Promise.all([mkdir(runtime), mkdir(workspace)]); await Promise.all([writeFile(join(runtime, "bare"), "fixture"), writeFile(join(runtime, "core-worker.bundle"), "fixture")])
      const config: GatewayConfig = { runtimeDir: runtime, identityDir: join(root, "identity"), workspaceRoot: workspace, stateDir: join(root, "state"), listen: "0.0.0.0:9999", token: "t".repeat(32) }
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
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["list_destinations", "list_members", "read_recent_messages", "send_file", "send_message"])
      expect(json(await client.callTool({ name: "list_destinations", arguments: {} }))).toEqual({ destinations: [{ destinationName: "Group", kind: "group" }, { destinationName: "Peer DM", kind: "dm" }, { destinationName: "News", kind: "broadcast" }] })
      expect(json(await client.callTool({ name: "list_members", arguments: { destinationName: "Group" } }))).toEqual({ members: [{ displayName: "Alice" }] })
      expect(json(await client.callTool({ name: "read_recent_messages", arguments: { destinationName: "Peer DM", last: 1 } }))).toEqual({ messages: [{ senderLabel: "Alice", timestamp: 1, text: "hello" }] })
      expect(json(await client.callTool({ name: "read_recent_messages", arguments: { destinationName: "Group", last: 50 } }))).toMatchObject({ messages: [{ text: "hello" }] }); expect(fake.readState).toBe(2)
      expect((await client.callTool({ name: "read_recent_messages", arguments: { destinationName: "Group", last: 51 } })).isError).toBe(true)
      const unknown = await client.callTool({ name: "list_members", arguments: { destinationName: "Unknown" } }); expect(unknown.isError).toBe(true); expect(JSON.stringify(json(unknown))).toContain("not an allowed")
      expect(gateway.sessionCount).toBe(1); const terminated = await fetch(gateway.address!, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": transport.sessionId! } }); expect(terminated.status).toBe(200); await new Promise((resolve) => setTimeout(resolve)); expect(gateway.sessionCount).toBe(0); await client.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("validates webhook configuration and leaves MCP usable without one", async () => { const fake = fakeCore(); const { gateway, root } = await start(fake.core); try { expect(gateway.address).toBeDefined(); expect(() => configurationFromEnvironment({ KEET_MCP_RUNTIME_DIR: "/r", KEET_MCP_IDENTITY_DIR: "/i", KEET_MCP_WORKSPACE_ROOT: "/w", KEET_MCP_STATE_DIR: "/s", KEET_MCP_LISTEN: "127.0.0.1:1", KEET_MCP_TOKEN: "t".repeat(32), KEET_WEBHOOK_BEARER_TOKEN: "x" })).toThrow("requires KEET_WEBHOOK_URL") } finally { await rm(root, { recursive: true, force: true }) } })
  it("posts text-only group, DM, and broadcast events with trigger facts", async () => { const target = await receiver([204, 204, 204, 204]); const fake = fakeCore(); const { root } = await start(fake.core, { webhookUrl: target.url, webhookBearerToken: "secret" }); try { fake.emit("group", { groupId: "group", messageId: { deviceId: "a", seq: 1 }, senderId: "alice", senderLabel: "Alice", timestamp: 1, text: "ordinary" }); fake.emit("group", { groupId: "group", messageId: { deviceId: "a", seq: 2 }, senderId: "alice", senderLabel: "Alice", timestamp: 2, text: "Bot", mentions: ["bot"] }); fake.emit("dm", { groupId: "dm", messageId: { deviceId: "d", seq: 1 }, senderId: "peer", senderLabel: "Peer", timestamp: 3, text: "DM" }); fake.emit("broadcast", { groupId: "broadcast", messageId: { deviceId: "n", seq: 1 }, senderId: "author", senderLabel: "Author", timestamp: 4, text: "caption", images: [{ file: {}, mediaType: "image/png" }] }); while (target.received.length < 4) await pause(); expect(target.received.map((entry) => entry.body.sequence)).toEqual([1, 2, 3, 4]); expect(target.received[1]!.body.trigger).toBe("mention"); expect(target.received[2]!.body.trigger).toBe("dm"); expect(target.received[3]!.body.images).toBeUndefined(); expect(target.received[0]!.auth).toBe("Bearer secret") } finally { target.server.close(); await rm(root, { recursive: true, force: true }) } })
  it("adds bounded external reaction context only to qualifying Group and DM text", async () => {
    const target = await receiver([204, 204, 204, 204]); const fake = fakeCore()
    const own = { groupId: "group", messageId: { deviceId: "bot-device", seq: 7 }, senderId: "bot", senderLabel: "Bot", timestamp: 1, text: "🙂".repeat(60), reactions: [{ emoji: "👍", count: 3, own: false }, { emoji: "✅", count: 1, own: false }, { emoji: ":custom:", count: 2, own: false }] }
    const readRecent = vi.fn(async (id: string) => id === "dm" ? [{ ...own, groupId: "dm" }] : [own]); fake.core.readRecentMessages = readRecent
    const readReactions = vi.fn(async () => [{ emoji: "👍", count: 3, own: true }, { emoji: "✅", count: 1, own: true }, { emoji: ":custom:", count: 2, own: false }]); fake.core.readReactions = readReactions
    const { root } = await start(fake.core, { webhookUrl: target.url })
    try {
      const incoming = (groupId: string, seq: number, text: string, mentions?: string[]) => ({ groupId, messageId: { deviceId: "peer", seq }, senderId: "peer", senderLabel: "Peer", timestamp: seq, text, ...(mentions ? { mentions } : {}) })
      fake.emit("group", incoming("group", 1, "ordinary"))
      fake.emit("group", incoming("group", 2, "hello Bot", ["bot"]))
      fake.emit("dm", incoming("dm", 3, "hello"))
      fake.emit("broadcast", incoming("broadcast", 4, "caption"))
      fake.emit("group", { ...incoming("group", 5, ""), reactions: [{ emoji: "👍", count: 4, own: false }] })
      while (target.received.length < 4) await pause()
      expect(target.received[0]!.body.reactionContext).toBeUndefined()
      expect(target.received[1]!.body.reactionContext).toEqual([
        { targetMessageId: own.messageId, targetText: "🙂".repeat(48), emoji: "👍", externalCount: 2 },
        { targetMessageId: own.messageId, targetText: "🙂".repeat(48), emoji: ":custom:", externalCount: 2 },
      ])
      expect(target.received[2]!.body.reactionContext).toEqual(target.received[1]!.body.reactionContext)
      expect(target.received[3]!.body.reactionContext).toBeUndefined()
      expect(target.received).toHaveLength(4)
      expect(readRecent.mock.calls).toContainEqual(["group", 50])
      expect(readReactions.mock.calls).toContainEqual(["group", own.messageId])
      fake.core.readRecentMessages = vi.fn(async () => Array.from({ length: 25 }, (_, index) => ({ ...own, messageId: { deviceId: "bot-device", seq: index }, reactions: [{ emoji: "👍", count: 2, own: false }] })))
      readReactions.mockClear()
      readReactions.mockResolvedValue([{ emoji: "👍", count: 2, own: false }])
      fake.emit("group", incoming("group", 6, "Bot", ["bot"]))
      while (target.received.length < 5) await pause()
      expect(target.received[4]!.body.reactionContext).toHaveLength(16)
      expect(target.received[4]!.body.reactionContext[0].targetMessageId.seq).toBe(24)
      expect(readReactions).toHaveBeenCalledTimes(16)
    } finally { target.server.close(); await rm(root, { recursive: true, force: true }) }
  })

  it("keeps triggering text when reaction history cannot be read", async () => {
    const target = await receiver([204]); const fake = fakeCore()
    fake.core.readRecentMessages = vi.fn(async () => { throw new Error("private runtime path") })
    const { root } = await start(fake.core, { webhookUrl: target.url })
    try {
      fake.emit("dm", { groupId: "dm", messageId: { deviceId: "peer", seq: 1 }, senderId: "peer", senderLabel: "Peer", timestamp: 1, text: "hello" })
      while (!target.received.length) await pause()
      expect(target.received[0]!.body).toMatchObject({ text: "hello", trigger: "dm" })
      expect(target.received[0]!.body.reactionContext).toBeUndefined()
    } finally { target.server.close(); await rm(root, { recursive: true, force: true }) }
  })

  it("omits a target when its complete reaction read fails while preserving trigger text", async () => {
    const target = await receiver([204]); const fake = fakeCore()
    fake.core.readRecentMessages = vi.fn(async () => [{ groupId: "dm", messageId: { deviceId: "bot", seq: 4 }, senderId: "bot", senderLabel: "Bot", timestamp: 1, text: "prior", reactions: [{ emoji: "👍", count: 1, own: false }] }])
    const readReactions = vi.fn(async () => { throw new Error("invalid complete reaction snapshot") }); fake.core.readReactions = readReactions
    const { root } = await start(fake.core, { webhookUrl: target.url })
    try {
      fake.emit("dm", { groupId: "dm", messageId: { deviceId: "peer", seq: 1 }, senderId: "peer", senderLabel: "Peer", timestamp: 1, text: "hello" })
      while (!target.received.length) await pause()
      expect(target.received[0]!.body).toMatchObject({ text: "hello", trigger: "dm" })
      expect(target.received[0]!.body.reactionContext).toBeUndefined()
      expect(readReactions).toHaveBeenCalledOnce()
    } finally { target.server.close(); await rm(root, { recursive: true, force: true }) }
  })

  it("retries in order with an identical event after restart", async () => { const target = await receiver([500, 204, 204]); const first = fakeCore(); first.core.readRecentMessages = vi.fn(async () => [{ groupId: "group", messageId: { deviceId: "bot", seq: 8 }, senderId: "bot", senderLabel: "Bot", timestamp: 1, text: "prior", reactions: [{ emoji: "👍", count: 2, own: false }] }]); first.core.readReactions = vi.fn(async () => [{ emoji: "👍", count: 2, own: true }]); const { gateway, root } = await start(first.core, { webhookUrl: target.url }); try { first.emit("group", { groupId: "group", messageId: { deviceId: "a", seq: 1 }, senderId: "alice", senderLabel: "Alice", timestamp: 1, text: "first Bot" }); first.emit("group", { groupId: "group", messageId: { deviceId: "a", seq: 2 }, senderId: "alice", senderLabel: "Alice", timestamp: 2, text: "second" }); while (target.received.length < 1) await pause(); await gateway.close(); const second = fakeCore(); const restarted = new KeetMcpGateway({ config: gateway.options.config, createCore: async () => second.core }); gateways.push(restarted); await restarted.start(); while (target.received.length < 3) await pause(); expect(target.received.map((entry) => entry.body.text)).toEqual(["first Bot", "first Bot", "second"]); expect(target.received[0]!.body).toEqual(target.received[1]!.body); expect(target.received[0]!.body.reactionContext).toEqual([{ targetMessageId: { deviceId: "bot", seq: 8 }, targetText: "prior", emoji: "👍", externalCount: 1 }]); await restarted.close() } finally { target.server.close(); await rm(root, { recursive: true, force: true }) } })
  it("does not follow redirects or advance past non-2xx responses", async () => {
    const target = await receiver([302, 401, 503, 204, 204]); const fake = fakeCore(); const { root } = await start(fake.core, { webhookUrl: target.url })
    try {
      fake.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: 1 }, senderId: "alice", senderLabel: "Alice", timestamp: 1, text: "first" })
      fake.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: 2 }, senderId: "alice", senderLabel: "Alice", timestamp: 2, text: "second" })
      while (target.received.length < 5) await pause()
      expect(target.received.map((entry) => entry.method)).toEqual(["POST", "POST", "POST", "POST", "POST"])
      expect(target.received.map((entry) => entry.body.text)).toEqual(["first", "first", "first", "first", "second"])
      expect(new Set(target.received.slice(0, 4).map((entry) => entry.body.eventId)).size).toBe(1)
    } finally { target.server.close(); await rm(root, { recursive: true, force: true }) }
  })
  it("fails closed and reports a fatal daemon error when persistence fails", async () => { const target = await receiver([204]); const fake = fakeCore(); const fatal = vi.fn(); const { gateway, root } = await start(fake.core, { webhookUrl: target.url }, fatal); try { await mkdir(join(root, "state", "webhook-events.ndjson")); fake.emit("group", { groupId: "group", messageId: { deviceId: "a", seq: 1 }, senderId: "alice", senderLabel: "Alice", timestamp: 1, text: "fail" }); while (!fake.closed) await pause(); expect(gateway.address).toBeUndefined(); expect(fatal).toHaveBeenCalledOnce(); expect(target.received).toEqual([]) } finally { target.server.close(); await rm(root, { recursive: true, force: true }) } })
  it("reports a persistence failure even if shutdown has begun", async () => {
    const target = await receiver([]); const fake = fakeCore(); const fatal = vi.fn(); const { gateway, root } = await start(fake.core, { webhookUrl: target.url }, fatal)
    try {
      await mkdir(join(root, "state", "webhook-events.ndjson"))
      fake.emit("group", { groupId: "group", messageId: { deviceId: "a", seq: 1 }, senderId: "alice", senderLabel: "Alice", timestamp: 1, text: "fail during close" })
      await gateway.close()
      expect(fatal).toHaveBeenCalledOnce()
      expect(target.received).toEqual([])
    } finally { target.server.close(); await rm(root, { recursive: true, force: true }) }
  })
  it("reports intake overflow as fatal", async () => {
    const target = await receiver([]); const fake = fakeCore(); const fatal = vi.fn(); const { gateway, root } = await start(fake.core, { webhookUrl: target.url }, fatal)
    try {
      for (let sequence = 1; sequence <= 1025; sequence += 1) fake.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: sequence }, senderId: "alice", senderLabel: "Alice", timestamp: sequence, text: "queued" })
      while (!fake.closed) await pause()
      expect(gateway.address).toBeUndefined(); expect(fatal).toHaveBeenCalledOnce()
    } finally { target.server.close(); await rm(root, { recursive: true, force: true }) }
  })
  it("treats an acknowledgement journal rewrite failure as fatal", async () => {
    let acknowledge!: () => void
    let received!: () => void
    const arrived = new Promise<void>((resolve) => { received = resolve })
    const server = createServer(async (request, response) => { for await (const _chunk of request) { /* consume body */ }; received(); await new Promise<void>((resolve) => { acknowledge = resolve }); response.writeHead(204).end() })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()! as import("node:net").AddressInfo
    const fake = fakeCore(); const { gateway, root } = await start(fake.core, { webhookUrl: `http://127.0.0.1:${address.port}/api/keet/events` })
    try {
      fake.emit("group", { groupId: "group", messageId: { deviceId: "a", seq: 1 }, senderId: "alice", senderLabel: "Alice", timestamp: 1, text: "persist me" })
      await arrived
      await mkdir(join(root, "state", "webhook-events.ndjson.replacement"))
      acknowledge()
      await pause(100)
      expect(fake.closed).toBe(true)
      expect(gateway.address).toBeUndefined()
    } finally { server.close(); await rm(root, { recursive: true, force: true }) }
  })
  it("classifies label and own-message replies while excluding self and image-only events", async () => {
    const target = await receiver([204, 204, 204, 204])
    const fake = fakeCore()
    fake.core.readRecentMessages = vi.fn(async () => [{ groupId: "group", messageId: { deviceId: "bot-device", seq: 7 }, senderId: "bot", senderLabel: "Bot", timestamp: 1, text: "old reply anchor" }])
    const { root } = await start(fake.core, { webhookUrl: target.url })
    try {
      fake.emit("group", { groupId: "group", messageId: { deviceId: "bot-device", seq: 8 }, senderId: "bot", senderLabel: "Bot", timestamp: 2, text: "self" })
      fake.emit("dm", { groupId: "dm", messageId: { deviceId: "peer", seq: 1 }, senderId: "peer", senderLabel: "Peer", timestamp: 3, text: "", images: [{ file: {}, mediaType: "image/png" }] })
      fake.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: 1 }, senderId: "alice", senderLabel: "Alice", timestamp: 4, text: "hello Bot" })
      fake.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: 2 }, senderId: "alice", senderLabel: "Alice", timestamp: 5, text: "thread reply", replyTo: { deviceId: "bot-device", seq: 7 } })
      fake.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: 3 }, senderId: "alice", senderLabel: "Alice", timestamp: 6, text: `${" ".repeat(16_001)}bounded` })
      fake.emit("group", { groupId: "group", messageId: { deviceId: "alice", seq: 4 }, senderId: "private-member-id", senderLabel: "private-member-id", timestamp: 7, text: "unnamed sender" })
      while (target.received.length < 4) await pause()
      expect(target.received.map((entry) => entry.body.trigger)).toEqual(["label", "reply", undefined, undefined])
      expect(target.received.map((entry) => entry.body.sequence)).toEqual([1, 2, 3, 4])
      expect(target.received[2]!.body.text).toBe("bounded")
      expect(target.received[3]!.body.senderLabel).toBe("Unknown sender")
      expect(JSON.stringify(target.received[3]!.body)).not.toContain("private-member-id")
      expect(target.received[0]!.auth).toBeUndefined()
    } finally { target.server.close(); await rm(root, { recursive: true, force: true }) }
  })
  it("rejects unsafe webhook URLs and accepts HTTPS and loopback HTTP", () => {
    const base = { KEET_MCP_RUNTIME_DIR: "/r", KEET_MCP_IDENTITY_DIR: "/i", KEET_MCP_WORKSPACE_ROOT: "/w", KEET_MCP_STATE_DIR: "/s", KEET_MCP_LISTEN: "127.0.0.1:1", KEET_MCP_TOKEN: "t".repeat(32) }
    for (const value of ["http://example.com/events", "http://localhost.evil/events", "https://user:pass@example.com/events", "https://example.com/events#fragment", "https://example.com/events#", "file:///tmp/events"]) expect(() => configurationFromEnvironment({ ...base, KEET_WEBHOOK_URL: value })).toThrow("KEET_WEBHOOK_URL")
    for (const value of ["https://example.com/events", "http://127.0.0.1:8080/events", "http://[::1]:8080/events", "http://localhost:8080/events"]) expect(configurationFromEnvironment({ ...base, KEET_WEBHOOK_URL: value }).webhookUrl).toBe(value)
  })
  it("filters pending DMs, fails closed on pending lookup, and keeps an existing start usable", async () => {
    const fake = fakeCore(); fake.core.listPendingDmRequests = vi.fn(async () => [{ memberId: " peer " }])
    const { gateway, root, token } = await start(fake.core)
    try {
      expect(gateway.destinations.map((destination) => destination.groupName)).not.toContain("Peer DM")
      await expect(gateway.start()).rejects.toThrow("already started")
      const client = new Client({ name: "test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(gateway.address!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as never)
      expect(json(await client.callTool({ name: "list_destinations", arguments: {} }))).toEqual({ destinations: [{ destinationName: "Group", kind: "group" }, { destinationName: "News", kind: "broadcast" }] }); await client.close()
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
      for (const args of [{ replyTo: { deviceId: "x", seq: 1 } }, { mentions: ["Alice"] }]) { const result = await client.callTool({ name: "send_message", arguments: { destinationName: "News", text: "x", ...args } }); expect(result.isError).toBe(true) }
      expect(json(await client.callTool({ name: "send_message", arguments: { destinationName: "Group", text: "reply", replyTo: { deviceId: "device", seq: 1 }, mentions: ["Alice"] } }))).toEqual({ sent: true })
      let release!: () => void; let sends = 0; fake.core.sendMessage = vi.fn(async (_group, text) => { fake.events.push(`start:${text}`); if (++sends === 1) await new Promise<void>((resolve) => { release = resolve }); fake.events.push(`done:${text}`); return { deviceId: "bot", seq: sends } })
      const first = client.callTool({ name: "send_message", arguments: { destinationName: "Group", text: "one" } }); while (!release) await new Promise((resolve) => setTimeout(resolve)); const second = client.callTool({ name: "send_message", arguments: { destinationName: "Group", text: "two" } }); await new Promise((resolve) => setTimeout(resolve)); expect(fake.events.slice(-1)).toEqual(["start:one"]); release(); await Promise.all([first, second]); expect(fake.events.slice(-4)).toEqual(["start:one", "done:one", "start:two", "done:two"])
      fake.core.readRecentMessages = vi.fn(async () => { throw new Error("/runtime/secret /identity/raw group-id") })
      const failed = await client.callTool({ name: "read_recent_messages", arguments: { destinationName: "Group", last: 50 } }); expect(JSON.stringify(json(failed))).toContain("Keet recent messages are unavailable."); expect(JSON.stringify(json(failed))).not.toContain("secret")
      expect((await client.callTool({ name: "read_recent_messages", arguments: { destinationName: "Group", last: 0 } })).isError).toBe(true); await client.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("sends text then one reaction, and reports partial success without resending text", async () => {
    const fake = fakeCore(); const { gateway, root, token } = await start(fake.core)
    const client = new Client({ name: "reaction-test", version: "1" })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(gateway.address!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as never)
      const target = { deviceId: "historical-device", seq: 19 }
      const addReaction = vi.fn(async (_group, _id, _emoji) => { fake.events.push("reaction") }); fake.core.addReaction = addReaction
      const sendMessage = vi.fn(async (_group: string, text: string) => { fake.events.push(`text:${text}`); return { deviceId: "bot", seq: 2 } }); fake.core.sendMessage = sendMessage
      const call = (destinationName: string, text: string, reaction: unknown, replyTo?: unknown) => client.callTool({ name: "send_message", arguments: { destinationName, text, reaction, ...(replyTo ? { replyTo } : {}) } })
      for (const reaction of [{ targetMessageId: target, emoji: "plain" }, { targetMessageId: { deviceId: "", seq: 1 }, emoji: "👍" }]) expect((await call("Group", "invalid", reaction)).isError).toBe(true)
      expect((await call("News", "invalid", { targetMessageId: target, emoji: "👍" })).isError).toBe(true)
      expect((await call("Unknown", "invalid", { targetMessageId: target, emoji: "👍" })).isError).toBe(true)
      expect(sendMessage).not.toHaveBeenCalled()
      expect(json(await call("Group", "historical", { targetMessageId: target, emoji: "👍" }, { deviceId: "other", seq: 4 }))).toEqual({ sent: true, reacted: true })
      expect(addReaction).toHaveBeenCalledWith("group", target, "👍", expect.any(AbortSignal))
      expect(fake.events).toEqual(["text:historical", "reaction"])
      fake.core.addReaction = vi.fn(async () => { throw new Error("/identity/private target") })
      expect(json(await call("Peer DM", "dm reply", { targetMessageId: { deviceId: "peer", seq: 5 }, emoji: "❤️" }))).toEqual({ sent: true, reacted: false, reactionError: "Keet reaction could not be added." })
      expect(fake.events).toEqual(["text:historical", "reaction", "text:dm reply"])
      expect(sendMessage).toHaveBeenCalledTimes(2)
    } finally { await client.close().catch(() => undefined); await rm(root, { recursive: true, force: true }) }
  })

  it("sends ordinary files and preserves native image preview metadata", async () => {
    const fake = fakeCore(); const { gateway, root, token } = await start(fake.core)
    try {
      const largePng = await sharp({ create: { width: 2_500, height: 2_500, channels: 3, background: "#2468ac" } }).png({ compressionLevel: 0 }).toBuffer()
      expect(largePng.byteLength).toBeGreaterThan(16 * 1024 * 1024)
      await writeFile(join(root, "workspace", "image.png"), PNG_1X1); await writeFile(join(root, "workspace", "large.png"), largePng); await writeFile(join(root, "workspace", "bundle.zip"), "PK\u0003\u0004fixture")
      const client = new Client({ name: "test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(gateway.address!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as never)
      const sent: Array<{ mediaType: string; name: string; preview?: { bytes: Uint8Array; width: number; height: number } }> = []; fake.core.sendFile = vi.fn(async (_group, file) => { sent.push(file) })
      expect(json(await client.callTool({ name: "send_file", arguments: { destinationName: "Group", path: "image.png" } }))).toEqual({ sent: true })
      expect(sent[0]).toMatchObject({ mediaType: "image/png", name: "image.png", width: 1, height: 1, preview: { width: 1, height: 1 } }); expect(sent[0]!.preview!.bytes.byteLength).toBeGreaterThan(0)
      expect(json(await client.callTool({ name: "send_file", arguments: { destinationName: "Peer DM", path: "bundle.zip" } }))).toEqual({ sent: true })
      expect(sent[1]).toMatchObject({ mediaType: "application/zip", name: "bundle.zip" }); expect(sent[1]!.preview).toBeUndefined()
      expect(json(await client.callTool({ name: "send_file", arguments: { destinationName: "Group", path: "large.png" } }))).toEqual({ sent: true })
      expect(sent[2]).toMatchObject({ mediaType: "image/png", name: "large.png", width: 2_500, height: 2_500, preview: { width: 320, height: 320 } }); expect(sent[2]!.preview!.bytes.byteLength).toBeGreaterThan(0)
      await writeFile(join(root, "outside.png"), PNG_1X1); await symlink(join(root, "outside.png"), join(root, "workspace", "escape.png")); const escaped = await client.callTool({ name: "send_file", arguments: { destinationName: "Group", path: "escape.png" } }); expect(escaped.isError).toBe(true); expect(JSON.stringify(json(escaped))).toContain("workspace file could not be read.")
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
      const gateway = new KeetMcpGateway({ config: { runtimeDir: runtime, identityDir: join(root, "identity"), workspaceRoot: workspace, stateDir: join(root, "state"), listen: "127.0.0.1:18769", token: "t".repeat(32) }, createCore: async () => await new Promise<KeetCore>((resolve) => { release = () => resolve(fake.core) }) })
      const startup = gateway.start(); while (!release) await new Promise((resolve) => setTimeout(resolve)); const shutdown = gateway.close(); release(); await expect(startup).rejects.toThrow("closing"); await shutdown; expect(gateway.address).toBeUndefined(); expect(fake.closed).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("propagates a Streamable HTTP cancellation to the Core without sending", async () => {
    const fake = fakeCore(); let observed = false; const send = vi.fn(async (_group: string, _text: string, _reply: unknown, signal: AbortSignal | undefined): Promise<undefined> => await new Promise((resolve, reject) => { signal?.addEventListener("abort", () => { observed = true; reject(new Error("cancelled")) }, { once: true }) })); fake.core.sendMessage = send
    const { gateway, root, token } = await start(fake.core)
    try {
      const client = new Client({ name: "test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(gateway.address!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as never)
      const controller = new AbortController(); const call = client.callTool({ name: "send_message", arguments: { destinationName: "Group", text: "cancel me" } }, undefined, { signal: controller.signal }); while (!send.mock.calls.length) await new Promise((resolve) => setTimeout(resolve)); controller.abort(); await expect(call).rejects.toThrow("aborted"); while (!observed) await new Promise((resolve) => setTimeout(resolve)); expect(fake.events).not.toContain("text:cancel me"); await client.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("never routes a queued pre-close request to a restarted Core", async () => {
    const first = fakeCore(); const second = fakeCore(); const secondSend = vi.fn(async (_group: string, text: string, _reply: unknown, signal: AbortSignal | undefined): Promise<undefined> => { expect(signal?.aborted).toBe(false); second.events.push(`text:${text}`) }); second.core.sendMessage = secondSend; const cancelled: string[] = []; const firstSend = vi.fn(async (_group: string, text: string, _reply: unknown, signal: AbortSignal | undefined): Promise<undefined> => await new Promise<undefined>((_resolve, reject) => { const cancel = () => { cancelled.push(text); reject(new Error("cancelled")) }; if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true }) })); first.core.sendMessage = firstSend
    const { gateway, root, token } = await start(first.core)
    try {
      const firstClient = new Client({ name: "first", version: "1" }); const queuedClient = new Client({ name: "queued", version: "1" }); const transport = () => new StreamableHTTPClientTransport(new URL(gateway.address!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }); await firstClient.connect(transport() as never); await queuedClient.connect(transport() as never)
      const firstAbort = new AbortController(); const queuedAbort = new AbortController(); const firstCall = firstClient.callTool({ name: "send_message", arguments: { destinationName: "Group", text: "first" } }, undefined, { signal: firstAbort.signal }); void firstCall.catch(() => undefined); while (!firstSend.mock.calls.length) await new Promise((resolve) => setTimeout(resolve)); expect(firstSend.mock.calls.map((call) => call[1])).toEqual(["first"])
      const queuedCall = queuedClient.callTool({ name: "send_message", arguments: { destinationName: "Group", text: "queued" } }, undefined, { signal: queuedAbort.signal }); void queuedCall.catch(() => undefined); await new Promise((resolve) => setTimeout(resolve)); expect(firstSend.mock.calls.map((call) => call[1])).toEqual(["first"])
      const endpoint = gateway.address!; await gateway.close(); expect(cancelled).toContain("first"); expect(gateway.address).toBeUndefined(); await expect(fetch(endpoint, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow(); (gateway.options as unknown as { createCore?: (_options: unknown) => Promise<KeetCore> }).createCore = async () => second.core; await gateway.start(); firstAbort.abort(); queuedAbort.abort(); await Promise.allSettled([firstCall, queuedCall]); expect(second.events).not.toContain("text:first"); expect(second.events).not.toContain("text:queued"); expect(secondSend).not.toHaveBeenCalled(); const restarted = new Client({ name: "restarted", version: "1" }); await restarted.connect(transport() as never); expect(json(await restarted.callTool({ name: "send_message", arguments: { destinationName: "Group", text: "after restart" } }))).toEqual({ sent: true }); expect(second.events).toEqual(["text:after restart"]); await restarted.close(); await firstClient.close().catch(() => undefined); await queuedClient.close().catch(() => undefined)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
