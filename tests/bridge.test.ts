import { describe, expect, it, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ToolDefinition } from "@deepseek-ai/dsh-tools"
import { KeetBridge, bridgeRpcHandler, type KeetBridgeAgent, type KeetBridgeDependencies } from "../packages/dsh-keet/src/bridge.js"
import type { KeetCore, KeetMessage, KeetMessageId, ManagedGroup, KeetPendingDmRequest } from "../packages/dsh-keet/src/core-contract.js"
import { KeetIntegrationCore } from "../packages/keet-core/src/index.js"

const settings: { groupId: string; workspaceId: string; dmMemberId?: string } = { groupId: "group-fixed", workspaceId: "workspace" }
const dmGroupId = "group-dm"
const fakeWorker = fileURLToPath(new URL("./fixtures/fake-worker.mjs", import.meta.url))
const nodeExecutable = execFileSync("which", ["node"], { encoding: "utf8" }).trim()

function message(seq: number, text: string, extra: Partial<KeetMessage> = {}): KeetMessage {
  return { messageId: { deviceId: "device-human", seq }, groupId: settings.groupId, senderId: "human", senderLabel: "Alice", timestamp: seq, text, ...extra }
}

function fakeCore(options: { onWatch?: (handler: (message: KeetMessage) => void, groupId: string) => void; onSubscription?: (terminate: () => void) => void; fail?: boolean; failWatch?: boolean; missingIdentity?: boolean; missingMembershipGroup?: string; rosterFailureGroup?: string; dm?: boolean; duplicateNames?: boolean; groups?: ManagedGroup[]; pending?: KeetPendingDmRequest[]; pendingFailure?: boolean } = {}): KeetCore & { sent: Array<{ groupId: string; text: string; replyTo?: KeetMessageId }>; closed: boolean } {
  const sent: Array<{ groupId: string; text: string; replyTo?: KeetMessageId }> = []
  let closed = false
  const core: KeetCore & { sent: typeof sent; closed: boolean } = {
    sent,
    get closed() { return closed },
    status: async () => {
      if (options.fail) throw new Error("private provider output")
      return { state: "ready", appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: false, identityId: options.missingIdentity ? "" : "bot", displayName: "Keet Bot" }
    },
    listGroups: async () => options.groups ?? [{ groupId: settings.groupId, roomType: "Default", title: options.duplicateNames ? " Shared\nName " : "Test group" }, ...(options.dm ? [{ groupId: dmGroupId, roomType: "DirectMessage" as const, title: options.duplicateNames ? "Shared Name" : "Managed DM", dmMemberId: "peer" }] : [])],
    validateGroup: async (groupId) => ({ groupId, roomType: "Default", title: options.duplicateNames ? " Shared\nName " : "Test group" }),
    resolveDm: async () => ({ groupId: dmGroupId, roomType: "DirectMessage", dmMemberId: "peer", title: options.duplicateNames ? "Shared\nName" : "Managed DM" }),
    listMembers: async (groupId) => {
      if (groupId === options.rosterFailureGroup) throw new Error("roster unavailable")
      const missingSelf = groupId === options.missingMembershipGroup
      return [...(missingSelf ? [] : [{ memberId: "bot", displayName: "Keet Bot" }]), ...(groupId === dmGroupId ? [{ memberId: "peer", displayName: "Peer" }] : [{ memberId: "human", displayName: "Alice" }])]
    },
    readRecentMessages: async (groupId) => [{ ...message(1, "old self reply", { groupId }), senderId: "bot", senderLabel: "Keet Bot", messageId: { deviceId: "device-bot", seq: 1 } }],
    watchMessages: (_group, handler) => {
      options.onWatch?.(handler, _group)
      let ended = false
      const listeners = new Set<(reason: "closed" | "connection-failed") => void>()
      const terminate = () => {
        if (ended) return
        ended = true
        for (const listener of listeners) listener("connection-failed")
      }
      options.onSubscription?.(terminate)
      if (options.failWatch) throw new Error("subscription unavailable")
      return {
        get closed() { return ended },
        onTerminate: (listener: (reason: "closed" | "connection-failed") => void) => { listeners.add(listener); return () => listeners.delete(listener) },
        close: async () => {
          if (ended) return
          ended = true
          for (const listener of listeners) listener("closed")
        },
      }
    },
    setUnreadAnchor: async () => undefined,
    updateTypingIndicator: async () => undefined,
    sendMessage: async (groupId, text, replyTo) => { sent.push({ groupId, text, ...(replyTo ? { replyTo } : {}) }); return { deviceId: "device-bot", seq: sent.length + 10 } },
    inspectInvitation: async () => ({ isRoomInvitation: true }),
    joinInvitation: async () => ({ groupId: settings.groupId }),
    listPendingDmRequests: async () => { if (options.pendingFailure) throw new Error("pending snapshot unavailable"); return options.pending ?? [] },
    acceptDmRequest: async () => ({ groupId: dmGroupId, roomType: "DirectMessage", dmMemberId: "peer" }),
    updateIdentityProfile: async () => undefined,
    updateDisplayName: async () => undefined,
    close: async () => { closed = true },
  }
  return core
}

function deps(core: KeetCore | undefined, agent?: KeetBridgeAgent, inspections: Record<string, any> = {}, configured = settings): KeetBridgeDependencies {
  return {
    getSettings: () => configured,
    workspaceRegistry: { get: () => ({ id: configured.workspaceId, path: "/workspace", sessionIds: Object.keys(inspections).length ? Object.keys(inspections) : ["session"] }), archivedSessionIds: new Set(["archived"]) },
    resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
    inspectSession: async (id) => inspections[id] ?? { meta: { id }, events: [{ type: "user/message", time: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "hello" }] } }] },
    resolveAgent: async () => agent ? { agent } : { error: new Error("agent unavailable") },
    ...(core ? { core } : {}),
  }
}

