import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { PassThrough } from "node:stream"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { KeetSidecarStatus, KeetSidecarLog } from "../packages/keet-core/src/sidecar.js"
import { KeetIntegrationCore, KeetSidecar, validateAdmission, type PreparedAvatar, type ManagedGroup } from "../packages/keet-core/src/index.js"
import type { RpcMethodName } from "../packages/keet-core/src/rpc-methods.js"
import { classifyTrigger } from "../packages/dsh-keet/src/keet-protocol.js"

const fixture = fileURLToPath(new URL("./fixtures/fake-worker.mjs", import.meta.url))
const nodeExecutable = [
  process.env.KEET_TEST_NODE,
  ...((process.env.PATH ?? "").split(path.delimiter).map((directory) => path.join(directory, "node"))),
  "/usr/bin/node",
  "/run/current-system/sw/bin/node",
  process.execPath,
].find((candidate): candidate is string => typeof candidate === "string" && existsSync(candidate))!
const temporaryDirectories: string[] = []
const mockCores: KeetIntegrationCore[] = []

afterEach(async () => {
  await Promise.all(mockCores.splice(0).map((core) => core.close().catch(() => undefined)))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function dataPath(prefix = "keet-core-process-"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function processOptions(data: string, logger?: (entry: KeetSidecarLog) => void, overrides: Record<string, unknown> = {}) {
  const value = {
    executablePath: nodeExecutable,
    bundlePath: fixture,
    dataPath: data,
    swarming: false,
    startupTimeoutMs: 3_000,
    shutdownTimeoutMs: 1_000,
    ...overrides,
  }
  return logger ? { ...value, logger } : value
}

type MockCall = { name: RpcMethodName; args: unknown[] }
type MockState = {
  identity: Record<string, unknown>
  groups: unknown[]
  roomInfo: Map<string, unknown>
  members: unknown[]
  messages: unknown[]
  pending: unknown
  streams: Set<PassThrough>
  calls: MockCall[]
  closed: boolean
  nextSeq: number
  accepted: boolean
  roomListReads: number
}
type MockHandler = (args: unknown[], state: MockState) => unknown | Promise<unknown>
type MockOptions = {
  handlers?: Partial<Record<RpcMethodName, MockHandler>>
  identity?: Record<string, unknown>
  groups?: unknown[]
  roomInfo?: Record<string, unknown>
  members?: unknown[]
  messages?: unknown[]
  pending?: unknown
  status?: Partial<KeetSidecarStatus>
  snapshot?: unknown
}

interface MockCore {
  core: KeetIntegrationCore
  sidecar: KeetSidecar
  state: MockState
  emit(value: unknown): void
  terminate(reason?: "error" | "exit"): void
}

function makeMockCore(options: MockOptions = {}): MockCore {
  const defaultGroup = { roomId: "group-test", title: "Test group", description: "fixture", roomType: "Default" }
  const defaultMessages = [
    { roomId: "group-test", messageId: { deviceId: "device-alice", seq: 1 }, senderId: "member-alice", senderName: "Alice", timestamp: 1, type: "text", text: "initial context" },
    { roomId: "group-test", messageId: { deviceId: "device-self", seq: 2 }, senderId: "identity-self", senderName: "Fixture Bot", timestamp: 2, type: "text", text: "initial self" },
  ]
  const state: MockState = {
    identity: options.identity ?? { memberId: "identity-self", displayName: "Fixture Bot" },
    groups: options.groups ?? [defaultGroup],
    roomInfo: new Map(Object.entries(options.roomInfo ?? { "group-test": defaultGroup })),
    members: options.members ?? [
      { memberId: "identity-self", displayName: "Fixture Bot" },
      { memberId: "member-alice", displayName: "Alice" },
    ],
    messages: options.messages ?? defaultMessages,
    pending: options.pending ?? [],
    streams: new Set(),
    calls: [],
    closed: false,
    nextSeq: 10,
    accepted: false,
    roomListReads: 0,
  }
  const status: KeetSidecarStatus = {
    state: "ready",
    appVersion: "4.21.0",
    coreVersion: "4.21.5",
    abi: 35,
    swarming: false,
    ...options.status,
  }
  const sidecar = new KeetSidecar({
    executablePath: "/inert/keet/bare",
    bundlePath: "/inert/keet/core-worker.bundle",
    dataPath: "/inert/keet/identity",
    platform: "linux",
    arch: "x64",
  })
  const terminalListeners = new Set<(reason: "error" | "exit") => void>()
  const handler = async (name: RpcMethodName, args: unknown[]): Promise<unknown> => {
    state.calls.push({ name, args })
    const custom = options.handlers?.[name]
    if (custom) return custom(args, state)
    switch (name) {
      case "getIdentity": return state.identity
      case "getRecentRooms":
        state.roomListReads += 1
        return { rooms: state.groups }
      case "getRoomInfo": return state.roomInfo.get(String(args[0])) ?? null
      case "getMembers": return state.members
      case "getChatMessages": {
        const groupId = String(args[0])
        return state.messages.filter((message) => {
          if (!message || typeof message !== "object") return false
          const roomId = (message as { roomId?: unknown }).roomId
          return roomId === undefined || roomId === groupId
        })
      }
      case "getDmRequestsByStatus": return state.pending
      case "acceptDmRequest": state.accepted = true; state.pending = []; return {}
      case "setUnreadAnchor":
      case "updateTypingIndicator":
      case "updateIdentityProfile": return {}
      case "getLinkInfo": return { isRoomInvitation: args[0] === "fixture-token", title: "Test group" }
      case "startPairingRoom": return { roomId: "group-joined" }
      case "createRoom": return "group-created"
      case "createInvitation": return "fixture-token"
      case "addChatMessage": {
        const groupId = String(args[0])
        const text = String(args[1])
        const replyTo = args[2] && typeof args[2] === "object" && "replyTo" in args[2]
          ? (args[2] as { replyTo?: unknown }).replyTo
          : undefined
        const human = text.startsWith("[human] ")
        const message = {
          roomId: groupId,
          messageId: { deviceId: human ? "device-alice" : "device-self", seq: state.nextSeq++ },
          senderId: human ? "member-alice" : "identity-self",
          senderName: human ? "Alice" : String(state.identity.displayName ?? "Fixture Bot"),
          timestamp: Date.now(),
          type: "text",
          text: human ? text.slice(8) : text,
          ...(replyTo ? { replyTo } : {}),
        }
        state.messages.push(message)
        for (const stream of state.streams) stream.write([message])
        return message.messageId
      }
      default: return {}
    }
  }
  sidecar.call = ((name, args) => handler(name, args)) as KeetSidecar["call"]
  sidecar.status = async () => status
  sidecar.onTerminal = (listener) => {
    terminalListeners.add(listener)
    return () => terminalListeners.delete(listener)
  }
  sidecar.subscribe = ((name, args) => {
    state.calls.push({ name, args })
    const stream = new PassThrough({ objectMode: true })
    state.streams.add(stream)
    stream.once("close", () => state.streams.delete(stream))
    queueMicrotask(() => {
      if (stream.destroyed) return
      stream.write(options.snapshot ?? state.messages.slice())
    })
    return stream
  }) as KeetSidecar["subscribe"]
  sidecar.close = async () => {
    state.closed = true
    for (const stream of state.streams) stream.destroy()
    state.streams.clear()
  }
  const core = new KeetIntegrationCore(sidecar)
  mockCores.push(core)
  return {
    core,
    sidecar,
    state,
    emit: (value) => { for (const stream of state.streams) stream.write(value) },
    terminate: (reason = "exit") => {
      for (const listener of terminalListeners) listener(reason)
      for (const stream of state.streams) stream.destroy(new Error("connection failed"))
    },
  }
}

function officialMessages(): unknown[] {
  return [
    {
      timestamp: 4,
      clock: 17,
      memberId: "member-alice",
      member: { memberId: "member-alice", displayName: "Official Alice" },
      id: { deviceId: "device-alice", seq: 11 },
      deleted: false,
      replyTo: null,
      message: { text: "official mention", replyTo: null },
      chat: { text: "official mention", edited: false, mentions: [{ type: "mention", memberId: "identity-self" }] },
    },
    {
      timestamp: 5,
      memberId: "member-alice",
      member: { memberId: "member-alice", displayName: "Official Alice" },
      id: { deviceId: "device-alice", seq: 12 },
      deleted: false,
      replyTo: null,
      message: { text: "edited official record", replyTo: null },
      chat: { text: "edited official record", edited: true, mentions: [] },
    },
    {
      timestamp: 6,
      memberId: "member-alice",
      member: { memberId: "member-alice", displayName: "Official Alice" },
      id: { deviceId: "device-alice", seq: 13 },
      deleted: false,
      replyTo: { deviceId: "device-self", seq: 2 },
      message: { text: "conflicting official reply", replyTo: { deviceId: "device-other", seq: 3 } },
      chat: { text: "conflicting official reply", edited: false, mentions: [] },
    },
  ]
}

function dmGroup(roomType: ManagedGroup["roomType"] = "DirectMessage", memberId = "member-peer") {
  return { roomId: "group-dm", title: "Managed DM", description: "fixture DM", roomType, dmMemberId: memberId }
}

function avatarFixture(): PreparedAvatar {
  const makeVariant = (size: number) => {
    const bytes = Buffer.from(`avatar-${size}`)
    return { bytes, contentType: "image/png", width: size, height: size, hash: createHash("sha256").update(bytes).digest("hex") }
  }
  return { small: makeVariant(64), medium: makeVariant(128), large: makeVariant(256) }
}

describe("typed Keet Integration Core unit behavior", () => {
  it("admits only the pinned Linux tuple and validates an explicit addon closure", () => {
    const base = { executablePath: "/tmp/bare", bundlePath: "/tmp/core-worker.bundle", dataPath: "/tmp/identity", platform: "linux", arch: "x64" }
    expect(() => validateAdmission({ ...base, nativeAddonPaths: Array.from({ length: 25 }, (_, index) => `addon-${index}`) })).not.toThrow()
    expect(() => validateAdmission({ ...base, platform: "darwin" })).toThrow("Linux x86-64")
    expect(() => validateAdmission({ ...base, expectedAbi: 34 })).toThrow("ABI")
    expect(() => validateAdmission({ ...base, nativeAddonPaths: ["one"] })).toThrow("closure")
  })

  it("maps the public readiness contract and fails closed when identity data is absent", async () => {
    const ready = makeMockCore()
    await expect(ready.core.status()).resolves.toEqual({ state: "ready", appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: false, identityId: "identity-self", displayName: "Fixture Bot" })
    const missing = makeMockCore({ identity: {} })
    await expect(missing.core.status()).rejects.toThrow("identity is unavailable")
  })

  it("normalizes official nullable replies, edits, mentions, labels, and chat indexes", async () => {
    const harness = makeMockCore({ messages: officialMessages() })
    const history = await harness.core.readRecentMessages("group-test", 50)
    expect(history).toEqual([{
      messageId: { deviceId: "device-alice", seq: 11 },
      groupId: "group-test",
      senderId: "member-alice",
      senderLabel: "Official Alice",
      timestamp: 4,
      text: "official mention",
      chatIndex: 17,
      mentions: ["identity-self"],
    }])
    expect(history[0]).not.toHaveProperty("replyTo")
    expect(classifyTrigger(history[0]!, { memberId: "identity-self", displayName: "Fixture Bot" }, new Set())?.triggerKind).toBe("mention")
  })

  it("normalizes room kinds, compact metadata, members, and duplicate records", async () => {
    const harness = makeMockCore({
      groups: [
        { roomId: "group-test", title: "Test group", description: "fixture", roomType: 0 },
        { roomId: "group-broadcast", title: "Broadcast", description: "fixture broadcast", roomType: "broadcast" },
        { roomId: "group-dm", title: "Managed DM", roomType: "DirectMessage" },
        { roomId: "unknown", title: "Ignored", roomType: "unknown" },
      ],
      roomInfo: {
        "group-test": { roomId: "group-test", roomType: "Default" },
        "group-broadcast": { roomId: "group-broadcast", roomType: "Broadcast" },
        "group-dm": { roomId: "group-dm", title: "Managed DM", description: "fixture DM", roomType: "DirectMessage", dmMemberId: "member-peer" },
      },
      members: [
        { memberId: "member-z", name: "Zed" },
        { memberId: "member-z", name: "Aaron" },
        { id: "member-a", profile: { displayName: "Alice" } },
        { malformed: true },
      ],
    })
    expect(await harness.core.listGroups()).toEqual([
      { groupId: "group-test", title: "Test group", description: "fixture", roomType: "Default" },
      { groupId: "group-broadcast", title: "Broadcast", description: "fixture broadcast", roomType: "Broadcast" },
      { groupId: "group-dm", title: "Managed DM", description: "fixture DM", roomType: "DirectMessage", dmMemberId: "member-peer" },
    ])
    expect(await harness.core.listMembers("group-test")).toEqual([
      { memberId: "member-a", displayName: "Alice" },
      { memberId: "member-z", displayName: "Aaron" },
    ])
  })

  it("maps DM activity calls and validates their bounded inputs and results", async () => {
    const harness = makeMockCore()
    await harness.core.setUnreadAnchor("group-dm", 18)
    await harness.core.updateTypingIndicator("group-dm")
    expect(harness.state.calls.filter(({ name }) => name === "setUnreadAnchor" || name === "updateTypingIndicator")).toEqual([
      { name: "setUnreadAnchor", args: ["group-dm", 18] },
      { name: "updateTypingIndicator", args: ["group-dm"] },
    ])
    await expect(harness.core.setUnreadAnchor("group-dm", -1)).rejects.toThrow("safe integer")
    await expect(harness.core.setUnreadAnchor("group-dm", 1.5)).rejects.toThrow("safe integer")
    const invalid = makeMockCore({ handlers: { updateTypingIndicator: () => "unexpected" } })
    await expect(invalid.core.updateTypingIndicator("group-dm")).rejects.toThrow("invalid typing indicator result")
  })

  it("suppresses the stream snapshot, filters records, deduplicates, and isolates handler errors", async () => {
    const snapshot = [
      { roomId: "group-test", messageId: { deviceId: "device-alice", seq: 1 }, senderId: "member-alice", senderName: "Alice", timestamp: 1, type: "text", text: "initial" },
      { roomId: "group-test", messageId: { deviceId: "device-system", seq: 2 }, senderId: "system", timestamp: 2, type: "system", text: "ignored" },
    ]
    const harness = makeMockCore({ snapshot })
    const received: string[] = []
    const subscription = harness.core.watchMessages("group-test", (message) => {
      received.push(message.text)
      if (message.text === "first") throw new Error("subscriber bug")
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received).toEqual([])
    harness.emit([{ roomId: "group-test", messageId: { deviceId: "device-alice", seq: 1 }, senderId: "member-alice", text: "duplicate", timestamp: 3, type: "text" }])
    harness.emit([{ roomId: "group-test", messageId: { deviceId: "device-system", seq: 5 }, senderId: "system", text: "live ignored", timestamp: 3, type: "system" }])
    harness.emit([{ roomId: "group-test", messageId: { deviceId: "device-alice", seq: 3 }, senderId: "member-alice", text: "first", timestamp: 4, type: "text" }])
    harness.emit([{ roomId: "group-test", messageId: { deviceId: "device-alice", seq: 4 }, senderId: "member-alice", text: "second", timestamp: 5, type: "text" }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received).toEqual(["first", "second"])
    expect(subscription.closed).toBe(false)
    await subscription.close()
    expect(subscription.closed).toBe(true)
  })

  it("terminates a subscription on an injected terminal sidecar event and keeps close distinct", async () => {
    const failed = makeMockCore()
    const failedSubscription = failed.core.watchMessages("group-test", () => undefined)
    const failedReason = new Promise<"closed" | "connection-failed">((resolve) => failedSubscription.onTerminate?.(resolve))
    failed.terminate()
    await expect(failedReason).resolves.toBe("connection-failed")
    expect(failedSubscription.terminationReason).toBe("connection-failed")

    const closed = makeMockCore()
    const closedSubscription = closed.core.watchMessages("group-test", () => undefined)
    const closedReason = new Promise<"closed" | "connection-failed">((resolve) => closedSubscription.onTerminate?.(resolve))
    await closed.core.close()
    await expect(closedReason).resolves.toBe("closed")
  })

  it("preserves reply IDs, validates targets before mutation, and maps send calls", async () => {
    const harness = makeMockCore()
    const target = { deviceId: "device-alice", seq: 1 }
    await expect(harness.core.sendMessage("group-test", "reply", target)).resolves.toEqual({ deviceId: "device-self", seq: 10 })
    expect(harness.state.calls.at(-1)).toEqual({ name: "addChatMessage", args: ["group-test", "reply", { replyTo: target }] })
    const before = harness.state.calls.length
    await expect(harness.core.sendMessage("group-test", "bad", { deviceId: "attacker", seq: 999 })).rejects.toThrow("reply target was not found")
    expect(harness.state.calls.slice(before).map(({ name }) => name)).toEqual(["getRecentRooms", "getChatMessages"])
    const dm = makeMockCore({ groups: [dmGroup()] })
    await expect(dm.core.sendMessage("group-dm", "reply", target)).rejects.toThrow("not supported for a Managed DM")
  })

  it("maps invitation inspection, creation, joining, and cancellation without provider details", async () => {
    const joined = makeMockCore({ handlers: {
      getLinkInfo: ([token]) => token === "fixture-token" ? { isRoomInvitation: true, title: "Joined" } : { isRoomInvitation: false },
      startPairingRoom: () => ({ roomId: "group-joined" }),
    } })
    await expect(joined.core.inspectInvitation("https://not-keet")).rejects.toThrow("room invitation")
    await expect(joined.core.inspectInvitation("keet://chat/fixture-token")).resolves.toMatchObject({ isRoomInvitation: true })
    await expect(joined.core.createRoom({ title: "  New room  ", description: "description" })).resolves.toBe("group-created")
    await expect(joined.core.createInvitation("group-test", { expires: 60 })).resolves.toEqual({ token: "fixture-token", url: "keet://chat/fixture-token" })
    await expect(joined.core.joinInvitation("keet://chat/fixture-token")).resolves.toEqual({ groupId: "group-joined" })
    const controller = new AbortController()
    const pending = makeMockCore({ handlers: { getChatMessages: () => new Promise(() => undefined) } })
    const operation = pending.core.readRecentMessages("group-test", 1, controller.signal)
    controller.abort()
    await expect(operation).rejects.toThrow("cancelled")
  })

  it("resolves existing and wrong-kind DMs through the canonical room list", async () => {
    const resolved = makeMockCore({ groups: [{ roomId: "group-test", roomType: "Default" }, dmGroup()] })
    await expect(resolved.core.resolveDm("member-peer")).resolves.toEqual({ groupId: "group-dm", roomType: "DirectMessage", dmMemberId: "member-peer", title: "Managed DM", description: "fixture DM" })
    const compact = makeMockCore({
      groups: [{ roomId: "group-dm", title: "Managed DM", roomType: "DirectMessage" }],
      roomInfo: { "group-dm": dmGroup() },
    })
    await expect(compact.core.resolveDm("member-peer")).resolves.toMatchObject({ groupId: "group-dm", dmMemberId: "member-peer" })
    const wrongKind = makeMockCore({ groups: [dmGroup("Broadcast")] })
    await expect(wrongKind.core.resolveDm("member-peer")).rejects.toThrow("unsupported room type")
  })

  it("accepts one exact pending DM request after bounded convergence and rejects malformed snapshots", async () => {
    const pending = { id: { memberId: "member-peer", roomId: "group-dm" }, senderContactInfo: { memberId: "member-peer", displayName: "Peer" } }
    const delayed = makeMockCore({
      groups: [{ roomId: "group-test", roomType: "Default", title: "Test group", description: "fixture" }],
      pending: [pending],
      roomInfo: { "group-test": { roomId: "group-test", roomType: "Default", title: "Test group", description: "fixture" }, "group-dm": dmGroup() },
      handlers: {
        getRecentRooms: (_args, state) => {
          state.roomListReads += 1
          if (state.accepted && state.roomListReads >= 4 && !state.groups.some((value) => (value as { roomId?: unknown }).roomId === "group-dm")) state.groups.push(dmGroup())
          return { rooms: state.groups }
        },
      },
    })
    await expect(delayed.core.listPendingDmRequests()).resolves.toEqual([{ memberId: "member-peer", displayName: "Peer" }])
    await expect(delayed.core.resolveDm("member-peer")).rejects.toThrow("not resolved")
    await expect(delayed.core.acceptDmRequest("member-peer")).resolves.toMatchObject({ groupId: "group-dm", dmMemberId: "member-peer" })
    expect(delayed.state.calls.filter(({ name }) => name === "acceptDmRequest")).toEqual([{ name: "acceptDmRequest", args: [{ memberId: "member-peer", roomId: "group-dm" }] }])

    const duplicatePending = makeMockCore({ pending: [pending, { ...pending, senderContactInfo: { memberId: "member-peer", displayName: "Duplicate" } }] })
    await expect(duplicatePending.core.listPendingDmRequests()).resolves.toEqual([{ memberId: "member-peer", displayName: "Peer" }])

    for (const malformed of [
      { raw: { requests: { malformed: true } }, message: "invalid pending DM request snapshot" },
      { raw: [pending, { malformed: true }], message: "invalid pending DM request" },
    ] as const) {
      const malformedHarness = makeMockCore({ pending: malformed.raw })
      await expect(malformedHarness.core.listPendingDmRequests()).rejects.toThrow(malformed.message)
      await expect(malformedHarness.core.acceptDmRequest("member-peer")).rejects.toThrow(malformed.message)
    }
  })

  it("fails closed for missing, duplicate, mismatched-peer, and pending DM matches", async () => {
    const cases: Array<{ groups: unknown[]; message: string; pending?: unknown }> = [
      { groups: [], message: "not resolved" },
      { groups: [dmGroup(), { ...dmGroup(), title: "Duplicate" }], message: "ambiguous" },
      { groups: [dmGroup("DirectMessage", "member-other")], message: "not resolved" },
      { groups: [dmGroup()], pending: [{ id: { memberId: "member-peer", roomId: "group-dm" } }], message: "not resolved" },
    ]
    for (const testCase of cases) {
      const harness = makeMockCore({ groups: testCase.groups, pending: testCase.pending })
      await expect(harness.core.resolveDm("member-peer")).rejects.toThrow(testCase.message)
    }
  })

  it("updates profiles, preserves avatar-only names, and validates avatar bytes before RPC", async () => {
    const harness = makeMockCore()
    const avatar = avatarFixture()
    await harness.core.updateIdentityProfile({ avatar })
    expect(harness.state.identity.displayName).toBe("Fixture Bot")
    const profileCall = [...harness.state.calls].reverse().find(({ name }) => name === "updateIdentityProfile")
    expect(profileCall?.args[0]).toMatchObject({ displayName: "Fixture Bot", avatar: { small: { metadata: { dimensions: { width: 64, height: 64 } } } } })
    await harness.core.updateDisplayName("  New Fixture Name  ")
    await expect(harness.core.status()).resolves.toMatchObject({ displayName: "New Fixture Name" })
    const invalid = { ...avatar, small: { ...avatar.small, hash: "0".repeat(64) } }
    await expect(harness.core.updateIdentityProfile({ avatar: invalid })).rejects.toThrow("hash does not match")
    const oversizedBytes = Buffer.alloc(512 * 1024 + 1, 0x61)
    const oversized = { ...avatar, small: { ...avatar.small, bytes: oversizedBytes, hash: createHash("sha256").update(oversizedBytes).digest("hex") } }
    const before = harness.state.calls.length
    await expect(harness.core.updateIdentityProfile({ avatar: oversized })).rejects.toThrow("too large or invalid")
    expect(harness.state.calls.length).toBe(before)
  })
})

describe("Keet Integration Core fd-3 process contracts", () => {
  it("fails closed when a bundle advertises malformed manifest framing", async () => {
    const data = await dataPath()
    const bundle = path.join(data, "malformed.bundle")
    await writeFile(bundle, "3\n{}")
    await expect(new KeetSidecar({ ...processOptions(data), bundlePath: bundle }).start()).rejects.toThrow("closure")
  })

  it("boots through fd-3, wires numeric RPCs, transits representative records, and redacts worker output", async () => {
    const data = await dataPath()
    const logs: KeetSidecarLog[] = []
    const core = await KeetIntegrationCore.start(processOptions(data, (entry) => logs.push(entry)))
    try {
      await expect(core.status()).resolves.toMatchObject({ state: "ready", appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: false, identityId: "identity-self", displayName: "Fixture Bot" })
      await expect(core.listGroups()).resolves.toEqual([{ groupId: "group-test", title: "Test group", description: "fixture", roomType: "Default" }])
      await expect(core.listMembers("group-test")).resolves.toEqual([{ memberId: "identity-self", displayName: "Fixture Bot" }, { memberId: "member-alice", displayName: "Alice" }])
      await expect(core.readRecentMessages("group-test", 50)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ messageId: { deviceId: "device-alice", seq: 1 }, text: "initial context" }),
        expect.objectContaining({ messageId: { deviceId: "device-self", seq: 2 }, text: "initial self" }),
      ]))
      await expect(core.readRecentMessages("group-test", 0)).rejects.toThrow("1 to 50")
      const rendered = JSON.stringify(logs)
      expect(rendered).not.toContain(data)
      expect(logs.map((entry) => entry.event)).toContain("sidecar.worker-output-discarded")
    } finally {
      await core.close()
    }
  })

  it("keeps the real stream snapshot suppressed while forwarding live self and external text", async () => {
    const core = await KeetIntegrationCore.start(processOptions(await dataPath()))
    try {
      const received: Array<{ senderId: string; text: string }> = []
      const subscription = core.watchMessages("group-test", (message) => received.push({ senderId: message.senderId, text: message.text }))
      await new Promise((resolve) => setTimeout(resolve, 30))
      await core.sendMessage("group-test", "self message")
      await core.sendMessage("group-test", "[human] first external")
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(received).toEqual([{ senderId: "identity-self", text: "self message" }, { senderId: "member-alice", text: "first external" }])
      await subscription.close()
      expect(subscription.closed).toBe(true)
    } finally {
      await core.close()
    }
  })

  it("terminates subscriptions and RPC calls when the ready worker exits", async () => {
    const core = await KeetIntegrationCore.start(processOptions(await dataPath("keet-core-terminal-exit-")))
    try {
      const subscription = core.watchMessages("group-test", () => undefined)
      const reason = await new Promise<"closed" | "connection-failed">((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("subscription did not terminate")), 1_500)
        subscription.onTerminate?.((value) => { clearTimeout(timer); resolve(value) })
      })
      expect(reason).toBe("connection-failed")
      expect(subscription.closed).toBe(true)
      expect(subscription.terminationReason).toBe("connection-failed")
      await expect(core.status()).rejects.toThrow("status is unavailable")
    } finally {
      await core.close()
    }
  })

  it("reports intentional shutdown separately and releases exclusive identity ownership", async () => {
    const data = await dataPath()
    const first = new KeetSidecar(processOptions(data))
    const second = new KeetSidecar(processOptions(data))
    await first.start()
    try {
      await expect(second.start()).rejects.toThrow("already owned")
    } finally {
      await first.close()
    }
    await second.start()
    try {
      await expect(second.status()).resolves.toMatchObject({ state: "ready" })
    } finally {
      await second.close()
    }

    const core = await KeetIntegrationCore.start(processOptions(await dataPath()))
    try {
      const subscription = core.watchMessages("group-test", () => undefined)
      const reason = new Promise<"closed" | "connection-failed">((resolve) => subscription.onTerminate?.(resolve))
      await core.close()
      await expect(reason).resolves.toBe("closed")
      expect(subscription.terminationReason).toBe("closed")
    } finally {
      await core.close()
    }
  })
})
