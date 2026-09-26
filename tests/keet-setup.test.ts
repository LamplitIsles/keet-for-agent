import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import sharp from "sharp"
import type { KeetCoreOptions } from "../packages/keet-core/src/index.js"
import { parseSetupArgs, readInvitation, runSetup } from "../packages/keet-mcp/src/setup.js"
import { prepareAvatar } from "../packages/keet-mcp/src/setup-avatar.js"

const temporary: string[] = []
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function harness() {
  const identity = await mkdtemp(path.join(tmpdir(), "keet-setup-test-"))
  temporary.push(identity)
  const output: string[] = [], errors: string[] = []
  const core = {
    status: vi.fn(async () => ({ state: "ready" as const, identityId: "self", appVersion: "4.22.0", coreVersion: "4.22.20", abi: 35, swarming: true })),
    listGroups: vi.fn(async () => [{ groupId: "group-1", title: "Friends", roomType: "Default" as const }]),
    inspectInvitation: vi.fn(async () => ({ isRoomInvitation: true as const, title: "Friends" })),
    joinInvitation: vi.fn(async () => ({ groupId: "group-2" })),
    listPendingDmRequests: vi.fn(async () => [{ memberId: "member-1", displayName: "Friend" }]),
    acceptDmRequest: vi.fn(async () => ({ groupId: "dm-1", roomType: "DirectMessage" as const, dmMemberId: "member-1" })),
    leaveGroup: vi.fn(async () => undefined),
    updateIdentityProfile: vi.fn(async () => undefined),
    setUsername: vi.fn(async () => ({ status: "searchable" as const, submitted: true })),
    close: vi.fn(async () => undefined),
  }
  const createCore = vi.fn(async (_options: KeetCoreOptions) => core)
  const run = (args: string[], input = "") => runSetup(args, {
    env: { KEET_MCP_RUNTIME_DIR: identity, KEET_MCP_IDENTITY_DIR: identity },
    stdin: Readable.from([input]), stdout: { write: (value: string) => { output.push(value); return true } },
    stderr: { write: (value: string) => { errors.push(value); return true } }, createCore,
  })
  return { core, createCore, output, errors, run, identity }
}

describe("local human Keet setup", () => {
  it("reads a bounded private invitation from stdin and joins the selected identity once", async () => {
    const test = await harness()
    expect(await test.run(["join"], "keet://chat/fixture-token\n")).toBe(0)
    expect(test.core.joinInvitation).toHaveBeenCalledExactlyOnceWith("keet://chat/fixture-token")
    expect(test.core.close).toHaveBeenCalledOnce()
    expect(test.createCore.mock.calls[0]?.[0].dataPath).toBe(test.identity)
    expect(test.output.join("")).toContain('"groupId":"group-2"')
    expect(test.output.join("")).not.toContain("fixture-token")
  })

  it("rejects malformed or oversized invitation before opening an identity", async () => {
    const test = await harness()
    expect(await test.run(["join"], "https://example.test/invite")).toBe(1)
    expect(await test.run(["join"], `keet://chat/${"x".repeat(8192)}`)).toBe(1)
    expect(test.createCore).not.toHaveBeenCalled()
    expect(test.errors.join("")).not.toContain("example.test")
  })

  it("exposes the old human onboarding operations and closes Core", async () => {
    const test = await harness()
    expect(await test.run(["inspect"], "keet://chat/fixture-token")).toBe(0)
    expect(await test.run(["dm-requests"])).toBe(0)
    expect(await test.run(["dm-accept", "--member-id", "member-1"])).toBe(0)
    expect(test.core.inspectInvitation).toHaveBeenCalledOnce()
    expect(test.core.listPendingDmRequests).toHaveBeenCalledOnce()
    expect(test.core.acceptDmRequest).toHaveBeenCalledExactlyOnceWith("member-1")
    expect(test.core.close).toHaveBeenCalledTimes(3)
  })

  it("requires explicit confirmation and a joined Default group before leaving", async () => {
    const test = await harness()
    expect(await test.run(["leave", "--group-id", "group-1"])).toBe(1)
    expect(test.createCore).not.toHaveBeenCalled()
    expect(await test.run(["leave", "--group-id", "missing", "--yes"])).toBe(1)
    expect(test.core.leaveGroup).not.toHaveBeenCalled()
    expect(await test.run(["leave", "--group-id", "group-1", "--yes"])).toBe(0)
    expect(test.core.leaveGroup).toHaveBeenCalledExactlyOnceWith("group-1")
    expect(test.core.close).toHaveBeenCalledTimes(2)
  })

  it("keeps profile and searchable username as human-only commands", async () => {
    const test = await harness()
    expect(await test.run(["profile", "--display-name", "  Shio  "])).toBe(0)
    expect(test.core.updateIdentityProfile).toHaveBeenCalledExactlyOnceWith({ displayName: "Shio" })
    expect(await test.run(["username", "--username", "shio_1"])).toBe(0)
    expect(test.core.setUsername).toHaveBeenCalledExactlyOnceWith("shio_1")
    test.core.setUsername.mockResolvedValueOnce({ status: "pending", submitted: true } as never)
    expect(await test.run(["username", "--username", "shio_1"])).toBe(1)
  })

  it("prepares an avatar in a test-owned directory before claiming the identity", async () => {
    const test = await harness()
    const file = path.join(test.identity, "avatar.png")
    await sharp({ create: { width: 320, height: 240, channels: 4, background: "#4477aa" } }).png().toFile(file)
    const avatar = await prepareAvatar(file)
    expect([avatar.small.width, avatar.medium.width, avatar.large.width]).toEqual([64, 128, 256])
    expect([avatar.small.bytes.length, avatar.medium.bytes.length, avatar.large.bytes.length].every((size) => size > 0)).toBe(true)
    const broken = path.join(test.identity, "broken.png")
    expect(await test.run(["profile", "--avatar", broken])).toBe(1)
    expect(test.createCore).not.toHaveBeenCalled()
  })
})

it("argument parser rejects unrelated flags and join URLs on the command line", () => {
  expect(() => parseSetupArgs(["join", "keet://chat/fixture-token"])).toThrow()
  expect(() => parseSetupArgs(["dm-requests", "--group-id", "group-1"])).toThrow()
  expect(() => parseSetupArgs(["profile", "--display-name", " "])).toThrow()
})

it("invitation reader accepts only one Keet chat URL", async () => {
  await expect(readInvitation(Readable.from(["keet://chat/one\nkeet://chat/two"]))).rejects.toThrow("invalid invitation")
})