function makeAgent(onFollowup?: (message: unknown) => unknown, whenIdle: () => Promise<void> = async () => undefined): { agent: KeetBridgeAgent; tools: ToolDefinition[]; disposed: string[]; prompts: unknown[] } {
  const tools: ToolDefinition[] = []
  const disposed: string[] = []
  const prompts: unknown[] = []
  const agent: KeetBridgeAgent = {
    id: "session" as never,
    followup: async (message) => { prompts.push(message); return onFollowup?.(message) },
    whenIdle,
    ctx: {
      tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => disposed.push(tool.name) } },
      systemPrompt: { section: (section: { name: string }) => { disposed.push(section.name); return () => disposed.push(`policy:${section.name}`) } },
    } as never,
  }
  return { agent, tools, disposed, prompts }
}

async function flushBridge(): Promise<void> {
  // Bridge classification and destination queues are deliberately promise
  // based. A bounded microtask drain keeps these tests deterministic without
  // waiting on wall-clock timers.
  for (let index = 0; index < 96; index += 1) await Promise.resolve()
}

interface DmHarness {
  bridge: KeetBridge
  core: ReturnType<typeof fakeCore>
  fixture: ReturnType<typeof makeAgent>
  handlers: Map<string, (message: KeetMessage) => void>
}

function dmHarness(onFollowup?: (message: unknown) => unknown, coreOptions: Parameters<typeof fakeCore>[0] = {}): DmHarness {
  const handlers = new Map<string, (message: KeetMessage) => void>()
  const core = fakeCore({ dm: true, onWatch: (handler, groupId) => { handlers.set(groupId, handler) }, ...coreOptions })
  const fixture = makeAgent(onFollowup)
  const bridge = new KeetBridge(deps(core, fixture.agent, {}, { ...settings, dmMemberId: "peer" }))
  return { bridge, core, fixture, handlers }
}

function dmMessage(seq: number, text: string, extra: Partial<KeetMessage> = {}): KeetMessage {
  return message(seq, text, { groupId: dmGroupId, ...extra })
}

