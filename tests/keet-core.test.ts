import { afterEach, describe, expect, it } from "vitest"
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

function options(data: string, logger?: (entry: KeetSidecarLog) => void) {
  const value = { executablePath: nodeExecutable, bundlePath: fixture, dataPath: data, swarming: false, startupTimeoutMs: 3_000, shutdownTimeoutMs: 1_000 }
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
    expect(await core.listGroups()).toEqual([{ groupId: "group-test", title: "Test group", description: "fixture" }])
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

  it("preserves canonical Keet replyTo IDs and rejects targets outside the fixed group before mutation", async () => {
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
