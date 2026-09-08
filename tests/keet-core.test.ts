import { afterEach, describe, expect, it, vi } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { PassThrough } from "node:stream"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { KeetSidecarStatus, KeetSidecarLog } from "../packages/keet-core/src/sidecar.js"
import { KeetIntegrationCore, KeetSidecar, validateAdmission, validateKeetReaction, type PreparedAvatar, type ManagedGroup } from "../packages/keet-core/src/index.js"
import type { RpcMethodName } from "../packages/keet-core/src/rpc-methods.js"
import { classifyTrigger } from "../packages/dsh-keet/src/keet-protocol.js"

const fixture = fileURLToPath(new URL("./fixtures/fake-worker.mjs", import.meta.url))
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
const lockHolderFixture = fileURLToPath(new URL("./fixtures/sidecar-lock-holder.mjs", import.meta.url))
const nodeExecutable = [
  process.env.KEET_TEST_NODE,
  ...((process.env.PATH ?? "").split(path.delimiter).map((directory) => path.join(directory, "node"))),
  "/usr/bin/node",
  "/run/current-system/sw/bin/node",
  process.execPath,
].find((candidate): candidate is string => typeof candidate === "string" && existsSync(candidate))!
const temporaryDirectories: string[] = []
const mockCores: KeetIntegrationCore[] = []
const lockProcesses: ChildProcess[] = []

afterEach(async () => {
  const children = lockProcesses.splice(0)
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
  await Promise.all(children.map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()))
  }))
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

function spawnLockProcess(mode: "hold" | "attempt", data: string): ChildProcess {
  const child = spawn(nodeExecutable, ["--import", "tsx/esm", lockHolderFixture, mode, data], {
    cwd: path.resolve(path.dirname(lockHolderFixture), "..", ".."),
    stdio: ["ignore", "pipe", "pipe"],
  })
  lockProcesses.push(child)
  return child
}

