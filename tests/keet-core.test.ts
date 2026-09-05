import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { KeetIntegrationCore, KeetSidecar, validateAdmission, type KeetSidecarLog } from "../packages/keet-core/src/index.js"
import { classifyTrigger } from "../packages/dsh-keet/src/keet-protocol.js"

const fixture = fileURLToPath(new URL("./fixtures/fake-worker.mjs", import.meta.url))
const nodeExecutable = execFileSync("which", ["node"], { encoding: "utf8" }).trim()
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function dataPath(prefix = "keet-core-test-"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function options(data: string, logger?: (entry: KeetSidecarLog) => void, overrides: Record<string, unknown> = {}) {
  const value = { executablePath: nodeExecutable, bundlePath: fixture, dataPath: data, swarming: false, startupTimeoutMs: 3_000, shutdownTimeoutMs: 1_000, ...overrides }
  return logger ? { ...value, logger } : value
}

describe("typed Keet Integration Core", () => {
  it("admits only the pinned Linux tuple and validates an explicit addon closure", () => {
    const base = { executablePath: "/tmp/bare", bundlePath: "/tmp/core-worker.bundle", dataPath: "/tmp/identity", platform: "linux", arch: "x64" }
    expect(() => validateAdmission({ ...base, nativeAddonPaths: Array.from({ length: 25 }, (_, index) => `addon-${index}`) })).not.toThrow()
    expect(() => validateAdmission({ ...base, platform: "darwin" })).toThrow("Linux x86-64")
    expect(() => validateAdmission({ ...base, expectedAbi: 34 })).toThrow("ABI")
    expect(() => validateAdmission({ ...base, nativeAddonPaths: ["one"] })).toThrow("closure")
  })

  it("fails closed when a bundle advertises malformed manifest framing", async () => {
    const data = await dataPath()
    const bundle = path.join(data, "malformed.bundle")
    await writeFile(bundle, "3\n{}")
    await expect(new KeetSidecar({ ...options(data), bundlePath: bundle }).start()).rejects.toThrow("closure")
  })

  it("fails startup when the pinned worker does not provide an identity", async () => {
    const data = await dataPath("keet-core-missing-identity-")
    await expect(KeetIntegrationCore.start(options(data))).rejects.toThrow("identity is unavailable")
  })

  it("boots through fd-3, normalizes bounded groups/members/messages, and redacts worker output", async () => {
    const data = await dataPath()
    const logs: KeetSidecarLog[] = []
    const core = await KeetIntegrationCore.start(options(data, (entry) => logs.push(entry)))
    expect(await core.status()).toMatchObject({ state: "ready", appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: false, identityId: "identity-self", displayName: "Fixture Bot" })
    expect(await core.listGroups()).toEqual([{ groupId: "group-test", title: "Test group", description: "fixture", roomType: "Default" }])
    expect(await core.listMembers("group-test")).toEqual([
      { memberId: "identity-self", displayName: "Fixture Bot" },
      { memberId: "member-alice", displayName: "Alice" },
    ])
    expect(await core.readRecentMessages("group-test", 50)).toEqual([
      expect.objectContaining({ messageId: { deviceId: "device-alice", seq: 1 }, senderId: "member-alice", text: "initial context" }),
      expect.objectContaining({ messageId: { deviceId: "device-self", seq: 2 }, senderId: "identity-self", text: "initial self" }),
    ])
    await expect(core.readRecentMessages("group-test", 0)).rejects.toThrow("1 to 50")
    await expect(core.readRecentMessages("other", 1)).resolves.toEqual([])
    await core.close()
    const rendered = JSON.stringify(logs)
    expect(rendered).not.toContain(data)
    expect(logs.map((entry) => entry.event)).toContain("sidecar.worker-output-discarded")
  })

  it("normalizes the official v1 member label and chat mentions while excluding edits", async () => {
    const core = await KeetIntegrationCore.start(options(await dataPath("keet-core-official-shape-")))
    const history = await core.readRecentMessages("group-test", 50)
    expect(history).toEqual([
      {
        messageId: { deviceId: "device-alice", seq: 11 },
        groupId: "group-test",
        senderId: "member-alice",
        senderLabel: "Official Alice",
        timestamp: 4,
        text: "official mention",
        mentions: ["identity-self"],
      },
    ])
    expect(classifyTrigger(history[0]!, { memberId: "identity-self", displayName: "Fixture Bot" }, new Set())?.triggerKind).toBe("mention")
    await core.close()
  })

  it("normalizes admitted room kinds and rejects a resolved DM with the wrong kind", async () => {
    const typed = await KeetIntegrationCore.start(options(await dataPath("keet-core-room-types-")))
    expect(await typed.listGroups()).toEqual([
      { groupId: "group-test", title: "Test group", description: "fixture", roomType: "Default" },
      { groupId: "group-broadcast", title: "Broadcast", description: "fixture broadcast", roomType: "Broadcast" },
    ])
    await typed.close()

    const wrongDm = await KeetIntegrationCore.start(options(await dataPath("keet-core-dm-broadcast-")))
    await expect(wrongDm.resolveDm("member-peer")).rejects.toThrow("unsupported room type")
    await wrongDm.close()
  })

  it("suppresses the initial snapshot, forwards live self and external text, filters nonordinary records, deduplicates, and tears down", async () => {
    const core = await KeetIntegrationCore.start(options(await dataPath()))
    const received: Array<{ senderId: string; text: string }> = []
    const subscription = core.watchMessages("group-test", (message) => received.push({ senderId: message.senderId, text: message.text }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received).toEqual([])
    await core.sendMessage("group-test", "self message")
    await core.sendMessage("group-test", "[human] first external")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received).toEqual([
      { senderId: "identity-self", text: "self message" },
      { senderId: "member-alice", text: "first external" },
    ])
    expect(subscription.closed).toBe(false)
    await subscription.close()
    expect(subscription.closed).toBe(true)
    await core.close()
  })

  it("terminates subscriptions and RPC calls when the ready worker exits", async () => {
    const core = await KeetIntegrationCore.start(options(await dataPath("keet-core-terminal-exit-")))
    const subscription = core.watchMessages("group-test", () => undefined)
    const reason = await new Promise<"closed" | "connection-failed">((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("subscription did not terminate")), 1_500)
      subscription.onTerminate?.((value) => { clearTimeout(timer); resolve(value) })
    })
    expect(reason).toBe("connection-failed")
    expect(subscription.closed).toBe(true)
    expect(subscription.terminationReason).toBe("connection-failed")
    await expect(core.status()).rejects.toThrow("status is unavailable")
    await core.close()
  })

  it("reports an intentional Core close separately from a connection failure", async () => {
    const core = await KeetIntegrationCore.start(options(await dataPath()))
    const subscription = core.watchMessages("group-test", () => undefined)
    const reason = new Promise<"closed" | "connection-failed">((resolve) => subscription.onTerminate?.(resolve))
    await core.close()
    await expect(reason).resolves.toBe("closed")
    expect(subscription.terminationReason).toBe("closed")
  })

  it("preserves canonical Keet replyTo IDs and rejects targets outside the selected group before mutation", async () => {
    const core = await KeetIntegrationCore.start(options(await dataPath()))
    const target = { deviceId: "device-alice", seq: 1 }
    const sent = await core.sendMessage("group-test", "reply", target)
    expect(sent).toEqual({ deviceId: "device-self", seq: 10 })
    await expect(core.sendMessage("group-test", "bad", { deviceId: "attacker", seq: 999 })).rejects.toThrow("reply target was not found")
    const history = await core.readRecentMessages("group-test", 50)
    expect(history.some((message) => message.text === "reply" && message.replyTo && message.replyTo.deviceId === target.deviceId && message.replyTo.seq === target.seq)).toBe(true)
    await core.close()
  })

  it("uses official invitation/profile calls and propagates cancellation without provider details", async () => {
    const core = await KeetIntegrationCore.start(options(await dataPath()))
    await expect(core.inspectInvitation("https://not-keet")).rejects.toThrow("room invitation")
    await expect(core.inspectInvitation("keet://chat/fixture-token")).resolves.toMatchObject({ isRoomInvitation: true })
    await expect(core.joinInvitation("keet://chat/fixture-token")).resolves.toEqual({ groupId: "group-test" })
    await core.updateDisplayName("  New Fixture Name  ")
    expect((await core.status()).displayName).toBe("New Fixture Name")
    const controller = new AbortController()
    controller.abort()
    await expect(core.readRecentMessages("group-test", 1, controller.signal)).rejects.toThrow("cancelled")
    await core.close()
  })

  it("resolves and accepts a DM from the official-shaped room list without a dedicated lookup RPC", async () => {
    const core = await KeetIntegrationCore.start(options(await dataPath("keet-core-dm-flow-")))
    expect(await core.listGroups()).toEqual([
      { groupId: "group-test", title: "Test group", description: "fixture", roomType: "Default" },
      { groupId: "group-dm", title: "Managed DM", description: "fixture DM", roomType: "DirectMessage", dmMemberId: "member-peer" },
    ])
    expect(await core.listPendingDmRequests()).toEqual([{ memberId: "member-peer", displayName: "Peer" }])
    await expect(core.resolveDm("member-peer")).rejects.toThrow("not resolved")
    const accepted = await core.acceptDmRequest("member-peer")
    expect(accepted).toEqual({ groupId: "group-dm", roomType: "DirectMessage", dmMemberId: "member-peer", title: "Managed DM", description: "fixture DM" })
    expect(await core.resolveDm("member-peer")).toEqual(accepted)
    expect(await core.listPendingDmRequests()).toEqual([])
    await expect(core.acceptDmRequest("member-peer")).rejects.toThrow("already resolved")
    await core.close()
  })

  it("enriches a typed compact DirectMessage record when room info supplies the peer", async () => {
    const core = await KeetIntegrationCore.start(options(await dataPath("keet-core-dm-typed-compact-")))
    expect(await core.listGroups()).toEqual([
      { groupId: "group-test", title: "Test group", description: "fixture", roomType: "Default" },
      { groupId: "group-dm", title: "Managed DM", description: "fixture DM", roomType: "DirectMessage", dmMemberId: "member-peer" },
    ])
    await expect(core.resolveDm("member-peer")).resolves.toEqual({ groupId: "group-dm", roomType: "DirectMessage", dmMemberId: "member-peer", title: "Managed DM", description: "fixture DM" })
    await core.close()
  })

  it("waits for a delayed accepted DM room to converge through the canonical room list", async () => {
    const core = await KeetIntegrationCore.start(options(await dataPath("keet-core-dm-delayed-"), undefined, { pairingTimeoutMs: 3_000 }))
    expect(await core.listGroups()).toEqual([{ groupId: "group-test", title: "Test group", description: "fixture", roomType: "Default" }])
    expect(await core.listPendingDmRequests()).toEqual([{ memberId: "member-peer", displayName: "Peer" }])
    const accepted = await core.acceptDmRequest("member-peer")
    expect(accepted).toEqual({ groupId: "group-dm", roomType: "DirectMessage", dmMemberId: "member-peer", title: "Managed DM", description: "fixture DM" })
    expect(await core.listGroups()).toEqual([
      { groupId: "group-test", title: "Test group", description: "fixture", roomType: "Default" },
      { groupId: "group-dm", title: "Managed DM", description: "fixture DM", roomType: "DirectMessage", dmMemberId: "member-peer" },
    ])
    await core.close()
  })

  it("fails closed for zero, duplicate, mismatched-peer, and non-DM room matches", async () => {
    const cases = [
      { prefix: "keet-core-dm-missing-", message: "not resolved" },
      { prefix: "keet-core-dm-duplicate-", message: "ambiguous" },
      { prefix: "keet-core-dm-mismatched-peer-", message: "not resolved" },
      { prefix: "keet-core-dm-broadcast-", message: "unsupported room type" },
      { prefix: "keet-core-dm-default-", message: "unsupported room type" },
    ]
    for (const testCase of cases) {
      const core = await KeetIntegrationCore.start(options(await dataPath(testCase.prefix)))
      await expect(core.resolveDm("member-peer")).rejects.toThrow(testCase.message)
      await core.close()
    }
  })

  it("encodes bounded prepared avatar variants and preserves the current name for avatar-only updates", async () => {
    const core = await KeetIntegrationCore.start(options(await dataPath("keet-core-avatar-")))
    const makeVariant = (size: number) => {
      const bytes = Buffer.from(`avatar-${size}`)
      return { bytes, contentType: "image/png", width: size, height: size, hash: createHash("sha256").update(bytes).digest("hex") }
    }
    const avatar = { small: makeVariant(64), medium: makeVariant(128), large: makeVariant(256) }
    await core.updateIdentityProfile({ avatar })
    expect((await core.status()).displayName).toBe("Fixture Bot")
    expect((await core.listMembers("group-test")).find((member) => member.memberId === "identity-self")?.avatar).toMatchObject({ present: true })
    const invalid = { ...avatar, small: { ...avatar.small, hash: "0".repeat(64) } }
    await expect(core.updateIdentityProfile({ avatar: invalid })).rejects.toThrow("hash does not match")
    await core.close()
  })

  it("rejects an oversized prepared avatar before any profile RPC", async () => {
    const core = await KeetIntegrationCore.start(options(await dataPath("keet-core-avatar-boundary-")))
    const calls: string[] = []
    const originalCall = core.sidecar.call.bind(core.sidecar)
    core.sidecar.call = async (name, args) => {
      calls.push(name)
      return originalCall(name, args)
    }
    const oversizedBytes = Buffer.alloc(512 * 1024 + 1, 0x61)
    const makeVariant = (size: number, bytes = Buffer.from(`avatar-${size}`)) => ({
      bytes,
      contentType: "image/png",
      width: size,
      height: size,
      hash: createHash("sha256").update(bytes).digest("hex"),
    })
    const avatar = { small: makeVariant(64, oversizedBytes), medium: makeVariant(128), large: makeVariant(256) }
    await expect(core.updateIdentityProfile({ avatar })).rejects.toThrow("too large or invalid")
    expect(calls).toEqual([])
    await core.close()
  })

  it("enforces exclusive identity ownership and releases it on close", async () => {
    const data = await dataPath()
    const first = new KeetSidecar(options(data))
    const second = new KeetSidecar(options(data))
    await first.start()
    await expect(second.start()).rejects.toThrow("already owned")
    await first.close()
    await second.start()
    await second.close()
  })
})