describe("Keet bridge", () => {
  it("initializes workspace-owned paths before onboarding has a joined room", async () => {
    let resolvedWorkspace: { path: string } | undefined
    let coreStarts = 0
    const bridge = new KeetBridge({
      ...deps(undefined, makeAgent().agent),
      getSettings: () => ({ workspaceId: "workspace", groupId: "" }),
      resolveRuntimePaths: async (workspace) => {
        resolvedWorkspace = workspace
        return { runtimeDir: "/runtime", identityDataDir: "/identity" }
      },
      coreFactory: async () => { coreStarts += 1; return fakeCore({ groups: [] }) },
    })
    await bridge.start()
    expect(resolvedWorkspace?.path).toBe("/workspace")
    expect(coreStarts).toBe(1)
    expect(bridge.readiness).toMatchObject({ state: "ready", workspaceId: "workspace", destinations: [] })
    await bridge.stop()
  })

  it("discovers all supported rooms, filters authorization failures, and collapses duplicate room IDs", async () => {
    const handlers = new Map<string, (message: KeetMessage) => void>()
    const core = fakeCore({
      groups: [
        { groupId: "group-one", roomType: "Default", title: "One" },
        { groupId: "group-one", roomType: "Default", title: "Duplicate" },
        { groupId: "group-two", roomType: "Default", title: "Two" },
        { groupId: "dm-accepted", roomType: "DirectMessage", title: "Accepted", dmMemberId: "peer-accepted" },
        { groupId: "dm-pending", roomType: "DirectMessage", title: "Pending", dmMemberId: "peer-pending" },
        { groupId: "broadcast", roomType: "Broadcast", title: "Broadcast" },
        { groupId: "incomplete", roomType: "DirectMessage", title: "Incomplete" },
        { groupId: "unknown", title: "Unknown" },
      ],
      pending: [{ memberId: "peer-pending" }],
      onWatch: (handler, groupId) => { handlers.set(groupId, handler) },
    })
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()

    expect(bridge.readiness).toMatchObject({ state: "ready", destinations: [
      { groupName: "One", kind: "group" },
      { groupName: "Two", kind: "group" },
      { groupName: "Accepted", kind: "dm" },
    ] })
    expect([...handlers.keys()]).toEqual(["group-one", "group-two", "dm-accepted"])
    const list = fixture.tools.find((tool) => tool.name === "keet_list_groups")!
    await expect(list.execute({}, undefined as never)).resolves.toEqual({ groups: [
      { groupName: "One", kind: "group" },
      { groupName: "Two", kind: "group" },
      { groupName: "Accepted", kind: "dm" },
    ] })
    const send = fixture.tools.find((tool) => tool.name === "keet_send_message")!
    await expect(send.execute({ groupName: "Two", text: "routed" }, undefined as never)).resolves.toEqual({ sent: true })
    expect(core.sent).toEqual([{ groupId: "group-two", text: "routed" }])
    await bridge.stop()
  })

  it("starts ready with an empty destination snapshot when no room is eligible", async () => {
    const core = fakeCore({ groups: [
      { groupId: "broadcast", roomType: "Broadcast", title: "Broadcast" },
      { groupId: "incomplete", roomType: "DirectMessage", title: "Incomplete" },
    ] })
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    expect(bridge.readiness).toMatchObject({ state: "ready", destinations: [] })
    const list = fixture.tools.find((tool) => tool.name === "keet_list_groups")!
    await expect(list.execute({}, undefined as never)).resolves.toEqual({ groups: [] })
    await bridge.stop()
  })

  it("locks the latest eligible existing session and registers only configured destination tools", async () => {
    const core = fakeCore()
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent, {
      older: { meta: { id: "older" }, events: [{ type: "user/message", time: 2, data: { source: { kind: "user" }, content: "old" } }] },
      newer: { meta: { id: "newer" }, events: [{ type: "user/message", time: 5, data: { source: { kind: "user" }, content: "new" } }] },
      archived: { meta: { id: "archived" }, events: [{ type: "user/message", time: 100, data: { source: { kind: "user" }, content: "ignored" } }] },
      subagent: { meta: { id: "subagent", origin: "subagent" }, events: [{ type: "user/message", time: 100, data: { source: { kind: "user" }, content: "ignored" } }] },
    }))
    await bridge.start()
    expect(bridge.readiness).toMatchObject({ state: "ready", sessionId: "newer", destinations: [{ groupName: "Test group", kind: "group" }] })
    expect(fixture.tools.map((tool) => tool.name)).toEqual(["keet_list_groups", "keet_list_members", "keet_read_recent_messages", "keet_send_message"])
    expect(fixture.disposed).toContain("dsh-keet:managed-group-policy")
    const handler = await bridgeRpcHandler(bridge)("readiness")
    expect(handler).toMatchObject({ ok: true, value: { state: "ready" } })
    await bridge.stop()
    expect(core.closed).toBe(true)
    expect(fixture.disposed).toEqual(expect.arrayContaining(["keet_list_members", "keet_read_recent_messages", "keet_send_message", "policy:dsh-keet:managed-group-policy"]))
  })

  it("buffers ordinary text and triggers one serialized turn on mention, label, or verified Keet replyTo relation", async () => {
    let deliver!: (message: KeetMessage) => void
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    deliver(message(2, "background context"))
    expect(fixture.prompts).toHaveLength(0)
    deliver(message(3, "hello", { mentions: ["bot"] }))
    deliver(message(4, "Keet Bot, are you there?"))
    deliver(message(5, "replying", { replyTo: { deviceId: "device-bot", seq: 1 } }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fixture.prompts).toHaveLength(3)
    const promptText = fixture.prompts.map((value: any) => JSON.stringify(value)).join("\n")
    expect(promptText).toContain("background context")
    expect(promptText).toContain("untrusted quoted data")
    expect(promptText).toContain("device-human")
    expect(core.sent).toHaveLength(0)
    await bridge.stop()
  })

  it("snapshots a named destination, routes sends through its internal group ID, and keeps native reply ownership", async () => {
    let deliver!: (message: KeetMessage) => void
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()

    const list = fixture.tools.find((tool) => tool.name === "keet_list_groups")!
    const groups = await list.execute({}, undefined as never) as { groups: Array<{ groupName: string; kind: string }> }
    expect(groups.groups).toEqual([{ groupName: "Test group", kind: "group" }])
    const send = fixture.tools.find((tool) => tool.name === "keet_send_message")!
    await expect(send.execute({ groupName: " Test group ", text: "agent-authored" }, undefined as never)).resolves.toEqual({ sent: true })
    expect(core.sent).toEqual([{ groupId: settings.groupId, text: "agent-authored" }])

    deliver(message(70, "native follow-up", { replyTo: { deviceId: "device-bot", seq: 11 } }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fixture.prompts).toHaveLength(1)
    const prompt = JSON.stringify(fixture.prompts[0])
    expect(prompt).toContain("native follow-up")
    expect(prompt).toContain("source group name")
    expect(prompt).not.toContain("sender_id")
    await bridge.stop()
  })

  it("fails a duplicate normalized destination name closed before a send reaches Core", async () => {
    const core = fakeCore({ dm: true, duplicateNames: true })
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent, {}, { ...settings, dmMemberId: "peer" }))
    await bridge.start()
    expect(bridge.readiness.state).toBe("ready")
    const send = fixture.tools.find((tool) => tool.name === "keet_send_message")!
    await expect(send.execute({ groupName: " Shared Name ", text: "must not send" }, undefined as never)).rejects.toThrow("no message was sent")
    expect(core.sent).toHaveLength(0)
    await bridge.stop()
  })

  it("records live self messages as reply ownership without buffering them", async () => {
    let deliver!: (message: KeetMessage) => void
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()

    const ownMessage: KeetMessage = {
      ...message(40, "integration response"),
      messageId: { deviceId: "device-bot", seq: 40 },
      senderId: "bot",
      senderLabel: "Keet Bot",
    }
    deliver(ownMessage)
    deliver(message(41, "human follow-up", { replyTo: ownMessage.messageId }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fixture.prompts).toHaveLength(1)
    expect(JSON.stringify(fixture.prompts[0])).toContain("human follow-up")
    expect(JSON.stringify(fixture.prompts[0])).not.toContain("integration response")
    expect(bridge.contextBuffers.get(settings.groupId)).toEqual([])
    await bridge.stop()
  })

  it("refreshes bounded history once for an unknown reply target and leaves unrelated replies ordinary", async () => {
    let deliver!: (message: KeetMessage) => void
    const recovered: KeetMessage = {
      ...message(50, "integration response"),
      messageId: { deviceId: "device-bot", seq: 50 },
      senderId: "bot",
      senderLabel: "Keet Bot",
    }
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    let reads = 0
    core.readRecentMessages = async () => {
      reads += 1
      return reads === 1 ? [] : [recovered]
    }
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()

    deliver(message(51, "recovered follow-up", { replyTo: recovered.messageId }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reads).toBe(2)
    expect(fixture.prompts).toHaveLength(1)

    deliver(message(52, "reply to another participant", { replyTo: { deviceId: "device-other", seq: 9 } }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fixture.prompts).toHaveLength(1)
    expect(bridge.contextBuffers.get(settings.groupId)?.map((record) => record.text)).toEqual(["reply to another participant"])
    await bridge.stop()
  })

  it("keeps callback classification in arrival order while reply history refresh is pending", async () => {
    let deliver!: (message: KeetMessage) => void
    let releaseHistory!: () => void
    const pendingHistory = new Promise<void>((resolve) => { releaseHistory = resolve })
    const recovered: KeetMessage = {
      ...message(60, "integration response"),
      messageId: { deviceId: "device-bot", seq: 60 },
      senderId: "bot",
      senderLabel: "Keet Bot",
    }
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    let reads = 0
    core.readRecentMessages = async () => {
      reads += 1
      if (reads === 1) return []
      await pendingHistory
      return [recovered]
    }
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()

    deliver(message(61, "first follow-up", { replyTo: recovered.messageId }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    deliver(message(62, "second mention", { mentions: ["bot"] }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reads).toBe(2)
    expect(fixture.prompts).toHaveLength(0)

    releaseHistory()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fixture.prompts).toHaveLength(2)
    expect(JSON.stringify(fixture.prompts[0])).toContain("first follow-up")
    expect(JSON.stringify(fixture.prompts[1])).toContain("second mention")
    await bridge.stop()
  })

  it("serializes turns, keeps messages arriving during a turn for the next buffer, and never auto-sends final text", async () => {
    let deliver!: (message: KeetMessage) => void
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const fixture = makeAgent(async () => { if (fixture.prompts.length === 1) await blocked })
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    deliver(message(2, "first", { mentions: ["bot"] }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    deliver(message(3, "between"))
    deliver(message(4, "second", { mentions: ["bot"] }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fixture.prompts).toHaveLength(1)
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fixture.prompts).toHaveLength(2)
    expect(JSON.stringify(fixture.prompts[1])).toContain("between")
    expect(core.sent).toHaveLength(0)
    await bridge.stop()
  })

  it("keeps the configured DM isolated, triggers every new external text once, and hides message provenance", async () => {
    const handlers = new Map<string, (message: KeetMessage) => void>()
    const core = fakeCore({ dm: true, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent, {}, { ...settings, dmMemberId: "peer" }))
    await bridge.start()
    expect(bridge.readiness).toMatchObject({ state: "ready", destinations: [{ groupName: "Test group", kind: "group" }, { groupName: "Managed DM", kind: "dm" }] })
    expect(fixture.tools.map((tool) => tool.name)).toEqual(["keet_list_groups", "keet_list_members", "keet_read_recent_messages", "keet_send_message"])

    const dmDeliver = handlers.get(dmGroupId)!
    const groupDeliver = handlers.get(settings.groupId)!
    dmDeliver(message(2, "self", { groupId: dmGroupId, senderId: "bot", senderLabel: "Keet Bot" }))
    dmDeliver(message(3, "private one", { groupId: dmGroupId }))
    dmDeliver(message(3, "private one", { groupId: dmGroupId }))
    groupDeliver(message(4, "group context"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fixture.prompts).toHaveLength(1)
    const dmPrompt = JSON.stringify(fixture.prompts[0])
    expect(dmPrompt).toContain("private one")
    expect(dmPrompt).toContain("Keet Managed DM messages — source group name=\\\"Managed DM\\\"")
    expect(dmPrompt).not.toContain("device-human")
    expect(dmPrompt).not.toContain("seq=3")
    expect(dmPrompt).not.toContain("sender_id")
    expect(dmPrompt).not.toContain("group context")

    groupDeliver(message(5, "group mention", { mentions: ["bot"] }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fixture.prompts).toHaveLength(2)
    expect(JSON.stringify(fixture.prompts[1])).toContain("group context")
    expect(JSON.stringify(fixture.prompts[1])).toContain("source group name=\\\"Test group\\\"")
    expect(JSON.stringify(fixture.prompts[1])).not.toContain("sender_id")
    await bridge.stop()
    expect(core.closed).toBe(true)
  })

  it("owns DM read and typing activity only for active work and stops it on a same-DM send", async () => {
    const handlers = new Map<string, (message: KeetMessage) => void>()
    const core = fakeCore({ dm: true, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
    const activity: Array<{ name: string; groupId: string; length?: number; signal: AbortSignal }> = []
    core.setUnreadAnchor = async (groupId, length, signal) => { activity.push({ name: "read", groupId, length, signal: signal! }) }
    core.updateTypingIndicator = async (groupId, signal) => { activity.push({ name: "typing", groupId, signal: signal! }) }
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const fixture = makeAgent(async () => pending)
    const bridge = new KeetBridge(deps(core, fixture.agent, {}, { ...settings, dmMemberId: "peer" }))
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    try {
      await bridge.start()
      const dmDeliver = handlers.get(dmGroupId)!
      dmDeliver(message(7, "private work", { groupId: dmGroupId, chatIndex: 41 }))
      vi.advanceTimersByTime(0)
      for (let index = 0; index < 6; index += 1) await Promise.resolve()
      expect(activity.map(({ name, groupId, length }) => ({ name, groupId, length }))).toEqual([
        { name: "read", groupId: dmGroupId, length: 42 },
        { name: "typing", groupId: dmGroupId, length: undefined },
      ])
      vi.advanceTimersByTime(4_000)
      expect(activity.map(({ name }) => name)).toEqual(["read", "typing", "typing"])
      bridge.markSent(dmGroupId, { deviceId: "device-bot", seq: 99 })
      vi.advanceTimersByTime(8_000)
      expect(activity.map(({ name }) => name)).toEqual(["read", "typing", "typing"])
      expect(activity[1]!.signal.aborted).toBe(true)
      release()
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
      await bridge.stop()
    }
  })

  it("keeps whitespace, casing, and argument DM /compact near-misses on the ordinary Agent path", async () => {
    const harness = dmHarness()
    const commandCalls: unknown[][] = []
    harness.fixture.agent.ctx = {
      ...harness.fixture.agent.ctx,
      commands: { execute: async (...args: unknown[]) => { commandCalls.push(args); return undefined } },
    } as never
    await harness.bridge.start()
    const nearMisses = [" /compact", "/COMPACT", "/compact ", "/compact now"]
    const deliver = harness.handlers.get(dmGroupId)!
    nearMisses.forEach((text, index) => deliver(dmMessage(index + 20, text, { chatIndex: index + 20 })))
    await flushBridge()

    expect(commandCalls).toHaveLength(0)
    expect(harness.fixture.prompts).toHaveLength(nearMisses.length)
    expect(harness.core.sent).toHaveLength(0)
    await harness.bridge.stop()
  })

  it("intercepts exact Managed DM /compact through the command service and sends one bounded result", async () => {
    const handlers = new Map<string, (message: KeetMessage) => void>()
    const core = fakeCore({ dm: true, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
    const fixture = makeAgent()
    const calls: unknown[][] = []
    fixture.agent.ctx = {
      ...fixture.agent.ctx,
      commands: { execute: async (...args: unknown[]) => { calls.push(args); return { commandId: "command-1", result: { kind: "success", text: "Compacted." } } } },
    } as never
    const bridge = new KeetBridge(deps(core, fixture.agent, {}, { ...settings, dmMemberId: "peer" }))
    await bridge.start()
    handlers.get(dmGroupId)!(message(8, "/compact", { groupId: dmGroupId, chatIndex: 8 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toBe("/compact")
    expect(calls[0]![2]).toEqual([])
    expect(calls[0]![0]).toBe(fixture.agent)
    expect(fixture.prompts).toHaveLength(0)
    expect(bridge.contextBuffers.get(dmGroupId)).toEqual([])
    expect(core.sent).toEqual([{ groupId: dmGroupId, text: "Compacted." }])
    await bridge.stop()
  })

  it("maps exact Managed DM /compact outcomes with one result-send attempt and no fallback Agent turn", async () => {
    const generic = "The /compact command is unavailable."
    const cases: readonly { name: string; expected: string; result?: unknown; failSend?: boolean }[] = [
      { name: "missing command", expected: generic },
      { name: "error/busy result", expected: "busy: compaction already active", result: { commandId: "command-error", result: { kind: "error", text: "busy: compaction already active" } } },
      { name: "no-text result", expected: generic, result: { commandId: "command-empty", result: { kind: "success" } } },
      { name: "empty-text result", expected: generic, result: { commandId: "command-blank", result: { kind: "success", text: "  " } } },
      { name: "result-send failure", expected: "Compacted.", result: { commandId: "command-send-failure", result: { kind: "success", text: "Compacted." } }, failSend: true },
    ]

    for (const testCase of cases) {
      const harness = dmHarness()
      const commandCalls: unknown[][] = []
      if (testCase.result !== undefined) {
        harness.fixture.agent.ctx = {
          ...harness.fixture.agent.ctx,
          commands: { execute: async (...args: unknown[]) => { commandCalls.push(args); return testCase.result } },
        } as never
      }
      let sendAttempts = 0
      const send = harness.core.sendMessage.bind(harness.core)
      harness.core.sendMessage = async (groupId, text, replyTo, signal) => {
        sendAttempts += 1
        if (testCase.failSend) throw new Error("result delivery failed")
        return send(groupId, text, replyTo, signal)
      }
      await harness.bridge.start()
      harness.handlers.get(dmGroupId)!(dmMessage(30, "/compact", { chatIndex: 30 }))
      await flushBridge()

      expect(commandCalls, testCase.name).toHaveLength(testCase.result === undefined ? 0 : 1)
      expect(sendAttempts, testCase.name).toBe(1)
      expect(harness.fixture.prompts, testCase.name).toHaveLength(0)
      expect(harness.bridge.contextBuffers.get(dmGroupId), testCase.name).toEqual([])
      expect(harness.core.sent, testCase.name).toEqual(testCase.failSend ? [] : [{ groupId: dmGroupId, text: testCase.expected }])
      await harness.bridge.stop()
    }
  })

  it("cancels an exact Managed DM /compact without sending, retrying, or entering a follow-up", async () => {
    const harness = dmHarness()
    let commandSignal!: AbortSignal
    let sendAttempts = 0
    harness.fixture.agent.ctx = {
      ...harness.fixture.agent.ctx,
      commands: {
        execute: async (_agent: unknown, _line: string, _images: readonly unknown[], signal: AbortSignal) => {
          commandSignal = signal
          return new Promise<never>((_resolve, reject) => {
            if (signal.aborted) { reject(new Error("command cancelled")); return }
            signal.addEventListener("abort", () => reject(new Error("command cancelled")), { once: true })
          })
        },
      },
    } as never
    const send = harness.core.sendMessage.bind(harness.core)
    harness.core.sendMessage = async (...args) => { sendAttempts += 1; return send(...args) }
    await harness.bridge.start()
    harness.handlers.get(dmGroupId)!(dmMessage(31, "/compact", { chatIndex: 31 }))
    await flushBridge()
    expect(commandSignal).toBeInstanceOf(AbortSignal)
    expect(harness.fixture.prompts).toHaveLength(0)

    await harness.bridge.stop()
    await flushBridge()
    expect(commandSignal.aborted).toBe(true)
    expect(sendAttempts).toBe(0)
    expect(harness.core.sent).toHaveLength(0)
  })

  it("suppresses self DM commands while leaving regular-group /compact handling unchanged", async () => {
    const harness = dmHarness()
    const commandCalls: unknown[][] = []
    const activityCalls: string[] = []
    harness.fixture.agent.ctx = {
      ...harness.fixture.agent.ctx,
      commands: { execute: async (...args: unknown[]) => { commandCalls.push(args); return { result: { kind: "success", text: "must not run" } } } },
    } as never
    harness.core.setUnreadAnchor = async () => { activityCalls.push("read") }
    harness.core.updateTypingIndicator = async () => { activityCalls.push("typing") }
    await harness.bridge.start()
    harness.handlers.get(dmGroupId)!(dmMessage(32, "/compact", { senderId: "bot", senderLabel: "Keet Bot", chatIndex: 32 }))
    harness.handlers.get(settings.groupId)!(message(33, "/compact", { mentions: ["bot"] }))
    await flushBridge()

    expect(commandCalls).toHaveLength(0)
    expect(harness.fixture.prompts).toHaveLength(1)
    expect(activityCalls).toEqual([])
    expect(harness.core.sent).toHaveLength(0)
    await harness.bridge.stop()
  })

  it("keeps queued DM work inactive and gives consecutive turns isolated activity owners", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    const secondPending = new Promise<void>((resolve) => { releaseSecond = resolve })
    let followups = 0
    const harness = dmHarness(async () => {
      followups += 1
      if (followups === 1) await firstPending
      if (followups === 2) await secondPending
    })
    const activity: Array<{ name: "read" | "typing"; length?: number; signal: AbortSignal }> = []
    harness.core.setUnreadAnchor = async (_groupId, length, signal) => { activity.push({ name: "read", length, signal: signal! }) }
    harness.core.updateTypingIndicator = async (_groupId, signal) => { activity.push({ name: "typing", signal: signal! }) }
    try {
      await harness.bridge.start()
      const deliver = harness.handlers.get(dmGroupId)!
      deliver(dmMessage(40, "first DM", { chatIndex: 40 }))
      await flushBridge()
      expect(harness.fixture.prompts).toHaveLength(1)

      deliver(dmMessage(41, "queued DM", { chatIndex: 41 }))
      await flushBridge()
      expect(activity.map(({ name, length }) => ({ name, length }))).toEqual([
        { name: "read", length: 41 },
        { name: "typing", length: undefined },
      ])
      expect(harness.fixture.prompts).toHaveLength(1)

      releaseFirst()
      await flushBridge()
      expect(harness.fixture.prompts).toHaveLength(2)
      expect(activity.map(({ name, length }) => ({ name, length }))).toEqual([
        { name: "read", length: 41 },
        { name: "typing", length: undefined },
        { name: "read", length: 42 },
        { name: "typing", length: undefined },
      ])
      const firstTyping = activity.find(({ name }) => name === "typing")!
      const secondTyping = activity.filter(({ name }) => name === "typing")[1]!
      expect(firstTyping.signal.aborted).toBe(true)
      expect(secondTyping.signal.aborted).toBe(false)
      expect(activity.find(({ name }) => name === "read")!.signal.aborted).toBe(false)

      vi.advanceTimersByTime(4_000)
      expect(activity.filter(({ name }) => name === "typing")).toHaveLength(3)
      harness.bridge.markSent(dmGroupId, { deviceId: "device-bot", seq: 140 })
      expect(secondTyping.signal.aborted).toBe(true)
      vi.advanceTimersByTime(8_000)
      expect(activity.filter(({ name }) => name === "typing")).toHaveLength(3)
      releaseSecond()
      await flushBridge()
    } finally {
      vi.useRealTimers()
      await harness.bridge.stop()
    }
  })

  it("stops DM typing ownership after both normal and failing follow-up settlement", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    try {
      for (const failing of [false, true]) {
        const harness = dmHarness(async () => { if (failing) throw new Error("follow-up failed") })
        const typingSignals: AbortSignal[] = []
        harness.core.updateTypingIndicator = async (_groupId, signal) => { typingSignals.push(signal!) }
        try {
          await harness.bridge.start()
          harness.handlers.get(dmGroupId)!(dmMessage(failing ? 51 : 50, "settling DM", { chatIndex: failing ? 51 : 50 }))
          await flushBridge()
          expect(harness.fixture.prompts).toHaveLength(1)
          expect(typingSignals).toHaveLength(1)
          expect(typingSignals[0]!.aborted).toBe(true)
          vi.advanceTimersByTime(12_000)
          expect(typingSignals).toHaveLength(1)
        } finally {
          await harness.bridge.stop()
        }
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it("aborts DM activity refresh on explicit stop and connection failure", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    try {
      const stopped = dmHarness(() => new Promise<void>(() => undefined))
      const stoppedTyping: AbortSignal[] = []
      stopped.core.updateTypingIndicator = async (_groupId, signal) => { stoppedTyping.push(signal!) }
      await stopped.bridge.start()
      stopped.handlers.get(dmGroupId)!(dmMessage(60, "stop me", { chatIndex: 60 }))
      await flushBridge()
      expect(stoppedTyping).toHaveLength(1)
      await stopped.bridge.stop()
      expect(stoppedTyping[0]!.aborted).toBe(true)
      vi.advanceTimersByTime(8_000)
      expect(stoppedTyping).toHaveLength(1)

      let terminate!: () => void
      const failed = dmHarness(() => new Promise<void>(() => undefined), { onSubscription: (close) => { terminate = close } })
      const failedTyping: AbortSignal[] = []
      failed.core.updateTypingIndicator = async (_groupId, signal) => { failedTyping.push(signal!) }
      await failed.bridge.start()
      failed.handlers.get(dmGroupId)!(dmMessage(61, "connection fails", { chatIndex: 61 }))
      await flushBridge()
      expect(failedTyping).toHaveLength(1)
      terminate()
      await flushBridge()
      expect(failed.bridge.readiness).toMatchObject({ state: "failed", detail: "connection-failed" })
      expect(failedTyping[0]!.aborted).toBe(true)
      vi.advanceTimersByTime(8_000)
      expect(failedTyping).toHaveLength(1)
      await failed.bridge.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps startup rollback free of DM activity ownership before readiness", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const activityCalls: string[] = []
    const core = fakeCore({ dm: true, failWatch: true })
    core.setUnreadAnchor = async () => { activityCalls.push("read") }
    core.updateTypingIndicator = async () => { activityCalls.push("typing") }
    const bridge = new KeetBridge(deps(core, makeAgent().agent, {}, { ...settings, dmMemberId: "peer" }))
    try {
      await bridge.start()
      expect(bridge.readiness).toMatchObject({ state: "failed", detail: "core-start-failed" })
      vi.advanceTimersByTime(8_000)
      expect(activityCalls).toEqual([])
    } finally {
      vi.useRealTimers()
      await bridge.stop()
    }
  })

  it("keeps rejected read and typing activity non-load-bearing for DM follow-up and explicit sends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const harness = dmHarness(async () => pending)
    let readCalls = 0
    let typingCalls = 0
    harness.core.setUnreadAnchor = async () => { readCalls += 1; throw new Error("read unavailable") }
    harness.core.updateTypingIndicator = async () => { typingCalls += 1; throw new Error("typing unavailable") }
    try {
      await harness.bridge.start()
      harness.handlers.get(dmGroupId)!(dmMessage(70, "work despite activity errors", { chatIndex: 70 }))
      await flushBridge()
      expect(harness.fixture.prompts).toHaveLength(1)
      expect(readCalls).toBe(1)
      expect(typingCalls).toBe(1)

      const send = harness.fixture.tools.find((tool) => tool.name === "keet_send_message")!
      await expect(send.execute({ groupName: "Managed DM", text: "explicit while busy" }, undefined as never)).resolves.toEqual({ sent: true })
      expect(harness.core.sent).toEqual([{ groupId: dmGroupId, text: "explicit while busy" }])
      vi.advanceTimersByTime(8_000)
      expect(typingCalls).toBe(1)
      release()
      await flushBridge()
    } finally {
      vi.useRealTimers()
      await harness.bridge.stop()
    }
  })

  it("starts through the real Integration Core and triggers exactly once for an external DM", async () => {
    const dataPath = await mkdtemp(path.join(tmpdir(), "keet-bridge-official-shape-dm-typed-compact-"))
    const core = await KeetIntegrationCore.start({ executablePath: nodeExecutable, bundlePath: fakeWorker, dataPath, swarming: false, startupTimeoutMs: 3_000, shutdownTimeoutMs: 1_000 })
    const configured = { groupId: "group-test", workspaceId: "workspace", dmMemberId: "member-peer" }
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent, {}, configured))
    try {
      await bridge.start()
      expect(bridge.readiness).toMatchObject({ state: "ready", destinations: [{ groupName: "Test group", kind: "group" }, { groupName: "Managed DM", kind: "dm" }] })

      // addChatMessage is the fixture's external-sender path. The actual Core
      // subscription and Bridge classifier must carry this DM through to the
      // Agent without a hand-written resolveDm seam.
      await new Promise((resolve) => setTimeout(resolve, 50))
      await core.sendMessage(dmGroupId, "[human] bridge integration DM")
      const deadline = Date.now() + 2_000
      while (fixture.prompts.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fixture.prompts).toHaveLength(1)
      expect(JSON.stringify(fixture.prompts[0])).toContain("bridge integration DM")
    } finally {
      await bridge.stop()
      await rm(dataPath, { recursive: true, force: true })
    }
  })

  it("fails closed when the pending DM authorization snapshot is unavailable", async () => {
    const core = fakeCore({ dm: true, pendingFailure: true })
    const bridge = new KeetBridge(deps(core, makeAgent().agent))
    await bridge.start()
    expect(bridge.readiness).toMatchObject({ state: "failed", detail: "core-start-failed" })
    expect(core.closed).toBe(true)
  })

  it("remains explicitly unbound without an eligible session and fails closed on terminal Core errors", async () => {
    const unboundCore = fakeCore()
    const unbound = new KeetBridge(deps(unboundCore, undefined, { blank: { meta: { id: "blank" }, events: [] } }))
    await unbound.start()
    expect(unbound.readiness.state).toBe("unbound")
    await unbound.stop()

    const errors: unknown[] = []
    const failedFixture = makeAgent()
    const failed = new KeetBridge({ ...deps(fakeCore({ fail: true }), failedFixture.agent), onError: (error) => errors.push(error) })
    await failed.start()
    expect(failed.readiness).toMatchObject({ state: "failed", detail: "core-start-failed" })
    expect(JSON.stringify(errors)).not.toContain("private provider")
    await failed.stop()
  })

  it("fails closed when the Integration Core identity is unavailable", async () => {
    const core = fakeCore({ missingIdentity: true })
    const bridge = new KeetBridge(deps(core, makeAgent().agent))
    await bridge.start()
    expect(bridge.readiness).toMatchObject({ state: "failed", detail: "core-start-failed" })
    expect(core.closed).toBe(true)
    expect(bridge.agent).toBeUndefined()
  })

  it("treats per-destination roster failures and missing self membership as optional enrichment", async () => {
    const scenarios: readonly { name: string; triggerGroup: string; rosterFailureGroup?: string; missingMembershipGroup?: string }[] = [
      { name: "roster failure", rosterFailureGroup: "group-one", triggerGroup: "group-two" },
      { name: "missing self", missingMembershipGroup: "group-two", triggerGroup: "group-one" },
    ]
    for (const scenario of scenarios) {
      const handlers = new Map<string, (message: KeetMessage) => void>()
      const core = fakeCore({
        groups: [
          { groupId: "group-one", roomType: "Default", title: "One" },
          { groupId: "group-two", roomType: "Default", title: "Two" },
        ],
        onWatch: (handler, groupId) => { handlers.set(groupId, handler) },
        ...(scenario.rosterFailureGroup ? { rosterFailureGroup: scenario.rosterFailureGroup } : {}),
        ...(scenario.missingMembershipGroup ? { missingMembershipGroup: scenario.missingMembershipGroup } : {}),
      })
      const fixture = makeAgent()
      const bridge = new KeetBridge(deps(core, fixture.agent))
      await bridge.start()

      expect(bridge.readiness, scenario.name).toMatchObject({ state: "ready", destinations: [{ groupName: "One", kind: "group" }, { groupName: "Two", kind: "group" }] })
      expect([...handlers.keys()], scenario.name).toEqual(["group-one", "group-two"])
      handlers.get(scenario.triggerGroup)!(message(80, `${scenario.name} trigger`, { groupId: scenario.triggerGroup, mentions: ["bot"] }))
      await flushBridge()
      expect(fixture.prompts, scenario.name).toHaveLength(1)
      expect(JSON.stringify(fixture.prompts[0]), scenario.name).toContain(`${scenario.name} trigger`)
      await bridge.stop()
    }
  })

  it("serializes group and accepted-DM triggers through one Agent queue with source-specific prompts", async () => {
    const handlers = new Map<string, (message: KeetMessage) => void>()
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    let followups = 0
    const fixture = makeAgent(async () => {
      followups += 1
      if (followups === 1) await firstPending
    })
    const core = fakeCore({ dm: true, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()

    handlers.get(settings.groupId)!(message(81, "group trigger", { mentions: ["bot"] }))
    await flushBridge()
    expect(fixture.prompts).toHaveLength(1)
    expect(JSON.stringify(fixture.prompts[0])).toContain("source group name=\\\"Test group\\\"")

    handlers.get(dmGroupId)!(dmMessage(82, "accepted DM trigger"))
    await flushBridge()
    expect(fixture.prompts).toHaveLength(1)

    releaseFirst()
    await flushBridge()
    expect(followups).toBe(2)
    expect(fixture.prompts).toHaveLength(2)
    expect(JSON.stringify(fixture.prompts[1])).toContain("accepted DM trigger")
    expect(JSON.stringify(fixture.prompts[1])).toContain("source group name=\\\"Managed DM\\\"")
    await bridge.stop()
  })

  it("releases bridge-owned Core state without disposing the shared Agent when startup fails", async () => {
    for (const failure of [{ fail: true }, { pendingFailure: true }, { failWatch: true }]) {
      const core = fakeCore(failure)
      const fixture = makeAgent()
      const bridge = new KeetBridge(deps(core, fixture.agent))
      await bridge.start()
      expect(bridge.agent, JSON.stringify(failure)).toBeUndefined()
      expect(bridge.readiness, JSON.stringify(failure)).toMatchObject({ state: "failed", detail: "core-start-failed" })
      expect(core.closed, JSON.stringify(failure)).toBe(true)
    }
  })

  it("closes a Core acquired after an immediate stop and never installs late ownership", async () => {
    const fixture = makeAgent()
    const lateCore = fakeCore()
    let resolveCore!: (core: KeetCore) => void
    let factoryStarted!: () => void
    const coreFactoryStarted = new Promise<void>((resolve) => { factoryStarted = resolve })
    const delayedCore = new Promise<KeetCore>((resolve) => { resolveCore = resolve })
    let receivedOptions: Record<string, unknown> | undefined
    const base = deps(undefined, fixture.agent)
    const bridge = new KeetBridge({
      ...base,
      coreFactory: async (options) => {
        receivedOptions = options as unknown as Record<string, unknown>
        factoryStarted()
        return delayedCore
      },
    })
    const started = bridge.start()
    await coreFactoryStarted
    await bridge.stop()
    expect(receivedOptions).toMatchObject({ executablePath: "/runtime/bare", bundlePath: "/runtime/core-worker.bundle", dataPath: "/identity", appVersion: "4.21.0", expectedCoreVersion: "4.21.5", expectedAbi: 35 })
    expect(bridge.readiness.state).toBe("disabled")
    expect(bridge.core).toBeUndefined()

    resolveCore(lateCore)
    await started
    expect(lateCore.closed).toBe(true)
    expect(bridge.core).toBeUndefined()
  })

  it("stops promptly while a followup and whenIdle remain permanently pending", async () => {
    const pending = new Promise<never>(() => undefined)
    let deliver!: (message: KeetMessage) => void
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    const fixture = makeAgent(() => pending, () => pending)
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    deliver(message(2, "please answer", { mentions: ["bot"] }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fixture.prompts).toHaveLength(1)

    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stop timed out")), 100))
    await Promise.race([bridge.stop(), timeout])
    expect(core.closed).toBe(true)
    expect(bridge.core).toBeUndefined()
  })

  it("fails closed on a terminal subscription and rejects retained tools before mutation", async () => {
    let terminate!: () => void
    const core = fakeCore({ onSubscription: (stop) => { terminate = stop } })
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    expect(bridge.readiness.state).toBe("ready")
    const send = fixture.tools.find((tool) => tool.name === "keet_send_message")!
    terminate()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridge.readiness).toMatchObject({ state: "failed", detail: "connection-failed" })
    expect(bridge.agent).toBeUndefined()
    await expect(send.execute({ groupName: "Test group", text: "must not send" }, undefined as never)).rejects.toThrow("bridge is not ready")
    expect(core.sent).toHaveLength(0)
  })

  it("reports tool registration failure separately and does not retain Core ownership", async () => {
    const core = fakeCore()
    const fixture = makeAgent()
    fixture.agent.ctx = { tools: { register: () => { throw new Error("register failed") } } } as never
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    expect(bridge.readiness.detail).toBe("tool-registration-failed")
    expect(core.closed).toBe(true)
    expect(bridge.agent).toBeUndefined()
  })

  it("fails closed when the Active Conversation cannot install its system-prompt policy", async () => {
    const core = fakeCore()
    const fixture = makeAgent()
    fixture.agent.ctx = { tools: fixture.agent.ctx?.tools } as never
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    expect(bridge.readiness.detail).toBe("tool-registration-failed")
    expect(fixture.tools).toHaveLength(0)
    expect(core.closed).toBe(true)
    expect(bridge.agent).toBeUndefined()
  })
})