async function waitForProcessLine(child: ChildProcess, expected: string): Promise<void> {
  let output = ""
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for lock process output: ${output}`)), 5_000)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      child.stdout?.off("data", onData)
      child.off("exit", onExit)
      if (error) reject(error)
      else resolve()
    }
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString()
      if (output.split(/\r?\n/).includes(expected)) finish()
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`lock process exited before ${expected} (${code ?? "?"}/${signal ?? "?"}): ${output}`))
    child.stdout?.on("data", onData)
    child.once("exit", onExit)
    child.once("error", (error) => finish(error))
  })
}

async function collectProcess(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString() })
  child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString() })
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]))
  })
  return { code, signal, stdout, stderr }
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
    { timestamp: 7, memberId: "member-alice", id: { deviceId: "device-alice", seq: 14 }, deleted: true, text: "deleted official record", type: "text" },
    { timestamp: 8, memberId: "member-alice", id: { deviceId: "device-alice", seq: 15 }, text: "unsupported official record", type: "system" },
    { timestamp: 9, memberId: "member-alice", id: { deviceId: "device-alice", seq: 16 }, text: "x".repeat(16_001), type: "text" },
    { timestamp: 10, memberId: "member-alice", id: { deviceId: "device-alice", seq: 17 }, text: "relation-only official record", type: "text", relatesTo: { event: "reaction" } },
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
    }, {
      messageId: { deviceId: "device-alice", seq: 12 },
      groupId: "group-test",
      senderId: "member-alice",
      senderLabel: "Official Alice",
      timestamp: 5,
      text: "edited official record",
    }])
    expect(history[0]).not.toHaveProperty("replyTo")
    expect(classifyTrigger(history[0]!, { memberId: "identity-self", displayName: "Fixture Bot" }, new Set())?.triggerKind).toBe("mention")
  })

  it("normalizes the official reaction digest, own reactions, and malformed-entry bounds", async () => {
    const digest = {
      digest: {
        reactions: [
          { text: "👍🏽", count: 3 },
          { text: "❤️", count: 1 },
          { text: "not a reaction", count: 7 },
          { text: "😀", count: 0 },
          ...["😃", "😄", "😅", "😆", "😉", "😊", "😋", "😎", "😍", "😘", "🥰", "😗", "😙", "😚", "🙂", "🤗", "🤩", "🤔", "🤨", "😐", "😑", "😶", "🙄", "😏", "😣", "😥", "😮", "🤐", "😯", "😪"].map((text) => ({ text, count: 1 })),
        ],
      },
      mine: ["❤️"],
    }
    const harness = makeMockCore({ messages: [{
      roomId: "group-test",
      messageId: { deviceId: "device-alice", seq: 20 },
      senderId: "member-alice",
      senderName: "Alice",
      timestamp: 1,
      type: "text",
      text: "reacted message",
      reactions: digest,
    }] })
    const history = await harness.core.readRecentMessages("group-test", 50)
    expect(history[0]?.reactions).toEqual(expect.arrayContaining([
      { emoji: "❤️", count: 1, own: true },
    ]))
    expect(history[0]?.reactions).toHaveLength(16)
    expect(history[0]?.reactions?.some((reaction) => reaction.emoji === "not a reaction" || reaction.count < 1)).toBe(false)
    expect(history[0]?.text).toBe("reacted message")
  })

  it("normalizes bounded Keet wire shortcodes without relaxing outbound emoji validation", async () => {
    const harness = makeMockCore({ messages: [{
      roomId: "group-test",
      messageId: { deviceId: "device-alice", seq: 21 },
      senderId: "member-alice",
      senderName: "Alice",
      timestamp: 1,
      type: "text",
      text: "Keet wire shortcode reactions",
      reactions: {
        digest: { reactions: [
          { text: "heart", count: 2, latest: [] },
          { text: "+1", count: 1, latest: [] },
          { text: "keet_laughs", count: 1, latest: [] },
          { text: "not a reaction", count: 1, latest: [] },
          { text: "heart!", count: 1, latest: [] },
          { text: "heart:alt", count: 1, latest: [] },
        ] },
        mine: ["+1", "bad!"],
      },
    }] })

    const history = await harness.core.readRecentMessages("group-test", 50)
    expect(history[0]?.reactions).toEqual([
      { emoji: ":+1:", count: 1, own: true },
      { emoji: ":heart:", count: 2, own: false },
      { emoji: ":keet_laughs:", count: 1, own: false },
    ])
    expect(() => validateKeetReaction("heart")).toThrow("reaction must be exactly one Unicode emoji")
  })

  it("accepts representative composed emoji graphemes and rejects text, multiples, and oversized input", () => {
    for (const value of ["👍", "👍🏽", "🇹🇼", "1️⃣", "❤️", "👩‍💻", "🧑‍🤝‍🧑"]) {
      expect(validateKeetReaction(value)).toBe(value)
    }
    for (const value of ["", " hello", "hello", ":thumbsup:", "👍👍", "a‍😀", "😀🏽", "❤️🏽", "😀‍😀", "♥︎", "©", "😀".repeat(70)]) {
      expect(() => validateKeetReaction(value)).toThrow(/reaction must be exactly one|bounded/)
    }
  })

  it("validates and dispatches add-reaction through RPC 156 with cancellation and result checks", async () => {
    const calls: unknown[][] = []
    const harness = makeMockCore({ handlers: {
      addReaction: (args) => { calls.push(args); return { key: Buffer.alloc(32), length: 1 } },
    } })
    await harness.core.addReaction("group-test", { deviceId: "device-alice", seq: 1 }, "👍🏽")
    expect(calls).toEqual([["group-test", { deviceId: "device-alice", seq: 1 }, "👍🏽"]])
    await expect(harness.core.addReaction("group-test", { deviceId: "", seq: 1 }, "👍🏽")).rejects.toThrow("valid Keet message ID")
    const invalid = makeMockCore({ handlers: { addReaction: () => ({ ok: false }) } })
    await expect(invalid.core.addReaction("group-test", { deviceId: "device-alice", seq: 1 }, "👍🏽")).rejects.toThrow("invalid reaction result")
    const cancelled = makeMockCore({ handlers: { addReaction: () => new Promise(() => undefined) } })
    const controller = new AbortController()
    const pending = cancelled.core.addReaction("group-test", { deviceId: "device-alice", seq: 1 }, "👍🏽", controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow("cancelled")
  })

  it("reads complete reaction state for an exact message without a recent-history window", async () => {
    const harness = makeMockCore({ handlers: { getReactions: () => ({
      digest: { total: 3, reactions: [{ text: "✅", count: 2 }, { text: "❌", count: 1 }] }, mine: ["✅", "❌"],
    }) } })
    const target = { deviceId: "device-self", seq: 2 }
    await expect(harness.core.readReactions("group-test", target)).resolves.toEqual([
      { emoji: "✅", count: 2, own: true }, { emoji: "❌", count: 1, own: true },
    ])
    expect(harness.state.calls).toEqual([{ name: "getReactions", args: ["group-test", target] }])
    await expect(harness.core.readReactions("group-test", { deviceId: "", seq: 2 })).rejects.toThrow("valid Keet message ID")
    const absent = makeMockCore({ handlers: { getReactions: () => null } })
    await expect(absent.core.readReactions("group-test", target)).resolves.toBeNull()
  })

  it("never interprets incomplete ownership or a truncated reaction snapshot as participant intent", async () => {
    const entry = { text: "✅", count: 1 }
    for (const value of [
      undefined, {}, { digest: { reactions: [entry] } },
      { digest: { reactions: [entry] }, mine: "✅" },
      { digest: { reactions: [entry, entry] }, mine: ["✅"] },
      { digest: { reactions: [{ text: "✅", count: 0 }] }, mine: [] },
      { digest: { reactions: [entry] }, mine: ["❌"] },
      { digest: { reactions: [entry] }, mine: ["✅", "✅"] },
      { digest: { reactions: Array(17).fill(entry) }, mine: [] },
    ]) {
      const harness = makeMockCore({ handlers: { getReactions: () => value } })
      await expect(harness.core.readReactions("group-test", { deviceId: "device-self", seq: 2 })).rejects.toThrow("invalid reaction snapshot")
    }
    const cancelled = makeMockCore({ handlers: { getReactions: () => new Promise(() => undefined) } })
    const controller = new AbortController()
    const pending = cancelled.core.readReactions("group-test", { deviceId: "device-self", seq: 2 }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow("cancelled")
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
    harness.emit([{ roomId: "group-test", id: { deviceId: "device-alice", seq: 6 }, memberId: "member-alice", message: { text: "edited live" }, chat: { text: "edited live", edited: true }, timestamp: 3, type: "text" }])
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

  it("sends verified native mention records without accepting stale member IDs", async () => {
    const harness = makeMockCore()
    await expect(harness.core.sendMessage("group-test", "welcome", undefined, undefined, ["member-alice", "member-alice"])).resolves.toEqual({ deviceId: "device-self", seq: 10 })
    expect(harness.state.calls.at(-1)).toEqual({ name: "addChatMessage", args: ["group-test", "welcome", { mentions: [{ type: "mention", memberId: "member-alice" }] }] })
    await expect(harness.core.sendMessage("group-test", "stale", undefined, undefined, ["member-gone"])).rejects.toThrow("mentioned member is not in")
    expect(harness.state.calls.at(-1)?.name).not.toBe("addChatMessage")
  })

  it("maps invitation inspection, creation, joining, and cancellation without provider details", async () => {
    const joined = makeMockCore({ handlers: {
      getLinkInfo: ([token]) => token === "fixture-token" ? { isRoomInvitation: true, title: "Joined" } : { isRoomInvitation: false },
      startPairingRoom: () => ({ roomId: "group-joined" }),
    } })
    await expect(joined.core.inspectInvitation("https://not-keet")).rejects.toThrow("room invitation")
    await expect(joined.core.inspectInvitation("keet://chat/fixture-token")).resolves.toMatchObject({ isRoomInvitation: true })
    await expect(joined.core.createRoom({ title: "  New room  ", description: "description" })).resolves.toBe("group-created")
    await expect(joined.core.createRoom({ title: " Broadcast room ", roomType: "Broadcast" })).resolves.toBe("group-created")
    expect(joined.state.calls.at(-1)).toEqual({ name: "createRoom", args: [{ config: { title: "Broadcast room", roomType: "1" } }] })
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

  it("registers or updates a username and proves the requested lookup converged", async () => {
    let registrationLookups = 0
    const registration = makeMockCore({
      handlers: {
        checkUsername: () => true,
        registerUsername: () => true,
        lookupUsername: () => ++registrationLookups === 1 ? null : { memberId: "identity-self", username: "agent_name1", displayName: "Fixture Bot" },
      },
    })
    await expect(registration.core.setUsername("agent_name1")).resolves.toEqual({ status: "searchable", submitted: true })
    expect(registration.state.calls.filter(({ name }) => ["checkUsername", "registerUsername", "updateUsername", "lookupUsername"].includes(name))).toEqual([
      { name: "checkUsername", args: ["agent_name1"] },
      { name: "registerUsername", args: ["agent_name1"] },
      { name: "lookupUsername", args: ["agent_name1"] },
      { name: "lookupUsername", args: ["agent_name1"] },
    ])

    const update = makeMockCore({
      identity: { memberId: "identity-self", displayName: "Fixture Bot", username: "old_name1" },
      handlers: {
        checkUsername: () => true,
        updateUsername: () => true,
        lookupUsername: () => ({ memberId: "identity-self", username: "new_name2" }),
      },
    })
    await expect(update.core.setUsername("new_name2")).resolves.toEqual({ status: "searchable", submitted: true })
    expect(update.state.calls.some(({ name, args }) => name === "updateUsername" && args[0] === "new_name2")).toBe(true)
    expect(update.state.calls.some(({ name }) => name === "registerUsername")).toBe(false)
  })

  it("makes an exact current username idempotent without availability or mutation RPCs", async () => {
    const harness = makeMockCore({
      identity: { memberId: "identity-self", profile: { displayName: "Fixture Bot", username: "agent_name1" } },
      handlers: { lookupUsername: () => ({ memberId: "identity-self", username: "agent_name1" }) },
    })
    await expect(harness.core.setUsername("agent_name1")).resolves.toEqual({ status: "searchable", submitted: false })
    expect(harness.state.calls.map(({ name }) => name)).toEqual(["getIdentity", "lookupUsername"])
  })

  it("fails closed for unavailable, malformed, rejected, and failed username operations", async () => {
    const unavailable = makeMockCore({ handlers: { checkUsername: () => false } })
    await expect(unavailable.core.setUsername("agent_name1")).rejects.toThrow("username is unavailable")
    expect(unavailable.state.calls.some(({ name }) => name === "registerUsername")).toBe(false)

    const malformedAvailability = makeMockCore({ handlers: { checkUsername: () => ({ available: true }) } })
    await expect(malformedAvailability.core.setUsername("agent_name1")).rejects.toThrow("invalid username availability")

    const rejected = makeMockCore({ handlers: { checkUsername: () => true, registerUsername: () => false } })
    await expect(rejected.core.setUsername("agent_name1")).rejects.toThrow("did not accept")

    const malformedLookup = makeMockCore({ handlers: { checkUsername: () => true, registerUsername: () => true, lookupUsername: () => ({ username: "agent_name1" }) } })
    await expect(malformedLookup.core.setUsername("agent_name1")).rejects.toThrow("invalid username lookup")

    const wrongOwner = makeMockCore({ handlers: { checkUsername: () => true, registerUsername: () => true, lookupUsername: () => ({ username: "agent_name1", memberId: "identity-other" }) } })
    await expect(wrongOwner.core.setUsername("agent_name1")).rejects.toThrow("Keet username became unavailable")

    const nativeFailure = makeMockCore({ handlers: { checkUsername: () => { throw new Error("sensitive registry detail") } } })
    await expect(nativeFailure.core.setUsername("agent_name1")).rejects.toThrow("Keet operation failed")

    const malformedIdentity = makeMockCore({ identity: { memberId: "identity-self", username: { bad: true } } })
    await expect(malformedIdentity.core.setUsername("agent_name1")).rejects.toThrow("identity username is invalid")
  })

  it("uses the full convergence deadline and reports submitted pending state", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(60_001)
    try {
      const harness = makeMockCore({ handlers: { checkUsername: () => true, registerUsername: () => true, lookupUsername: () => null } })
      await expect(harness.core.setUsername("agent_name1")).resolves.toEqual({ status: "pending", submitted: true })
      expect(harness.state.calls.filter(({ name }) => name === "lookupUsername")).toHaveLength(1)
    } finally {
      clock.mockRestore()
    }
  })

  it("converges after more than the old attempt cap without waiting on wall clock time", async () => {
    let now = 0
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delayMs?: number) => {
      now += Number(delayMs ?? 0)
      callback()
      return 0 as never
    }) as unknown as typeof setTimeout)
    try {
      let lookups = 0
      const harness = makeMockCore({ handlers: {
        checkUsername: () => true,
        registerUsername: () => true,
        lookupUsername: () => ++lookups <= 33 ? null : { memberId: "identity-self", username: "agent_name1" },
      } })
      const result = harness.core.setUsername("agent_name1")
      await expect(result).resolves.toEqual({ status: "searchable", submitted: true })
      expect(lookups).toBe(34)
    } finally {
      timers.mockRestore()
      clock.mockRestore()
    }
  })

  it("cancels username convergence instead of converting cancellation to pending", async () => {
    const controller = new AbortController()
    const harness = makeMockCore({ handlers: {
      checkUsername: () => true,
      registerUsername: () => true,
      lookupUsername: () => { controller.abort(); return null },
    } })
    await expect(harness.core.setUsername("agent_name1", controller.signal)).rejects.toThrow("cancelled")
  })
})

describe("Keet Integration Core fd-3 process contracts", () => {
  it("cancels startup before spawn and releases the acquired identity lock", async () => {
    const data = await dataPath("keet-cancel-start-")
    const controller = new AbortController()
    const startup = KeetIntegrationCore.start(processOptions(data, (entry) => {
      if (entry.event === "sidecar.starting") controller.abort()
    }), controller.signal)
    await expect(startup).rejects.toThrow()
    const replacement = await KeetIntegrationCore.start(processOptions(data))
    try { await expect(replacement.status()).resolves.toMatchObject({ state: "ready" }) }
    finally { await replacement.close() }
  })

  it("cancels a stalled initial identity RPC and waits for worker shutdown before completing", async () => {
    const data = await dataPath("keet-identity-stall-")
    const controller = new AbortController()
    const startup = KeetIntegrationCore.start(processOptions(data), controller.signal)
    const failed = expect(startup).rejects.toThrow()
    try {
      await vi.waitFor(async () => expect(await readFile(path.join(data, "identity-read-started"), "utf8")).toBe("ready"), { timeout: 3_000 })
    } finally { controller.abort() }
    await failed
    // Sidecar boot does not read identity: reacquiring this exact directory
    // proves cancellation waited for the previous process and kernel lock.
    const replacement = new KeetSidecar(processOptions(data))
    try { await replacement.start() }
    finally { await replacement.close() }
  })

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
      await expect(core.addReaction("group-test", { deviceId: "device-alice", seq: 1 }, "👍🏽")).resolves.toBeUndefined()
      await expect(core.readReactions("group-test", { deviceId: "device-alice", seq: 1 })).resolves.toEqual([])
      const receivedImage = await core.readImage("group-test", {
        file: { pointer: { externalBlob: { id: "fixture-image", blob: Buffer.from("streamed-image") } } },
        mediaType: "image/png",
      })
      expect(Buffer.from(receivedImage)).toEqual(Buffer.from("streamed-image"))
      await expect(core.sendImage("group-test", { bytes: PNG_1X1, mediaType: "image/png", width: 1, height: 1 })).resolves.toBeUndefined()
      expect((await core.readRecentMessages("group-test", 50)).some((message) => message.reactions?.length)).toBe(false)
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

  it("uses the persistent kernel lock for live contention and abnormal-death recovery", async () => {
    const data = await dataPath("keet-core-lock-")
    const lockPath = path.join(data, ".keet-sidecar.lock")
    await writeFile(lockPath, JSON.stringify({ pid: 999_999 }))
    const staleRecovery = spawnLockProcess("attempt", data)
    const staleResult = await collectProcess(staleRecovery)
    expect(staleResult.code).toBe(0)
    expect(staleResult.stdout).toContain("ready")
    expect(existsSync(lockPath)).toBe(true)

    const holder = spawnLockProcess("hold", data)
    await waitForProcessLine(holder, "ready")

    const contender = spawnLockProcess("attempt", data)
    const contention = await collectProcess(contender)
    expect(contention.code).toBe(1)
    expect(contention.signal).toBeNull()
    expect(contention.stdout).toBe("")
    expect(contention.stderr).toContain("already owned")

    holder.kill("SIGTERM")
    const normalClose = await collectProcess(holder)
    expect(normalClose.code).toBe(0)
    expect(existsSync(lockPath)).toBe(true)

    const normalReacquire = spawnLockProcess("hold", data)
    await waitForProcessLine(normalReacquire, "ready")
    normalReacquire.kill("SIGKILL")
    const crash = await collectProcess(normalReacquire)
    expect(crash.signal).toBe("SIGKILL")
    expect(existsSync(lockPath)).toBe(true)
    await expect(stat(lockPath)).resolves.toMatchObject({ mode: expect.any(Number) })
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600)

    const crashReacquire = spawnLockProcess("attempt", data)
    const recovered = await collectProcess(crashReacquire)
    expect(recovered.code).toBe(0)
    expect(recovered.signal).toBeNull()
    expect(recovered.stdout).toContain("ready")
  })

  it("releases identity ownership when logging throws", async () => {
    const data = await dataPath("keet-core-logger-lock-")
    const first = new KeetSidecar(processOptions(data, () => { throw new Error("logger failed") }))
    await expect(first.start()).resolves.toBeUndefined()
    await expect(first.close()).resolves.toBeUndefined()

    const second = new KeetSidecar(processOptions(data))
    await expect(second.start()).resolves.toBeUndefined()
    try {
      await expect(second.status()).resolves.toMatchObject({ state: "ready" })
    } finally {
      await second.close()
    }
  })
})


describe("group departure", () => {
  it("dispatches the exact native room selector once and rejects canceled or invalid input", async () => {
    const { core, state } = makeMockCore({ handlers: { leaveRoom: () => undefined } })
    await core.leaveGroup("group-test")
    expect(state.calls.filter((call) => call.name === "leaveRoom")).toEqual([{ name: "leaveRoom", args: ["group-test"] }])
    await expect(core.leaveGroup("")).rejects.toThrow()
    await expect(core.leaveGroup("group-test", AbortSignal.abort())).rejects.toThrow()
    expect(state.calls.filter((call) => call.name === "leaveRoom")).toHaveLength(1)
  })
  it("redacts a failed native departure", async () => {
    const { core } = makeMockCore({ handlers: { leaveRoom: () => { throw new Error("private worker detail") } } })
    await expect(core.leaveGroup("group-test")).rejects.toThrow("Keet operation failed")
  })
})
