import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { KeetMcpGateway, type GatewayConfig } from "../packages/keet-mcp/src/index.js"
import type { KeetCore } from "@lamplitisles/keet-integration-core"

const PNG_1X1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JgP8AAAAASUVORK5CYII=", "base64"))
const gateways: KeetMcpGateway[] = []
let nextPort = 18765
afterEach(async () => { await Promise.all(gateways.splice(0).map((gateway) => gateway.close())) })

function fakeCore() {
  const events: string[] = []; let closed = false; let readState = 0
  const core = {
    listPendingDmRequests: vi.fn(async () => []),
    listGroups: vi.fn(async () => [
      { groupId: "group", roomType: "Default" as const, title: "Group" },
      { groupId: "dm", roomType: "DirectMessage" as const, dmMemberId: "peer", title: "Peer DM" },
      { groupId: "broadcast", roomType: "Broadcast" as const, title: "News" },
    ]),
    listMembers: vi.fn(async () => [{ memberId: "alice", displayName: "Alice" }]),
    readRecentMessages: vi.fn(async () => [{ groupId: "group", messageId: { deviceId: "device", seq: 1 }, senderId: "alice", senderLabel: "Alice", timestamp: 1, text: "hello" }]),
    sendMessage: vi.fn(async (_id: string, text: string) => { events.push(`text:${text}`); return { deviceId: "bot", seq: 2 } }),
    sendImage: vi.fn(async () => { events.push("image") }), close: vi.fn(async () => { closed = true }),
  } as unknown as KeetCore
  return { core, events, get closed() { return closed }, get readState() { return readState } }
}
async function start(core: KeetCore, overrides: Partial<GatewayConfig> = {}): Promise<{ gateway: KeetMcpGateway; root: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), "keet-mcp-test-")); const runtime = join(root, "runtime"); const workspace = join(root, "workspace"); const identity = join(root, "identity")
  await Promise.all([mkdir(runtime), mkdir(workspace)]); await Promise.all([writeFile(join(runtime, "bare"), "fixture"), writeFile(join(runtime, "core-worker.bundle"), "fixture")])
  const token = "t".repeat(32); const config: GatewayConfig = { runtimeDir: runtime, identityDir: identity, workspaceRoot: workspace, listen: `127.0.0.1:${nextPort++}`, token, ...overrides }
  const gateway = new KeetMcpGateway({ config, createCore: async () => core }); gateways.push(gateway); await gateway.start(); return { gateway, root, token }
}
function json(result: unknown): unknown { const value = result as { content?: Array<{ type: string; text?: string }> }; const first = value.content?.find((item) => item.type === "text"); return JSON.parse(first?.text ?? "{}") }
async function startPendingFailure(core: KeetCore, expected = "raw identity"): Promise<{ gateway: KeetMcpGateway; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "keet-mcp-test-")); const runtime = join(root, "runtime"); const workspace = join(root, "workspace")
  await Promise.all([mkdir(runtime), mkdir(workspace)]); await Promise.all([writeFile(join(runtime, "bare"), "fixture"), writeFile(join(runtime, "core-worker.bundle"), "fixture")])
  const gateway = new KeetMcpGateway({ config: { runtimeDir: runtime, identityDir: join(root, "identity"), workspaceRoot: workspace, listen: "127.0.0.1:18767", token: "t".repeat(32) }, createCore: async () => core })
  await expect(gateway.start()).rejects.toThrow(expected); return { gateway, root }
}

describe("Keet MCP gateway", () => {
  it("fails configuration or Core ownership before exposing a listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "keet-mcp-test-")); const runtime = join(root, "runtime"); const workspace = join(root, "workspace")
    try {
      await Promise.all([mkdir(runtime), mkdir(workspace)]); await Promise.all([writeFile(join(runtime, "bare"), "fixture"), writeFile(join(runtime, "core-worker.bundle"), "fixture")])
      const config: GatewayConfig = { runtimeDir: runtime, identityDir: join(root, "identity"), workspaceRoot: workspace, listen: "0.0.0.0:9999", token: "t".repeat(32) }
      const invalid = new KeetMcpGateway({ config, createCore: async () => fakeCore().core }); await expect(invalid.start()).rejects.toThrow("loopback"); expect(invalid.address).toBeUndefined()
      const locked = new KeetMcpGateway({ config: { ...config, listen: "127.0.0.1:18766" }, createCore: async () => { throw new Error("identity is already owned") } }); await expect(locked.start()).rejects.toThrow("identity is already owned"); expect(locked.address).toBeUndefined()
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
      expect(json(await client.callTool({ name: "keet_read_recent_messages", arguments: { groupName: "Group", last: 50 } }))).toMatchObject({ messages: [{ text: "hello" }] }); expect(fake.readState).toBe(0)
      expect((await client.callTool({ name: "keet_read_recent_messages", arguments: { groupName: "Group", last: 51 } })).isError).toBe(true)
      const unknown = await client.callTool({ name: "keet_list_members", arguments: { groupName: "Unknown" } }); expect(unknown.isError).toBe(true); expect(JSON.stringify(json(unknown))).toContain("not an allowed")
      expect(gateway.sessionCount).toBe(1); const terminated = await fetch(gateway.address!, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": transport.sessionId! } }); expect(terminated.status).toBe(200); await new Promise((resolve) => setTimeout(resolve)); expect(gateway.sessionCount).toBe(0); await client.close()
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
      const gateway = new KeetMcpGateway({ config: { runtimeDir: runtime, identityDir: join(root, "identity"), workspaceRoot: workspace, listen: "127.0.0.1:18769", token: "t".repeat(32) }, createCore: async () => await new Promise<KeetCore>((resolve) => { release = () => resolve(fake.core) }) })
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
