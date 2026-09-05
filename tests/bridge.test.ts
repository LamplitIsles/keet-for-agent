import { describe, expect, it } from "vitest"
import type { ToolDefinition } from "@deepseek-ai/dsh-tools"
import { KeetBridge, bridgeRpcHandler, type KeetBridgeAgent, type KeetBridgeDependencies } from "../packages/dsh-keet/src/bridge.js"
import type { KeetCore, KeetMessage, KeetMessageId } from "../packages/dsh-keet/src/core-contract.js"

const settings = { groupId: "group-fixed", workspaceId: "workspace" }

function message(seq: number, text: string, extra: Partial<KeetMessage> = {}): KeetMessage {
  return { messageId: { deviceId: "device-human", seq }, groupId: settings.groupId, senderId: "human", senderLabel: "Alice", timestamp: seq, text, ...extra }
}

function fakeCore(options: { onWatch?: (handler: (message: KeetMessage) => void) => void; onSubscription?: (terminate: () => void) => void; fail?: boolean; failGroup?: boolean; failWatch?: boolean; missingIdentity?: boolean; missingMembership?: boolean } = {}): KeetCore & { sent: Array<{ groupId: string; text: string; replyTo?: KeetMessageId }>; closed: boolean } {
  const sent: Array<{ groupId: string; text: string; replyTo?: KeetMessageId }> = []
  let closed = false
  const core: KeetCore & { sent: typeof sent; closed: boolean } = {
    sent,
    get closed() { return closed },
    status: async () => {
      if (options.fail) throw new Error("private provider output")
      return { state: "ready", appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: false, identityId: options.missingIdentity ? "" : "bot", displayName: "Keet Bot" }
    },
    listGroups: async () => [{ groupId: settings.groupId }],
    validateGroup: async (groupId) => { if (options.failGroup) throw new Error("group unavailable"); return { groupId } },
    listMembers: async () => [...(options.missingMembership ? [] : [{ memberId: "bot", displayName: "Keet Bot" }]), { memberId: "human", displayName: "Alice" }],
    readRecentMessages: async () => [{ ...message(1, "old self reply"), senderId: "bot", senderLabel: "Keet Bot", messageId: { deviceId: "device-bot", seq: 1 } }],
    watchMessages: (_group, handler) => {
      options.onWatch?.(handler)
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
    sendMessage: async (groupId, text, replyTo) => { sent.push({ groupId, text, ...(replyTo ? { replyTo } : {}) }); return { deviceId: "device-bot", seq: sent.length + 10 } },
    inspectInvitation: async () => ({ isRoomInvitation: true }),
    joinInvitation: async () => ({ groupId: settings.groupId }),
    updateDisplayName: async () => undefined,
    close: async () => { closed = true },
  }
  return core
}

function deps(core: KeetCore | undefined, agent?: KeetBridgeAgent, inspections: Record<string, any> = {}): KeetBridgeDependencies {
  return {
    getSettings: () => settings,
    workspaceRegistry: { get: () => ({ id: settings.workspaceId, path: "/workspace", sessionIds: Object.keys(inspections).length ? Object.keys(inspections) : ["session"] }), archivedSessionIds: new Set(["archived"]) },
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

describe("Keet bridge", () => {
  it("initializes workspace-owned paths before onboarding has a group ID", async () => {
    let resolvedWorkspace: { path: string } | undefined
    let coreStarts = 0
    const bridge = new KeetBridge({
      ...deps(undefined),
      getSettings: () => ({ workspaceId: "workspace", groupId: "" }),
      resolveRuntimePaths: async (workspace) => {
        resolvedWorkspace = workspace
        return { runtimeDir: "/runtime", identityDataDir: "/identity" }
      },
      coreFactory: async () => { coreStarts += 1; throw new Error("must not start") },
    })
    await bridge.start()
    expect(resolvedWorkspace?.path).toBe("/workspace")
    expect(coreStarts).toBe(0)
    expect(bridge.readiness).toMatchObject({ state: "missing-settings", workspaceId: "workspace" })
    await bridge.stop()
  })

  it("locks the latest eligible existing session and registers only fixed-group tools", async () => {
    const core = fakeCore()
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent, {
      older: { meta: { id: "older" }, events: [{ type: "user/message", time: 2, data: { source: { kind: "user" }, content: "old" } }] },
      newer: { meta: { id: "newer" }, events: [{ type: "user/message", time: 5, data: { source: { kind: "user" }, content: "new" } }] },
      archived: { meta: { id: "archived" }, events: [{ type: "user/message", time: 100, data: { source: { kind: "user" }, content: "ignored" } }] },
      subagent: { meta: { id: "subagent", origin: "subagent" }, events: [{ type: "user/message", time: 100, data: { source: { kind: "user" }, content: "ignored" } }] },
    }))
    await bridge.start()
    expect(bridge.readiness).toMatchObject({ state: "ready", sessionId: "newer", groupId: settings.groupId })
    expect(fixture.tools.map((tool) => tool.name)).toEqual(["keet_list_members", "keet_read_recent_messages", "keet_send_message"])
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
    expect(bridge.contextBuffer).toHaveLength(0)
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
    expect(bridge.contextBuffer.map((record) => record.text)).toEqual(["reply to another participant"])
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

  it("fails closed unless the integration identity is a current group member", async () => {
    for (const failure of [{ missingIdentity: true }, { missingMembership: true }]) {
      const core = fakeCore(failure)
      const bridge = new KeetBridge(deps(core, makeAgent().agent))
      await bridge.start()
      expect(bridge.readiness, JSON.stringify(failure)).toMatchObject({ state: "failed", detail: "core-start-failed" })
      expect(core.closed, JSON.stringify(failure)).toBe(true)
      expect(bridge.agent).toBeUndefined()
    }
  })

  it("releases bridge-owned Core state without disposing the shared Agent when startup fails", async () => {
    for (const failure of [{ fail: true }, { failGroup: true }, { failWatch: true }]) {
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
    await expect(send.execute({ text: "must not send" }, undefined as never)).rejects.toThrow("bridge is not ready")
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
