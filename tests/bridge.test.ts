import { describe, expect, it, vi } from "vitest"
import type { ToolDefinition } from "@deepseek-ai/dsh-tools"
import { KeetBridge, bridgeRpcHandler, type KeetBridgeAgent, type KeetBridgeDependencies } from "../packages/dsh-keet/src/bridge.js"
import type { KeetCore, KeetMember, KeetMessage, KeetMessageId, ManagedGroup, KeetPendingDmRequest } from "../packages/dsh-keet/src/core-contract.js"

const settings: { groupId: string; workspaceId: string; dmMemberId?: string } = { groupId: "group-fixed", workspaceId: "workspace" }
const dmGroupId = "group-dm"
type MemberJoinTestSettings = typeof settings & { memberJoinTriggers: Record<string, Record<string, boolean>> }

function memberJoinSettings(...groupIds: string[]): MemberJoinTestSettings {
  return { ...settings, memberJoinTriggers: { [settings.workspaceId]: Object.fromEntries(groupIds.map((groupId) => [groupId, true])) } }
}

function settingsWatcher(initial: MemberJoinTestSettings): { get: () => MemberJoinTestSettings; watch: (listener: (next: unknown, previous: unknown) => void) => () => void; publish: (next: MemberJoinTestSettings) => void } {
  let current = initial
  const listeners = new Set<(next: unknown, previous: unknown) => void>()
  return {
    get: () => current,
    watch: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    publish: (next) => {
      const previous = current
      current = next
      for (const listener of [...listeners]) listener(next, previous)
    },
  }
}

function message(seq: number, text: string, extra: Partial<KeetMessage> = {}): KeetMessage {
  return { messageId: { deviceId: "device-human", seq }, groupId: settings.groupId, senderId: "human", senderLabel: "Alice", timestamp: seq, text, ...extra }
}

function fakeCore(options: { onWatch?: (handler: (message: KeetMessage) => void, groupId: string) => void; onSubscription?: (terminate: () => void) => void; onListMembers?: (groupId: string) => void; membersFor?: (groupId: string) => readonly KeetMember[]; fail?: boolean; failWatch?: boolean; missingIdentity?: boolean; missingDisplayName?: boolean; dm?: boolean; duplicateNames?: boolean; groups?: ManagedGroup[]; pending?: KeetPendingDmRequest[]; pendingFailure?: boolean; pendingMalformed?: "envelope" | "entry" } = {}): KeetCore & { sent: Array<{ groupId: string; text: string; replyTo?: KeetMessageId }>; closed: boolean } {
  const sent: Array<{ groupId: string; text: string; replyTo?: KeetMessageId }> = []
  let closed = false
  const core: KeetCore & { sent: typeof sent; closed: boolean } = {
    sent,
    get closed() { return closed },
    status: async () => {
      if (options.fail) throw new Error("private provider output")
      return { state: "ready", appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: false, identityId: options.missingIdentity ? "" : "bot", ...(options.missingDisplayName ? {} : { displayName: "Keet Bot" }) }
    },
    listGroups: async () => options.groups ?? [{ groupId: settings.groupId, roomType: "Default", title: options.duplicateNames ? " Shared\nName " : "Test group" }, ...(options.dm ? [{ groupId: dmGroupId, roomType: "DirectMessage" as const, title: options.duplicateNames ? "Shared Name" : "Managed DM", dmMemberId: "peer" }] : [])],
    resolveDm: async () => ({ groupId: dmGroupId, roomType: "DirectMessage", dmMemberId: "peer", title: options.duplicateNames ? "Shared\nName" : "Managed DM" }),
    listMembers: async (groupId) => {
      options.onListMembers?.(groupId)
      if (options.membersFor) return [...options.membersFor(groupId)]
      return [{ memberId: "bot", displayName: "Keet Bot" }, ...(groupId === dmGroupId ? [{ memberId: "peer", displayName: "Peer" }] : [{ memberId: "human", displayName: "Alice" }])]
    },
    readRecentMessages: async (groupId) => [{ ...message(1, "old self reply", { groupId }), senderId: "bot", senderLabel: "Keet Bot", messageId: { deviceId: "device-bot", seq: 1 } }],
    readImage: async () => new Uint8Array([1]),
    sendImage: async () => undefined,
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
    addReaction: async () => undefined,
    sendMessage: async (groupId, text, replyTo) => { sent.push({ groupId, text, ...(replyTo ? { replyTo } : {}) }); return { deviceId: "device-bot", seq: sent.length + 10 } },
    inspectInvitation: async () => ({ isRoomInvitation: true }),
    leaveGroup: async () => undefined,
    joinInvitation: async () => ({ groupId: settings.groupId }),
    listPendingDmRequests: async () => {
      if (options.pendingFailure) throw new Error("pending snapshot unavailable")
      if (options.pendingMalformed === "envelope") throw new Error("invalid pending DM request snapshot")
      if (options.pendingMalformed === "entry") throw new Error("invalid pending DM request")
      return options.pending ?? []
    },
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

type FollowupAdmission = "admit" | "claim-only" | "discard"
type TurnEndKind = "completed" | "blocked" | "aborted" | "error"

function makeAgent(onFollowup?: (message: unknown) => unknown, whenIdle: () => Promise<void> = async () => undefined, options: { followupAdmission?: FollowupAdmission } = {}): { agent: KeetBridgeAgent; tools: ToolDefinition[]; disposed: string[]; prompts: unknown[]; emitClaim: (message: unknown, turn: number, admitted?: boolean) => void; emitTurnEnd: (turn: number, reason?: TurnEndKind) => void; setFollowupAdmission: (admission: FollowupAdmission) => void } {
  const tools: ToolDefinition[] = []
  const disposed: string[] = []
  const prompts: unknown[] = []
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const session = { id: "session" }
  const openTurns = new Set<number>()
  let nextTurn = 0
  let followupAdmission = options.followupAdmission ?? "admit"
  const emit = (name: string, ...args: unknown[]): void => {
    for (const listener of [...listeners.get(name) ?? []]) listener(...args)
  }
  const emitClaim = (message: unknown, turn: number, admitted = true): void => {
    openTurns.add(turn)
    emit("agent/inbox/claimed", { agent, message, turn })
    if (admitted) emit("session/event", session, { type: "user/message", data: message })
  }
  const emitTurnEnd = (turn: number, reason: TurnEndKind = "completed"): void => {
    openTurns.delete(turn)
    emit("session/event", session, { type: "turn/end", data: { turn, reason: { kind: reason } } })
  }
  const agent: KeetBridgeAgent = {
    id: "session" as never,
    followup: async (message) => {
      prompts.push(message)
      if (followupAdmission === "admit") emitClaim(message, ++nextTurn)
      else if (followupAdmission === "claim-only") emitClaim(message, ++nextTurn, false)
      else if (followupAdmission === "discard") emit("agent/inbox/discarded", { agent, message })
      return onFollowup?.(message)
    },
    whenIdle: async () => {
      let reason: TurnEndKind = "completed"
      try { await whenIdle() } catch (error) { reason = "error"; throw error }
      finally { for (const turn of [...openTurns]) emitTurnEnd(turn, reason) }
    },
    ctx: {
      tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => disposed.push(tool.name) } },
      systemPrompt: { section: (section: { name: string }) => { disposed.push(section.name); return () => disposed.push(`policy:${section.name}`) } },
      on: (name: string, listener: (...args: unknown[]) => void) => {
        const registered = listeners.get(name) ?? new Set<(...args: unknown[]) => void>()
        registered.add(listener)
        listeners.set(name, registered)
        return () => { registered.delete(listener); return true }
      },
    } as never,
  }
  return { agent, tools, disposed, prompts, emitClaim, emitTurnEnd, setFollowupAdmission: (admission) => { followupAdmission = admission } }
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

function inboxEvents(messageValue: unknown, outcome?: "canceled"): Array<{ type: string; data: Record<string, unknown> }> {
  return [
    { type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [messageValue] } },
    { type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, removedCount: 1, inserted: [], ...(outcome ? { outcome } : {}) } },
  ]
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
      { groupName: "Broadcast", kind: "broadcast" },
    ] })
    expect([...handlers.keys()]).toEqual(["group-one", "group-two", "dm-accepted"])
    const list = fixture.tools.find((tool) => tool.name === "keet_list_groups")!
    await expect(list.execute({}, undefined as never)).resolves.toEqual({ groups: [
      { groupName: "One", kind: "group" },
      { groupName: "Two", kind: "group" },
      { groupName: "Accepted", kind: "dm" },
      { groupName: "Broadcast", kind: "broadcast" },
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
    expect(bridge.readiness).toMatchObject({ state: "ready", destinations: [{ groupName: "Broadcast", kind: "broadcast" }] })
    const list = fixture.tools.find((tool) => tool.name === "keet_list_groups")!
    await expect(list.execute({}, undefined as never)).resolves.toEqual({ groups: [{ groupName: "Broadcast", kind: "broadcast" }] })
    await bridge.stop()
  })

  it("joins and admits a new regular group through human RPC without rebuilding existing intake", async () => {
    const groups: ManagedGroup[] = [{ groupId: settings.groupId, roomType: "Default", title: "Existing" }]
    const handlers = new Map<string, (message: KeetMessage) => void>()
    let joinCalls = 0
    const core = fakeCore({ groups, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
    core.joinInvitation = async () => {
      joinCalls += 1
      groups.push({ groupId: "joined-live", roomType: "Default", title: "Joined live" })
      return { groupId: "joined-live" }
    }
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    const existingHandler = handlers.get(settings.groupId)
    const response = await bridgeRpcHandler(bridge)("onboarding", { workspaceId: "workspace", operation: "join", invitation: "keet://chat/live-invite" }, new AbortController().signal)
    expect(response).toEqual({ ok: true, value: { status: "admitted", destination: { groupName: "Joined live", kind: "group" } } })
    expect(joinCalls).toBe(1)
    expect(handlers.get(settings.groupId)).toBe(existingHandler)
    expect(handlers.has("joined-live")).toBe(true)
    const list = fixture.tools.find((tool) => tool.name === "keet_list_groups")!
    await expect(list.execute({}, undefined as never)).resolves.toEqual({ groups: [{ groupName: "Existing", kind: "group" }, { groupName: "Joined live", kind: "group" }] })

    handlers.get("joined-live")!({ ...message(20, "after live admission", { groupId: "joined-live", mentions: ["bot"] }) })
    await flushBridge()
    expect(fixture.prompts).toHaveLength(1)
    expect(JSON.stringify(fixture.prompts[0])).toContain("after live admission")

    const duplicate = await bridgeRpcHandler(bridge)("onboarding", { workspaceId: "workspace", operation: "join", invitation: "keet://chat/live-invite" }, new AbortController().signal)
    expect(duplicate).toEqual(response)
    expect(joinCalls).toBe(1)
    await bridge.stop()
  })

  it("cleans up a dynamic destination canceled during history priming", async () => {
    const groups: ManagedGroup[] = [{ groupId: settings.groupId, roomType: "Default", title: "Existing" }]
    const handlers = new Map<string, (message: KeetMessage) => void>()
    let releasePrime!: () => void
    let signalPrimeStarted!: () => void
    const primeGate = new Promise<void>((resolve) => { releasePrime = resolve })
    const primeStarted = new Promise<void>((resolve) => { signalPrimeStarted = resolve })
    const core = fakeCore({ groups, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
    const readRecentMessages = core.readRecentMessages.bind(core)
    core.readRecentMessages = async (groupId, last, signal) => {
      if (groupId === "joined-during-prime") {
        signalPrimeStarted()
        await primeGate
      }
      return readRecentMessages(groupId, last, signal)
    }
    core.joinInvitation = async () => {
      groups.push({ groupId: "joined-during-prime", roomType: "Default", title: "Canceled" })
      return { groupId: "joined-during-prime" }
    }
    const bridge = new KeetBridge(deps(core, makeAgent().agent))
    await bridge.start()

    const controller = new AbortController()
    const operation = bridgeRpcHandler(bridge)("onboarding", { workspaceId: "workspace", operation: "join", invitation: "keet://chat/cancel-during-prime" }, controller.signal)
    await primeStarted
    controller.abort()
    releasePrime()

    await expect(operation).resolves.toMatchObject({ ok: false, error: { code: "canceled" } })
    expect(bridge.destinations).toEqual([{ groupName: "Existing", kind: "group" }])
    expect(handlers.has("joined-during-prime")).toBe(false)
    expect(bridge.contextBuffers.has("joined-during-prime")).toBe(false)
    await bridge.stop()
  })

  it("retains recovered reaction receipts when a room is admitted dynamically", async () => {
    const joinedGroupId = "joined-with-receipt"
    const groups: ManagedGroup[] = [{ groupId: settings.groupId, roomType: "Default", title: "Existing" }]
    const handlers = new Map<string, (message: KeetMessage) => void>()
    const receipt = `dsh-keet/reaction:${JSON.stringify([joinedGroupId, "device-bot", 1, "👍", 1])}`
    const recoveredRequest = {
      role: "user",
      id: "recovered-reaction-request",
      source: { kind: "user" },
      content: [{ type: "text", text: "recovered reaction" }],
      __dshKeetReactionReceipts: [receipt],
    }
    const core = fakeCore({ groups, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
    core.joinInvitation = async () => {
      groups.push({ groupId: joinedGroupId, roomType: "Default", title: "Recovered" })
      return { groupId: joinedGroupId }
    }
    core.readRecentMessages = async (groupId) => [{ ...message(1, "integration-authored", {
      groupId,
      messageId: { deviceId: "device-bot", seq: 1 },
      senderId: "bot",
      senderLabel: "Keet Bot",
      reactions: [{ emoji: "👍", count: 1, own: false }],
    }) }]
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent, {
      active: { meta: { id: "active" }, events: [{ type: "user/message", time: 1, data: { source: { kind: "user" }, content: "active" } }] },
      archived: { meta: { id: "archived" }, events: inboxEvents(recoveredRequest) },
    }))
    await bridge.start()

    const response = await bridgeRpcHandler(bridge)("onboarding", { workspaceId: "workspace", operation: "join", invitation: "keet://chat/recovered-receipt" }, new AbortController().signal)
    expect(response).toEqual({ ok: true, value: { status: "admitted", destination: { groupName: "Recovered", kind: "group" } } })
    handlers.get(joinedGroupId)!({ ...message(20, "dynamic trigger", { groupId: joinedGroupId, mentions: ["bot"] }) })
    await flushBridge()

    expect(fixture.prompts).toHaveLength(1)
    expect(JSON.stringify(fixture.prompts[0])).not.toContain('emoji="👍" count="1"')
    await bridge.stop()
  })

  it("accepts an exact pending DM through human RPC and admits only the returned room", async () => {
    const groups: ManagedGroup[] = [{ groupId: settings.groupId, roomType: "Default", title: "Existing" }]
    let pending: KeetPendingDmRequest[] = [{ memberId: "peer-exact", displayName: "Same name" }]
    const handlers = new Map<string, (message: KeetMessage) => void>()
    let acceptCalls = 0
    const core = fakeCore({ groups, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
    core.listPendingDmRequests = async () => pending
    core.acceptDmRequest = async (memberId) => {
      acceptCalls += 1
      expect(memberId).toBe("peer-exact")
      pending = []
      groups.push({ groupId: "dm-live", roomType: "DirectMessage", title: "Same name", dmMemberId: memberId })
      return { groupId: "dm-live", roomType: "DirectMessage", title: "Same name", dmMemberId: memberId }
    }
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    expect(bridge.destinations).toEqual([{ groupName: "Existing", kind: "group" }])
    const rpc = bridgeRpcHandler(bridge)
    const pendingResponse = await rpc("onboarding", { workspaceId: "workspace", operation: "list-pending-dm-requests" }, new AbortController().signal)
    expect(pendingResponse).toMatchObject({ ok: true, value: { status: "ready", requests: [{ memberId: "peer-exact", displayName: "Same name", identityHint: expect.stringMatching(/^#[0-9a-f]{8}$/) }] } })
    const accepted = await rpc("onboarding", { workspaceId: "workspace", operation: "accept-dm", memberId: "peer-exact" }, new AbortController().signal)
    expect(accepted).toEqual({ ok: true, value: { status: "admitted", destination: { groupName: "Same name", kind: "dm" } } })
    expect(acceptCalls).toBe(1)
    expect(handlers.has("dm-live")).toBe(true)
    handlers.get("dm-live")!({ ...dmMessage(21, "new DM after acceptance"), groupId: "dm-live" })
    await flushBridge()
    expect(fixture.prompts).toHaveLength(1)
    expect(JSON.stringify(fixture.prompts[0])).toContain("new DM after acceptance")
    await bridge.stop()
  })

  it("returns an admission-only retry after native join success without repeating the mutation", async () => {
    const groups: ManagedGroup[] = [{ groupId: settings.groupId, roomType: "Default", title: "Existing" }]
    const core = fakeCore({ groups })
    let joinCalls = 0
    let listCalls = 0
    core.joinInvitation = async () => {
      joinCalls += 1
      groups.push({ groupId: "joined-partial", roomType: "Broadcast", title: "Partial broadcast" })
      return { groupId: "joined-partial" }
    }
    const originalListGroups = async () => groups
    core.listGroups = async () => {
      listCalls += 1
      if (listCalls === 2) throw new Error("room list temporarily unavailable")
      return originalListGroups()
    }
    const bridge = new KeetBridge(deps(core, makeAgent().agent))
    await bridge.start()
    const rpc = bridgeRpcHandler(bridge)
    const first = await rpc("onboarding", { workspaceId: "workspace", operation: "join", invitation: "keet://chat/partial" }, new AbortController().signal)
    expect(first).toMatchObject({ ok: true, value: { status: "partial", operation: "join", retryToken: expect.any(String) } })
    expect(JSON.stringify(first)).not.toContain("joined-partial")
    const retryToken = (first as { ok: true; value: { retryToken: string } }).value.retryToken
    const retried = await rpc("onboarding", { workspaceId: "workspace", operation: "retry-admission", retryToken, }, new AbortController().signal)
    expect(retried).toEqual({ ok: true, value: { status: "admitted", destination: { groupName: "Partial broadcast", kind: "broadcast" } } })
    expect(joinCalls).toBe(1)
    await bridge.stop()
  })

  it("does not publish a late admission after the bridge stops", async () => {
    const groups: ManagedGroup[] = [{ groupId: settings.groupId, roomType: "Default", title: "Existing" }]
    const gate = new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    const core = fakeCore({ groups })
    core.joinInvitation = async () => { await gate; groups.push({ groupId: "late", roomType: "Default", title: "Late" }); return { groupId: "late" } }
    const bridge = new KeetBridge(deps(core, makeAgent().agent))
    await bridge.start()
    const operation = bridgeRpcHandler(bridge)("onboarding", { workspaceId: "workspace", operation: "join", invitation: "keet://chat/late" }, new AbortController().signal)
    await bridge.stop()
    await expect(operation).resolves.toMatchObject({ ok: false, error: { code: "canceled" } })
    expect(bridge.destinations).toEqual([{ groupName: "Existing", kind: "group" }])
  })

  it("routes Managed Broadcast reads and plain-text posts without state or subscriptions", async () => {
    const handlers = new Map<string, (message: KeetMessage) => void>()
    let memberReads = 0
    const core = fakeCore({
      groups: [{ groupId: "broadcast", roomType: "Broadcast", title: "Announcements" }],
      onWatch: (handler, groupId) => { handlers.set(groupId, handler) },
      onListMembers: () => { memberReads += 1 },
    })
    core.readRecentMessages = async (groupId) => [{ ...message(1, "announcement", { groupId, messageId: { deviceId: "device-moderator", seq: 1 } }), senderId: "moderator", senderLabel: "Moderator" }]
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()

    expect(bridge.destinations).toEqual([{ groupName: "Announcements", kind: "broadcast" }])
    expect(bridge.contextBuffers.size).toBe(0)
    expect(handlers).toEqual(new Map())
    const read = fixture.tools.find((tool) => tool.name === "keet_read_recent_messages")!
    await expect(read.execute({ groupName: "Announcements", last: 1 }, undefined as never)).resolves.toMatchObject({ messages: [{ text: "announcement" }] })
    const members = fixture.tools.find((tool) => tool.name === "keet_list_members")!
    await expect(members.execute({ groupName: "Announcements" }, undefined as never)).rejects.toThrow("rosters are unavailable")
    expect(memberReads).toBe(0)

    const send = fixture.tools.find((tool) => tool.name === "keet_send_message")!
    await expect(send.execute({ groupName: "Announcements", text: "published" }, undefined as never)).resolves.toEqual({ sent: true })
    expect(core.sent).toEqual([{ groupId: "broadcast", text: "published" }])
    await expect(send.execute({ groupName: "Announcements", text: "reply is rejected", replyTo: { deviceId: "device-moderator", seq: 1 } }, undefined as never)).rejects.toThrow("do not support replyTo")
    await expect(send.execute({ groupName: "Announcements", text: "reaction is rejected", reaction: "📣" }, undefined as never)).rejects.toThrow("do not support reactions")
    expect(core.sent).toHaveLength(1)
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

  it("keeps the exact trigger target through followup and idle while allowing a text send with reaction", async () => {
    let deliver!: (message: KeetMessage) => void
    let bridge!: KeetBridge
    let releaseIdle!: () => void
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve })
    const reactionCalls: unknown[][] = []
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    core.addReaction = async (...args) => { reactionCalls.push(args as unknown[]) }
    const fixture = makeAgent(async (prompt) => {
      expect(bridge.activeReactionTarget).toEqual({ groupId: settings.groupId, messageId: { deviceId: "device-human", seq: 2 } })
      const send = fixture.tools.find((tool) => tool.name === "keet_send_message")!
      await expect(send.execute({ groupName: "Test group", text: "also sending text", reaction: "👍🏽" }, undefined as never)).resolves.toEqual({ sent: true, reacted: true })
      void prompt
    }, () => idle)
    bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    deliver(message(2, "please react and answer", { mentions: ["bot"] }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reactionCalls).toEqual([[settings.groupId, { deviceId: "device-human", seq: 2 }, "👍🏽", expect.anything()]])
    expect(bridge.activeReactionTarget).toEqual({ groupId: settings.groupId, messageId: { deviceId: "device-human", seq: 2 } })
    releaseIdle()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(bridge.activeReactionTarget).toBeUndefined()
    await bridge.stop()
  })

  it("clears the active reaction target after failed work and terminal teardown before any later Core mutation", async () => {
    const assertReactionUnavailable = async (fixture: ReturnType<typeof makeAgent>, core: ReturnType<typeof fakeCore>, reactionCalls: unknown[][]): Promise<void> => {
      const send = fixture.tools.find((tool) => tool.name === "keet_send_message")!
      await expect(send.execute({ groupName: "Test group", text: "must not send", reaction: "👍" }, undefined as never)).rejects.toThrow(/unavailable|not ready|lost readiness/)
      expect(core.sent).toHaveLength(0)
      expect(reactionCalls).toHaveLength(0)
    }

    let deliverRejected!: (message: KeetMessage) => void
    const rejectedCalls: unknown[][] = []
    const rejectedCore = fakeCore({ onWatch: (handler) => { deliverRejected = handler } })
    rejectedCore.addReaction = async (...args) => { rejectedCalls.push(args as unknown[]) }
    const rejectedFixture = makeAgent(() => Promise.reject(new Error("followup failed")))
    const rejectedBridge = new KeetBridge(deps(rejectedCore, rejectedFixture.agent))
    await rejectedBridge.start()
    deliverRejected(message(10, "reject this turn", { mentions: ["bot"] }))
    await flushBridge()
    expect(rejectedBridge.activeReactionTarget).toBeUndefined()
    await assertReactionUnavailable(rejectedFixture, rejectedCore, rejectedCalls)
    await rejectedBridge.stop()

    let deliverIdleFailure!: (message: KeetMessage) => void
    const idleFailureCalls: unknown[][] = []
    const idleFailureCore = fakeCore({ onWatch: (handler) => { deliverIdleFailure = handler } })
    idleFailureCore.addReaction = async (...args) => { idleFailureCalls.push(args as unknown[]) }
    const idleFailureFixture = makeAgent(undefined, async () => { throw new Error("idle failed") })
    const idleFailureBridge = new KeetBridge(deps(idleFailureCore, idleFailureFixture.agent))
    await idleFailureBridge.start()
    deliverIdleFailure(message(11, "idle failure", { mentions: ["bot"] }))
    await flushBridge()
    expect(idleFailureBridge.activeReactionTarget).toBeUndefined()
    await assertReactionUnavailable(idleFailureFixture, idleFailureCore, idleFailureCalls)
    await idleFailureBridge.stop()

    let deliverStopped!: (message: KeetMessage) => void
    let releaseStopped!: () => void
    const stoppedFollowup = new Promise<void>((resolve) => { releaseStopped = resolve })
    const stoppedCalls: unknown[][] = []
    const stoppedCore = fakeCore({ onWatch: (handler) => { deliverStopped = handler } })
    stoppedCore.addReaction = async (...args) => { stoppedCalls.push(args as unknown[]) }
    const stoppedFixture = makeAgent(() => stoppedFollowup)
    const stoppedBridge = new KeetBridge(deps(stoppedCore, stoppedFixture.agent))
    await stoppedBridge.start()
    deliverStopped(message(12, "stop during work", { mentions: ["bot"] }))
    await flushBridge()
    expect(stoppedBridge.activeReactionTarget).toEqual({ groupId: settings.groupId, messageId: { deviceId: "device-human", seq: 12 } })
    await stoppedBridge.stop()
    expect(stoppedBridge.activeReactionTarget).toBeUndefined()
    await assertReactionUnavailable(stoppedFixture, stoppedCore, stoppedCalls)
    releaseStopped()
    await flushBridge()
    expect(stoppedCalls).toHaveLength(0)

    let deliverConnectionLoss!: (message: KeetMessage) => void
    let terminateConnection!: () => void
    let releaseConnection!: () => void
    const connectionFollowup = new Promise<void>((resolve) => { releaseConnection = resolve })
    const connectionCalls: unknown[][] = []
    const connectionCore = fakeCore({
      onWatch: (handler) => { deliverConnectionLoss = handler },
      onSubscription: (terminate) => { terminateConnection = terminate },
    })
    connectionCore.addReaction = async (...args) => { connectionCalls.push(args as unknown[]) }
    const connectionFixture = makeAgent(() => connectionFollowup)
    const connectionBridge = new KeetBridge(deps(connectionCore, connectionFixture.agent))
    await connectionBridge.start()
    deliverConnectionLoss(message(13, "connection loss", { mentions: ["bot"] }))
    await flushBridge()
    expect(connectionBridge.activeReactionTarget).toEqual({ groupId: settings.groupId, messageId: { deviceId: "device-human", seq: 13 } })
    terminateConnection()
    await flushBridge()
    expect(connectionBridge.readiness).toMatchObject({ state: "failed", detail: "connection-failed" })
    expect(connectionBridge.activeReactionTarget).toBeUndefined()
    await assertReactionUnavailable(connectionFixture, connectionCore, connectionCalls)
    releaseConnection()
    await flushBridge()
    expect(connectionCalls).toHaveLength(0)
    await connectionBridge.stop()
  })

  it("keeps reaction summaries pending when a follow-up is discarded before claim", async () => {
    const cases: readonly { name: string; admission: FollowupAdmission }[] = [
      { name: "cancelled", admission: "discard" },
    ]
    for (const testCase of cases) {
      let deliver!: (message: KeetMessage) => void
      let followups = 0
      let currentReactions: NonNullable<KeetMessage["reactions"]> = [{ emoji: "👍", count: 1, own: false }]
      const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
      core.readRecentMessages = async (groupId) => [{ ...message(1, "integration response", { groupId, messageId: { deviceId: "device-bot", seq: 1 }, senderId: "bot", senderLabel: "Keet Bot", reactions: currentReactions }) }]
      let fixture!: ReturnType<typeof makeAgent>
      fixture = makeAgent(() => {
        followups += 1
        return undefined
      }, async () => undefined, { followupAdmission: testCase.admission })
      const bridge = new KeetBridge(deps(core, fixture.agent))
      await bridge.start()
      deliver(message(20, `${testCase.name} first`, { mentions: ["bot"] }))
      await flushBridge()
      expect(bridge.activeReactionTarget, testCase.name).toBeUndefined()
      expect(fixture.prompts, testCase.name).toHaveLength(1)

      fixture.setFollowupAdmission("admit")
      deliver(message(21, `${testCase.name} retry`, { mentions: ["bot"] }))
      await flushBridge()
      expect(fixture.prompts, testCase.name).toHaveLength(2)
      expect((fixture.prompts[1] as any).content[0].text, testCase.name).toContain('emoji="👍" count="1"')
      currentReactions = []
      await bridge.stop()
    }
  })

  it("clears target authorization at the Keet turn boundary before later non-Keet work", async () => {
    let deliver!: (message: KeetMessage) => void
    let releaseNonKeet!: () => void
    const nonKeetWork = new Promise<void>((resolve) => { releaseNonKeet = resolve })
    const reactionCalls: unknown[][] = []
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    core.addReaction = async (...args) => { reactionCalls.push(args as unknown[]) }
    let bridge!: KeetBridge
    let targetDuringKeet: KeetBridge["activeReactionTarget"]
    let targetDuringNonKeet: KeetBridge["activeReactionTarget"]
    let reactionRejected = false
    const fixture = makeAgent(async () => {
      targetDuringKeet = bridge.activeReactionTarget
    }, async () => {
      fixture.emitTurnEnd(1, "aborted")
      fixture.emitClaim({ id: "non-keet-work" }, 2)
      targetDuringNonKeet = bridge.activeReactionTarget
      const send = fixture.tools.find((tool) => tool.name === "keet_send_message")!
      try { await send.execute({ groupName: "Test group", text: "must not send", reaction: "👍" }, undefined as never) } catch { reactionRejected = true }
      await nonKeetWork
    })
    bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    deliver(message(22, "boundary trigger", { mentions: ["bot"] }))
    await flushBridge()
    expect(targetDuringKeet).toEqual({ groupId: settings.groupId, messageId: { deviceId: "device-human", seq: 22 } })
    expect(targetDuringNonKeet).toBeUndefined()
    expect(reactionRejected).toBe(true)
    expect(reactionCalls).toHaveLength(0)
    releaseNonKeet()
    await flushBridge()
    expect(bridge.activeReactionTarget).toBeUndefined()
    await bridge.stop()
  })

  it("keeps human reaction changes silent and consumes an exact aggregate tuple permanently", async () => {
    let deliver!: (message: KeetMessage) => void
    let currentReactions: KeetMessage["reactions"] = []
    const authored = (): KeetMessage => ({ ...message(1, "integration-authored", { messageId: { deviceId: "device-bot", seq: 1 }, senderId: "bot", senderLabel: "Keet Bot", ...(currentReactions ? { reactions: currentReactions } : {}) }) })
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    core.addReaction = async () => undefined
    core.readRecentMessages = async (groupId) => [{ ...authored(), groupId }]
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()

    currentReactions = [{ emoji: ":heart:", count: 2, own: false }]
    // A reaction-only state change has no subscription message and must not
    // wake the Agent.
    await flushBridge()
    expect(fixture.prompts).toHaveLength(0)
    deliver(message(2, "first trigger", { mentions: ["bot"] }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const firstPrompt = (fixture.prompts[0] as any).content[0].text as string
    expect(firstPrompt).toContain('emoji=":heart:" count="2"')
    expect(firstPrompt).toContain("integration-authored")
    expect(firstPrompt).not.toContain("device-bot")

    deliver(message(3, "unchanged trigger", { mentions: ["bot"] }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((fixture.prompts[1] as any).content[0].text).not.toContain("reaction context")

    currentReactions = []
    deliver(message(4, "removal trigger", { mentions: ["bot"] }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((fixture.prompts[2] as any).content[0].text).not.toContain("reaction context")

    currentReactions = [{ emoji: ":heart:", count: 2, own: false }]
    deliver(message(5, "re-add trigger", { mentions: ["bot"] }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((fixture.prompts[3] as any).content[0].text).not.toContain('emoji=":heart:" count="2"')
    await bridge.stop()
  })

  it("delivers reaction context once after a claim even without a session message event", async () => {
    let deliver!: (message: KeetMessage) => void
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    core.readRecentMessages = async (groupId) => [{ ...message(1, "integration-authored", {
      groupId,
      messageId: { deviceId: "device-bot", seq: 1 },
      senderId: "bot",
      senderLabel: "Keet Bot",
      reactions: [{ emoji: ":keet_love:", count: 1, own: false }],
    }) }]
    const fixture = makeAgent(undefined, async () => undefined, { followupAdmission: "claim-only" })
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()

    deliver(message(2, "first trigger", { mentions: ["bot"] }))
    await flushBridge()
    expect((fixture.prompts[0] as any).content[0].text).toContain('emoji=":keet_love:" count="1"')

    deliver(message(3, "next trigger", { mentions: ["bot"] }))
    await flushBridge()
    expect((fixture.prompts[1] as any).content[0].text).not.toContain("reaction context")
    await bridge.stop()
  })

  it("keeps every claimed receipt consumed after crossing the former 800-receipt boundary", async () => {
    let deliver!: (message: KeetMessage) => void
    let currentTarget = 1
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    core.readRecentMessages = async (groupId) => [{ ...message(currentTarget, `integration-authored-${currentTarget}`, {
      groupId,
      messageId: { deviceId: "device-bot", seq: currentTarget },
      senderId: "bot",
      senderLabel: "Keet Bot",
      reactions: [{ emoji: "👍", count: 1, own: false }],
    }) }]
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()

    for (let index = 1; index <= 801; index += 1) {
      currentTarget = index
      deliver(message(1000 + index, `claim-${index}`, { mentions: ["bot"] }))
      await flushBridge()
    }
    expect(fixture.prompts).toHaveLength(801)

    currentTarget = 1
    deliver(message(2000, "old tuple after boundary", { mentions: ["bot"] }))
    await flushBridge()
    expect(fixture.prompts).toHaveLength(802)
    expect((fixture.prompts[801] as any).content[0].text).not.toContain('emoji="👍" count="1"')
    await bridge.stop()
  })

  it("recovers claimed reaction receipts from archived sessions across restarts and allows a new count", async () => {
    let deliver!: (message: KeetMessage) => void
    let currentReactions: NonNullable<KeetMessage["reactions"]> = [{ emoji: ":heart:", count: 2, own: false }]
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    core.readRecentMessages = async (groupId) => [{ ...message(1, "integration-authored", {
      groupId,
      messageId: { deviceId: "device-bot", seq: 1 },
      senderId: "bot",
      senderLabel: "Keet Bot",
      reactions: currentReactions,
    }) }]

    const firstFixture = makeAgent()
    const firstBridge = new KeetBridge(deps(core, firstFixture.agent))
    await firstBridge.start()
    deliver(message(30, "first durable trigger", { mentions: ["bot"] }))
    await flushBridge()
    const firstRequest = firstFixture.prompts[0]
    expect(JSON.stringify(firstRequest)).toContain("dshKeetReactionReceipts")
    await firstBridge.stop()

    const activeSession = { meta: { id: "active" }, events: [{ type: "user/message", time: 3, data: { source: { kind: "user" }, content: "active" } }] }
    const archivedSession = { meta: { id: "archived" }, events: [
      { type: "unrelated/event", data: { malformed: true } },
      ...inboxEvents(firstRequest),
      { type: "agent/inbox/spliced", data: { target: "next-turn", start: 20, removedCount: 1, inserted: [] } },
    ] }
    const secondFixture = makeAgent()
    const secondBridge = new KeetBridge(deps(core, secondFixture.agent, { active: activeSession, archived: archivedSession }))
    await secondBridge.start()
    deliver(message(31, "unchanged after restart", { mentions: ["bot"] }))
    await flushBridge()
    expect((secondFixture.prompts[0] as any).content[0].text).not.toContain("reaction context")

    currentReactions = [{ emoji: ":heart:", count: 3, own: false }]
    deliver(message(32, "new count after restart", { mentions: ["bot"] }))
    await flushBridge()
    expect((secondFixture.prompts[1] as any).content[0].text).toContain('emoji=":heart:" count="3"')
    const secondRequest = secondFixture.prompts[1]
    await secondBridge.stop()

    const thirdFixture = makeAgent()
    const thirdBridge = new KeetBridge(deps(core, thirdFixture.agent, {
      active: activeSession,
      archived: { ...archivedSession, events: [...archivedSession.events, ...inboxEvents(secondRequest)] },
    }))
    await thirdBridge.start()
    deliver(message(33, "same new count after second restart", { mentions: ["bot"] }))
    await flushBridge()
    expect((thirdFixture.prompts[0] as any).content[0].text).not.toContain("reaction context")
    await thirdBridge.stop()
  })

  it("keeps a canceled persisted inbox removal eligible and suppresses reaction context after partial recovery failure", async () => {
    let deliver!: (message: KeetMessage) => void
    const core = fakeCore({ onWatch: (handler) => { deliver = handler } })
    core.readRecentMessages = async (groupId) => [{ ...message(1, "integration-authored", {
      groupId,
      messageId: { deviceId: "device-bot", seq: 1 },
      senderId: "bot",
      senderLabel: "Keet Bot",
      reactions: [{ emoji: "👍", count: 1, own: false }],
    }) }]
    const seedFixture = makeAgent()
    const seedBridge = new KeetBridge(deps(core, seedFixture.agent))
    await seedBridge.start()
    deliver(message(34, "seed", { mentions: ["bot"] }))
    await flushBridge()
    const request = seedFixture.prompts[0]
    await seedBridge.stop()

    const canceledFixture = makeAgent()
    const canceledBridge = new KeetBridge(deps(core, canceledFixture.agent, {
      active: { meta: { id: "active" }, events: [{ type: "user/message", time: 1, data: { source: { kind: "user" }, content: "active" } }] },
      archived: { meta: { id: "archived" }, events: inboxEvents(request, "canceled") },
    }))
    await canceledBridge.start()
    deliver(message(35, "canceled remains eligible", { mentions: ["bot"] }))
    await flushBridge()
    expect((canceledFixture.prompts[0] as any).content[0].text).toContain('emoji="👍" count="1"')
    await canceledBridge.stop()

    let partialDeliver!: (message: KeetMessage) => void
    const partialCore = fakeCore({ onWatch: (handler) => { partialDeliver = handler } })
    partialCore.readRecentMessages = async (groupId, last, signal) => await core.readRecentMessages(groupId, last, signal)
    const partialFixture = makeAgent()
    const partialBase = deps(partialCore, partialFixture.agent, { active: { meta: { id: "active" }, events: [{ type: "user/message", time: 1, data: { source: { kind: "user" }, content: "active" } }] } })
    const partialBridge = new KeetBridge({
      ...partialBase,
      workspaceRegistry: { get: () => ({ id: "workspace", path: "/workspace", sessionIds: ["active", "unreadable"] }), archivedSessionIds: new Set(["archived"]) },
      inspectSession: async (id) => {
        if (id === "unreadable") throw new Error("inspection failed")
        return partialBase.inspectSession(id)
      },
    })
    await partialBridge.start()
    partialDeliver(message(36, "ordinary survives unavailable recovery", { mentions: ["bot"] }))
    await flushBridge()
    const partialPrompt = (partialFixture.prompts[0] as any).content[0].text as string
    expect(partialPrompt).toContain("ordinary survives unavailable recovery")
    expect(partialPrompt).not.toContain("reaction context")
    await partialBridge.stop()
  })

  it("isolates reaction context per destination and keeps an unavailable refresh from suppressing text", async () => {
    const handlers = new Map<string, (message: KeetMessage) => void>()
    const core = fakeCore({ dm: true, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
    core.addReaction = async () => undefined
    core.readRecentMessages = async (groupId) => groupId === settings.groupId
      ? [{ ...message(1, "group response", { groupId, messageId: { deviceId: "device-bot", seq: 1 }, senderId: "bot", senderLabel: "Keet Bot", reactions: [{ emoji: "✅", count: 1, own: false }] }) }]
      : [{ ...dmMessage(1, "dm response", { messageId: { deviceId: "device-bot", seq: 2 }, senderId: "bot", senderLabel: "Keet Bot", reactions: [{ emoji: "💬", count: 1, own: false }] }) }]
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent, {}, { ...settings, dmMemberId: "peer" }))
    await bridge.start()
    handlers.get(settings.groupId)!(message(2, "group trigger", { mentions: ["bot"] }))
    handlers.get(dmGroupId)!(dmMessage(2, "dm trigger"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const prompts = fixture.prompts.map((prompt) => (prompt as any).content[0].text as string)
    expect(prompts).toHaveLength(2)
    expect(prompts.find((prompt) => prompt.includes("group trigger"))).toContain('emoji="✅" count="1"')
    expect(prompts.find((prompt) => prompt.includes("group trigger"))).not.toContain('emoji="💬"')
    expect(prompts.find((prompt) => prompt.includes("dm trigger"))).toContain('emoji="💬" count="1"')
    expect(prompts.find((prompt) => prompt.includes("dm trigger"))).not.toContain('emoji="✅"')
    await bridge.stop()

    let reads = 0
    const failingCore = fakeCore({ onWatch: (handler) => { handlers.set("failing", handler) } })
    failingCore.addReaction = async () => undefined
    failingCore.readRecentMessages = async () => { reads += 1; if (reads > 1) throw new Error("history unavailable"); return [] }
    const failingFixture = makeAgent()
    const failingBridge = new KeetBridge(deps(failingCore, failingFixture.agent))
    await failingBridge.start()
    handlers.get("failing")!(message(6, "still deliver", { mentions: ["bot"] }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(JSON.stringify(failingFixture.prompts[0])).toContain("still deliver")
    await failingBridge.stop()
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
    expect(reads).toBe(3)
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

  it("triggers exactly once for an external DM through the bridge's Core contract", async () => {
    const handlers = new Map<string, (message: KeetMessage) => void>()
    const core = fakeCore({ dm: true, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
    const configured = { groupId: "group-test", workspaceId: "workspace", dmMemberId: "member-peer" }
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent, {}, configured))
    try {
      await bridge.start()
      expect(bridge.readiness).toMatchObject({ state: "ready", destinations: [{ groupName: "Test group", kind: "group" }, { groupName: "Managed DM", kind: "dm" }] })

      handlers.get(dmGroupId)!(dmMessage(10, "bridge integration DM"))
      await flushBridge()
      expect(fixture.prompts).toHaveLength(1)
      expect(JSON.stringify(fixture.prompts[0])).toContain("bridge integration DM")
    } finally {
      await bridge.stop()
    }
  })

  it("fails closed when the pending DM authorization snapshot is unavailable", async () => {
    const core = fakeCore({ dm: true, pendingFailure: true })
    const bridge = new KeetBridge(deps(core, makeAgent().agent))
    await bridge.start()
    expect(bridge.readiness).toMatchObject({ state: "failed", detail: "core-start-failed" })
    expect(core.closed).toBe(true)
  })

  it("fails closed without subscriptions when Core rejects malformed pending-DM snapshots", async () => {
    for (const kind of ["envelope", "entry"] as const) {
      const handlers = new Map<string, (message: KeetMessage) => void>()
      const core = fakeCore({ dm: true, pendingMalformed: kind, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
      const bridge = new KeetBridge(deps(core, makeAgent().agent))
      await bridge.start()
      expect(bridge.readiness, kind).toMatchObject({ state: "failed", detail: "core-start-failed" })
      expect(handlers, kind).toHaveLength(0)
      expect(core.closed, kind).toBe(true)
    }
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

  it("starts every canonical destination and establishes only regular-group roster baselines", async () => {
    const handlers = new Map<string, (message: KeetMessage) => void>()
    let rosterCalls = 0
    const core = fakeCore({ dm: true, onListMembers: () => { rosterCalls += 1 }, onWatch: (handler, groupId) => { handlers.set(groupId, handler) } })
    const bridge = new KeetBridge(deps(core, makeAgent().agent, {}, memberJoinSettings(settings.groupId)))
    await bridge.start()
    expect(bridge.readiness.state).toBe("ready")
    expect([...handlers.keys()]).toEqual([settings.groupId, dmGroupId])
    await flushBridge()
    expect(rosterCalls).toBe(1)
    await bridge.stop()
  })

  it("keeps member-join triggers off by default, applies groups independently, and persists the choice across restart", async () => {
    vi.useFakeTimers()
    try {
      const secondGroup = "group-second"
      const groups: ManagedGroup[] = [
        { groupId: settings.groupId, roomType: "Default", title: "First" },
        { groupId: secondGroup, roomType: "Default", title: "Second" },
      ]
      const rosters = new Map<string, KeetMember[]>([
        [settings.groupId, [{ memberId: "bot", displayName: "Keet Bot" }, { memberId: "first-existing", displayName: "First existing" }]],
        [secondGroup, [{ memberId: "bot", displayName: "Keet Bot" }, { memberId: "second-existing", displayName: "Second existing" }]],
      ])
      const initial: MemberJoinTestSettings = { ...settings, memberJoinTriggers: {} }
      const live = settingsWatcher(initial)
      const firstRosterReads: string[] = []
      const firstCore = fakeCore({ groups, membersFor: (groupId) => rosters.get(groupId) ?? [], onListMembers: (groupId) => { firstRosterReads.push(groupId) } })
      const firstFixture = makeAgent()
      const first = new KeetBridge({ ...deps(firstCore, firstFixture.agent, {}, live.get()), getSettings: live.get, watchSettings: live.watch })
      await first.start()
      await flushBridge()
      expect(first.readiness).toMatchObject({ memberJoinGroups: [
        { groupId: settings.groupId, groupName: "First", enabled: false },
        { groupId: secondGroup, groupName: "Second", enabled: false },
      ] })
      expect(firstRosterReads).toEqual([])
      expect(firstFixture.prompts).toHaveLength(0)

      live.publish(memberJoinSettings(settings.groupId))
      await flushBridge()
      expect(first.readiness).toMatchObject({ memberJoinGroups: [
        { groupId: settings.groupId, enabled: true },
        { groupId: secondGroup, enabled: false },
      ] })
      expect(firstRosterReads).toEqual([settings.groupId])

      rosters.get(settings.groupId)!.push({ memberId: "first-new", displayName: "First new" })
      rosters.get(secondGroup)!.push({ memberId: "second-new", displayName: "Second new" })
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(firstFixture.prompts).toHaveLength(1)
      expect(JSON.stringify(firstFixture.prompts[0])).toContain("First new")
      expect(JSON.stringify(firstFixture.prompts[0])).not.toContain("Second new")
      await first.stop()

      const secondRosterReads: string[] = []
      const secondCore = fakeCore({ groups, membersFor: (groupId) => rosters.get(groupId) ?? [], onListMembers: (groupId) => { secondRosterReads.push(groupId) } })
      const secondFixture = makeAgent()
      const second = new KeetBridge({ ...deps(secondCore, secondFixture.agent, {}, live.get()), getSettings: live.get, watchSettings: live.watch })
      await second.start()
      await flushBridge()
      expect(second.readiness).toMatchObject({ memberJoinGroups: [
        { groupId: settings.groupId, enabled: true },
        { groupId: secondGroup, enabled: false },
      ] })
      expect(secondRosterReads).toEqual([settings.groupId])
      expect(secondFixture.prompts).toHaveLength(0)

      rosters.get(settings.groupId)!.push({ memberId: "first-after-restart", displayName: "First after restart" })
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(secondFixture.prompts).toHaveLength(1)
      expect(JSON.stringify(secondFixture.prompts[0])).toContain("First after restart")
      await second.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("suppresses a queued member-join turn after disabling its group and baselines again on re-enable", async () => {
    vi.useFakeTimers()
    try {
      let roster: KeetMember[] = [{ memberId: "bot", displayName: "Keet Bot" }, { memberId: "existing", displayName: "Existing" }]
      let releaseFirstTurn!: () => void
      const firstTurn = new Promise<void>((resolve) => { releaseFirstTurn = resolve })
      const live = settingsWatcher(memberJoinSettings(settings.groupId))
      const core = fakeCore({ membersFor: () => roster })
      const fixture = makeAgent(undefined, () => firstTurn)
      const bridge = new KeetBridge({ ...deps(core, fixture.agent, {}, live.get()), getSettings: live.get, watchSettings: live.watch })
      await bridge.start()
      await flushBridge()

      roster = [...roster, { memberId: "member-bob", displayName: "Bob" }]
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(1)
      expect(JSON.stringify(fixture.prompts[0])).toContain("Bob")

      roster = [...roster, { memberId: "member-carol", displayName: "Carol" }]
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(1)

      live.publish({ ...live.get(), memberJoinTriggers: {} })
      await flushBridge()
      releaseFirstTurn()
      await flushBridge()
      expect(fixture.prompts).toHaveLength(1)

      live.publish(memberJoinSettings(settings.groupId))
      await flushBridge()
      roster = [...roster, { memberId: "member-dan", displayName: "Dan" }]
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(2)
      expect(JSON.stringify(fixture.prompts[1])).toContain("Dan")
      await bridge.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("uses the first successful roster poll as a baseline and admits one bounded Member Join turn", async () => {
    vi.useFakeTimers()
    try {
      let roster: KeetMember[] = [{ memberId: "bot", displayName: "Keet Bot" }, { memberId: "member-alice", displayName: "Alice" }]
      const fixture = makeAgent()
      const core = fakeCore({ membersFor: () => roster })
      const bridge = new KeetBridge(deps(core, fixture.agent, {}, memberJoinSettings(settings.groupId)))
      await bridge.start()

      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(0)

      roster = [...roster, { memberId: "member-bob", displayName: "Bob" }]
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(1)
      const prompt = JSON.stringify(fixture.prompts[0])
      expect(prompt).toContain("Member Join")
      expect(prompt).toContain("Bob")
      expect(prompt).toContain("Test group")
      expect(prompt).not.toContain("member-bob")
      expect(prompt).not.toContain("device-human")
      expect(bridge.activeReactionTarget).toBeUndefined()
      await bridge.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps roster observations isolated to regular groups and excludes self, DM, and Broadcast members", async () => {
    vi.useFakeTimers()
    try {
      const secondGroup = "group-second"
      const groups: ManagedGroup[] = [
        { groupId: settings.groupId, roomType: "Default", title: "First" },
        { groupId: secondGroup, roomType: "Default", title: "Second" },
        { groupId: "group-broadcast", roomType: "Broadcast", title: "News" },
        { groupId: dmGroupId, roomType: "DirectMessage", title: "DM", dmMemberId: "peer" },
      ]
      const roster = new Map<string, KeetMember[]>([
        [settings.groupId, [{ memberId: "bot", displayName: "Keet Bot" }, { memberId: "a", displayName: "Alice" }]],
        [secondGroup, [{ memberId: "bot", displayName: "Keet Bot" }, { memberId: "b", displayName: "Bea" }]],
        ["group-broadcast", [{ memberId: "bot", displayName: "Keet Bot" }]],
        [dmGroupId, [{ memberId: "bot", displayName: "Keet Bot" }, { memberId: "peer", displayName: "Peer" }]],
      ])
      const fixture = makeAgent()
      const core = fakeCore({ groups, membersFor: (groupId) => roster.get(groupId) ?? [] })
      const bridge = new KeetBridge(deps(core, fixture.agent, {}, memberJoinSettings(settings.groupId, secondGroup)))
      await bridge.start()
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()

      roster.get(settings.groupId)!.push({ memberId: "new-a", displayName: "New Alice" })
      roster.get(secondGroup)!.push({ memberId: "new-b", displayName: "New Bea" })
      roster.get(dmGroupId)!.push({ memberId: "new-peer", displayName: "New Peer" })
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(2)
      const prompts = fixture.prompts.map((value) => JSON.stringify(value))
      expect(prompts.some((value) => value.includes('source group name=\\"First\\"') && value.includes("New Alice"))).toBe(true)
      expect(prompts.some((value) => value.includes('source group name=\\"Second\\"') && value.includes("New Bea"))).toBe(true)
      expect(prompts.some((value) => value.includes("New Peer") || value.includes("News"))).toBe(false)
      await bridge.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not infer a join from a failed roster read and retries from the last successful baseline", async () => {
    vi.useFakeTimers()
    try {
      let roster: KeetMember[] = [{ memberId: "bot", displayName: "Keet Bot" }, { memberId: "member-alice", displayName: "Alice" }]
      let reads = 0
      const fixture = makeAgent()
      const core = fakeCore({ membersFor: () => {
        reads += 1
        if (reads === 2) throw new Error("roster unavailable")
        return roster
      } })
      const bridge = new KeetBridge(deps(core, fixture.agent, {}, memberJoinSettings(settings.groupId)))
      await bridge.start()
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      roster = [...roster, { memberId: "member-bob", displayName: "Bob" }]
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(1)
      expect(JSON.stringify(fixture.prompts[0])).toContain("Bob")
      await bridge.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps canceled roster admission eligible but consumes the receipt after a claim", async () => {
    vi.useFakeTimers()
    try {
      let roster: KeetMember[] = [{ memberId: "bot", displayName: "Keet Bot" }]
      const fixture = makeAgent(undefined, async () => undefined, { followupAdmission: "discard" })
      const core = fakeCore({ membersFor: () => roster })
      const bridge = new KeetBridge(deps(core, fixture.agent, {}, memberJoinSettings(settings.groupId)))
      await bridge.start()
      await vi.advanceTimersByTimeAsync(10_000)
      roster = [...roster, { memberId: "member-bob", displayName: "Bob" }]
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(1)

      // The canceled removal leaves the observation eligible, so the same
      // current roster can be retried without waiting for leave/rejoin churn.
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(2)

      fixture.setFollowupAdmission("admit")
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(20_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(3)
      await bridge.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("replays durable roster receipts across bridge restarts without re-delivering consumed joins", async () => {
    vi.useFakeTimers()
    try {
      const roster: KeetMember[] = [{ memberId: "bot", displayName: "Keet Bot" }, { memberId: "member-bob", displayName: "Bob" }]
      const firstFixture = makeAgent()
      const firstCore = fakeCore({ membersFor: () => roster })
      const first = new KeetBridge(deps(firstCore, firstFixture.agent, {}, memberJoinSettings(settings.groupId)))
      await first.start()
      await vi.advanceTimersByTimeAsync(10_000)
      // The first read is the startup baseline; make Bob a live observation.
      roster.push({ memberId: "member-carol", displayName: "Carol" })
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(firstFixture.prompts).toHaveLength(1)
      const admitted = firstFixture.prompts[0]
      await first.stop()

      const consumedEvents = [
        { type: "user/message", time: 1, data: { source: { kind: "user" }, content: "hello" } },
        { type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [admitted] } },
        { type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, removedCount: 1, inserted: [] } },
      ]
      const consumedFixture = makeAgent()
      const consumedCore = fakeCore({ membersFor: () => roster })
      const consumed = new KeetBridge(deps(consumedCore, consumedFixture.agent, { prior: { meta: { id: "prior" }, events: consumedEvents } }, memberJoinSettings(settings.groupId)))
      await consumed.start()
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(consumedFixture.prompts).toHaveLength(0)
      await consumed.stop()

      const canceledFixture = makeAgent()
      const canceledCore = fakeCore({ membersFor: () => roster })
      const canceled = new KeetBridge(deps(canceledCore, canceledFixture.agent, { prior: { meta: { id: "prior" }, events: [
        { type: "user/message", time: 1, data: { source: { kind: "user" }, content: "hello" } },
        { type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [admitted] } },
        { type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, removedCount: 1, inserted: [], outcome: "canceled" } },
      ] } }, memberJoinSettings(settings.groupId)))
      await canceled.start()
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(canceledFixture.prompts).toHaveLength(1)
      expect(JSON.stringify(canceledFixture.prompts[0])).toContain("Carol")
      await canceled.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("replays more than the former receipt threshold on restart and keeps roster polling available", async () => {
    vi.useFakeTimers()
    try {
      const receiptCount = 4_097
      const events: any[] = [{ type: "user/message", time: 1, data: { source: { kind: "user" }, content: "hello" } }]
      for (let index = 0; index < receiptCount; index += 1) {
        const receipt = `member-join:${index.toString(16).padStart(64, "0")}`
        const message = {
          id: `member-join-${index}`,
          source: { kind: "user" },
          content: [{ type: "text", text: "Member Join" }],
          dshKeet: { adapter: "dsh-keet", kind: "member-join", receipt, groupId: "roster" },
        }
        events.push({ type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [message] } })
        events.push({ type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, removedCount: 1, inserted: [] } })
      }

      let roster: KeetMember[] = [{ memberId: "bot", displayName: "Keet Bot" }]
      const fixture = makeAgent()
      const core = fakeCore({ membersFor: () => roster })
      const restarted = new KeetBridge(deps(core, fixture.agent, { prior: { meta: { id: "prior" }, events } }, memberJoinSettings(settings.groupId)))
      await restarted.start()
      await flushBridge()
      expect(restarted.readiness.state).toBe("ready")
      expect(fixture.prompts).toHaveLength(0)

      roster = [...roster, { memberId: "member-carol", displayName: "Carol" }]
      await vi.advanceTimersByTimeAsync(10_000)
      await flushBridge()
      expect(fixture.prompts).toHaveLength(1)
      expect(JSON.stringify(fixture.prompts[0])).toContain("Carol")
      await restarted.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps mention and verified-reply triggers without a status display name", async () => {
    let deliver!: (message: KeetMessage) => void
    const fixture = makeAgent()
    const core = fakeCore({ missingDisplayName: true, onWatch: (handler) => { deliver = handler } })
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()

    deliver(message(80, "label only Keet Bot prompt"))
    await flushBridge()
    expect(fixture.prompts).toHaveLength(0)
    deliver(message(81, "mention trigger", { mentions: ["bot"] }))
    await flushBridge()
    expect(fixture.prompts).toHaveLength(1)
    deliver(message(82, "verified reply trigger", { replyTo: { deviceId: "device-bot", seq: 1 } }))
    await flushBridge()
    expect(fixture.prompts).toHaveLength(2)
    expect(JSON.stringify(fixture.prompts[0])).toContain("mention trigger")
    expect(JSON.stringify(fixture.prompts[1])).toContain("verified reply trigger")
    await bridge.stop()
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


describe("human group departure", () => {
  it("closes the subscription, ignores stale callbacks, and permits a fresh rejoin", async () => {
    const handlers: Array<(value: KeetMessage) => void> = []
    const core = fakeCore({ onWatch: (handler) => handlers.push(handler) })
    const watch = core.watchMessages.bind(core)
    const close = vi.fn(async () => undefined)
    core.watchMessages = (...args) => { const subscription = watch(...args); return { ...subscription, close } }
    const leave = vi.fn(async () => undefined)
    core.leaveGroup = leave
    const fixture = makeAgent()
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    const rpc = bridgeRpcHandler(bridge)
    const left = await rpc("onboarding", { workspaceId: "workspace", operation: "leave-group", groupId: settings.groupId }, new AbortController().signal)
    expect(left).toEqual({ ok: true, value: { status: "left" } })
    expect(leave).toHaveBeenCalledExactlyOnceWith(settings.groupId, expect.any(AbortSignal))
    expect(close).toHaveBeenCalledTimes(1)
    expect(bridge.destinations).toEqual([])
    expect(bridge.contextBuffers.has(settings.groupId)).toBe(false)
    handlers[0]!(message(10, "old callback", { mentions: ["bot"] }))
    await flushBridge()
    expect(fixture.prompts).toHaveLength(0)
    await rpc("onboarding", { workspaceId: "workspace", operation: "join", invitation: "keet://chat/rejoin" }, new AbortController().signal)
    handlers[0]!(message(11, "stale after rejoin", { mentions: ["bot"] }))
    handlers[1]!(message(12, "fresh after rejoin", { mentions: ["bot"] }))
    await flushBridge()
    expect(fixture.prompts).toHaveLength(1)
    expect(JSON.stringify(fixture.prompts)).toContain("fresh after rejoin")
    await bridge.stop()
  })

  it("finishes departure when the room stream ends and the client cancels during the native call", async () => {
    let terminate!: () => void
    const controller = new AbortController()
    const core = fakeCore({ onSubscription: (value) => { terminate = value } })
    const leave = vi.fn(async () => { terminate(); controller.abort() })
    core.leaveGroup = leave
    const bridge = new KeetBridge(deps(core, makeAgent().agent))
    await bridge.start()
    expect(await bridgeRpcHandler(bridge)("onboarding", { workspaceId: "workspace", operation: "leave-group", groupId: settings.groupId }, controller.signal)).toEqual({ ok: true, value: { status: "left" } })
    expect(core.closed).toBe(false)
    expect(bridge.destinations).toEqual([])
    expect(leave).toHaveBeenCalledTimes(1)
    await bridge.stop()
  })

  it("suppresses queued messages across leaving and rejoining while another turn runs", async () => {
    const handlers: Array<(value: KeetMessage) => void> = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const core = fakeCore({ onWatch: (handler) => handlers.push(handler) })
    const fixture = makeAgent(undefined, () => gate)
    const bridge = new KeetBridge(deps(core, fixture.agent))
    await bridge.start()
    handlers[0]!(message(20, "running", { mentions: ["bot"] }))
    await flushBridge()
    expect(fixture.prompts).toHaveLength(1)
    handlers[0]!(message(21, "queued before leaving", { mentions: ["bot"] }))
    await flushBridge()
    const rpc = bridgeRpcHandler(bridge)
    expect(await rpc("onboarding", { workspaceId: "workspace", operation: "leave-group", groupId: settings.groupId }, new AbortController().signal)).toMatchObject({ ok: true })
    expect(await rpc("onboarding", { workspaceId: "workspace", operation: "join", invitation: "keet://chat/again" }, new AbortController().signal)).toMatchObject({ ok: true })
    release()
    await flushBridge()
    expect(fixture.prompts).toHaveLength(1)
    handlers[1]!(message(22, "new admission", { mentions: ["bot"] }))
    await flushBridge()
    expect(fixture.prompts).toHaveLength(2)
    await bridge.stop()
  })

  it("rejects unknown, DM, mismatched workspace and canceled selectors without native mutation, and retains failed groups", async () => {
    const core = fakeCore({ dm: true })
    const leave = vi.fn(async () => { throw new Error("private failure") })
    core.leaveGroup = leave
    const bridge = new KeetBridge(deps(core, makeAgent().agent))
    await bridge.start()
    const rpc = bridgeRpcHandler(bridge)
    for (const [workspaceId, groupId] of [["workspace", "unknown"], ["workspace", dmGroupId], ["other", settings.groupId]]) {
      expect(await rpc("onboarding", { workspaceId, operation: "leave-group", groupId }, new AbortController().signal)).toMatchObject({ ok: false })
    }
    expect(await rpc("onboarding", { workspaceId: "workspace", operation: "leave-group", groupId: settings.groupId }, AbortSignal.abort())).toMatchObject({ ok: false })
    expect(leave).not.toHaveBeenCalled()
    expect(await rpc("onboarding", { workspaceId: "workspace", operation: "leave-group", groupId: settings.groupId }, new AbortController().signal)).toMatchObject({ ok: false, error: { code: "operation-failed" } })
    expect(bridge.destinations).toHaveLength(2)
    await bridge.stop()
  })
})
