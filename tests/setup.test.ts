import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { isDirectExecution, parseArgs, runSetup } from "../packages/dsh-keet/src/setup.js"
import { AVATAR_MAX_SOURCE_BYTES } from "../packages/dsh-keet/src/avatar.js"
import type { PreparedAvatar } from "../packages/dsh-keet/src/core-contract.js"

function output() {
  let value = ""
  return { stream: { write: (chunk: string) => { value += chunk; return true } } as any, value: () => value }
}

describe("dsh-keet-setup", () => {
  it("recognizes execution through an npm-style bin symlink", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dsh-keet-setup-"))
    try {
      const target = path.join(directory, "dist", "setup.js")
      const bin = path.join(directory, "node_modules", ".bin", "dsh-keet-setup")
      await mkdir(path.dirname(target), { recursive: true })
      await mkdir(path.dirname(bin), { recursive: true })
      await writeFile(target, "")
      await symlink(target, bin)
      const resolvedTarget = await realpath(target)
      expect(isDirectExecution(pathToFileURL(resolvedTarget).href, bin)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("accepts only narrow setup arguments and never invitation argv", () => {
    expect(parseArgs(["profile", "--workspace", "/workspace", "--display-name", "Keet Bot"])).toMatchObject({ command: "profile", workspaceDir: "/workspace", displayName: "Keet Bot" })
    expect(parseArgs(["profile", "--workspace", "/workspace", "--avatar", "/tmp/avatar.png"])).toMatchObject({ command: "profile", avatarPath: "/tmp/avatar.png" })
    expect(parseArgs(["username", "--workspace", "/workspace", "--username", "agent_name1"])).toEqual({ command: "username", workspaceDir: "/workspace", username: "agent_name1" })
    for (const removed of [["join", "--workspace", "/workspace"], ["dm-requests", "--workspace", "/workspace"], ["dm-accept", "--workspace", "/workspace", "--member-id", "peer"]]) expect(() => parseArgs(removed)).toThrow()
    expect(() => parseArgs(["profile", "--workspace", "/workspace", "--display-name", "   "])).toThrow()
    expect(() => parseArgs(["profile", "--workspace", "/workspace"])).toThrow()
    for (const username of ["agent_name", "1234", "a-1", " a1", "a1 ", "a1", `a1${"x".repeat(63)}`]) {
      expect(() => parseArgs(["username", "--workspace", "/workspace", "--username", username])).toThrow()
    }
    expect(() => parseArgs(["username", "--workspace", "/workspace", "--username", "agent1", "--member-id", "peer"])).toThrow()
  })

  it("updates only the display name for profile", async () => {
    const stdout = output()
    let profile = ""
    let started = 0
    const profileCode = await runSetup(
      ["profile", "--workspace", "/workspace", "--display-name", "  Agent  "],
      Readable.from([]) as never, stdout.stream, output().stream,
      {
        resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
        coreFactory: async () => { started += 1; return { joinInvitation: async () => ({ groupId: "unused" }), updateIdentityProfile: async (value) => { profile = value.displayName ?? "" }, setUsername: async () => ({ status: "searchable" as const, submitted: false }), listPendingDmRequests: async () => [], acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }), close: async () => undefined } },
      },
    )
    expect(profileCode).toBe(0)
    expect(started).toBe(1)
    expect(profile).toBe("  Agent  ")
    expect(stdout.value()).toContain('"operation":"profile"')

  })

  it("sets a username through Core, prints a bounded result, and always closes Core", async () => {
    let received = ""
    let closes = 0
    const stdout = output()
    const success = await runSetup(
      ["username", "--workspace", "/workspace", "--username", "agent_name1"], Readable.from([]) as never, stdout.stream, output().stream,
      {
        resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
        coreFactory: async () => ({
          joinInvitation: async () => ({ groupId: "unused" }),
          updateIdentityProfile: async () => undefined,
          setUsername: async (username) => { received = username; return { status: "searchable" as const, submitted: true } },
          listPendingDmRequests: async () => [],
          acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }),
          close: async () => { closes += 1 },
        }),
      },
    )
    expect(success).toBe(0)
    expect(received).toBe("agent_name1")
    expect(JSON.parse(stdout.value())).toEqual({ ok: true, operation: "username", username: "agent_name1" })
    expect(closes).toBe(1)

    for (const submitted of [true, false]) {
      const pendingOut = output()
      const pendingErr = output()
      const pending = await runSetup(
        ["username", "--workspace", "/workspace", "--username", "agent_name1"], Readable.from([]) as never, pendingOut.stream, pendingErr.stream,
        {
          resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
          coreFactory: async () => ({
            joinInvitation: async () => ({ groupId: "unused" }),
            updateIdentityProfile: async () => undefined,
            setUsername: async () => ({ status: "pending" as const, submitted }),
            listPendingDmRequests: async () => [],
            acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }),
            close: async () => { closes += 1 },
          }),
        },
      )
      expect(pending).toBe(1)
      expect(JSON.parse(pendingOut.value())).toEqual({ ok: false, operation: "username", username: "agent_name1", status: "pending", submitted, retryable: true })
      expect(pendingErr.value()).toBe("")
      expect(pendingOut.value()).not.toContain("identity-self")
    }
    expect(closes).toBe(3)

    const failed = await runSetup(
      ["username", "--workspace", "/workspace", "--username", "agent_name2"], Readable.from([]) as never, output().stream, output().stream,
      {
        resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
        coreFactory: async () => ({
          joinInvitation: async () => ({ groupId: "unused" }),
          updateIdentityProfile: async () => undefined,
          setUsername: async () => { throw new Error("private native detail") },
          listPendingDmRequests: async () => [],
          acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }),
          close: async () => { closes += 1 },
        }),
      },
    )
    expect(failed).toBe(1)
    expect(closes).toBe(4)
  })

  it("runs an avatar-only profile update through the observable CLI contract", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dsh-keet-setup-avatar-only-"))
    try {
      const avatarPath = path.join(directory, "avatar.png")
      const prepared = makePreparedAvatar()
      const stdout = output()
      let received: unknown
      const code = await runSetup(
        ["profile", "--workspace", "/workspace", "--avatar", avatarPath], Readable.from([]) as never, stdout.stream, output().stream,
        {
          prepareAvatar: async (value) => { expect(value).toBe(avatarPath); return prepared },
          resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
          coreFactory: async () => ({ joinInvitation: async () => ({ groupId: "unused" }), updateIdentityProfile: async (value) => { received = value }, setUsername: async () => ({ status: "searchable" as const, submitted: false }), listPendingDmRequests: async () => [], acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }), close: async () => undefined }),
        },
      )
      expect(code).toBe(0)
      expect(received).toEqual({ avatar: prepared })
      expect(JSON.parse(stdout.value())).toEqual({ ok: true, operation: "profile", avatar: true })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("runs a combined display-name and avatar profile update", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dsh-keet-setup-avatar-combined-"))
    try {
      const avatarPath = path.join(directory, "avatar.png")
      const prepared = makePreparedAvatar()
      const stdout = output()
      let received: unknown
      const code = await runSetup(
        ["profile", "--workspace", "/workspace", "--display-name", "  Agent  ", "--avatar", avatarPath], Readable.from([]) as never, stdout.stream, output().stream,
        {
          prepareAvatar: async (value) => { expect(value).toBe(avatarPath); return prepared },
          resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
          coreFactory: async () => ({ joinInvitation: async () => ({ groupId: "unused" }), updateIdentityProfile: async (value) => { received = value }, setUsername: async () => ({ status: "searchable" as const, submitted: false }), listPendingDmRequests: async () => [], acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }), close: async () => undefined }),
        },
      )
      expect(code).toBe(0)
      expect(received).toEqual({ displayName: "  Agent  ", avatar: prepared })
      expect(JSON.parse(stdout.value())).toEqual({ ok: true, operation: "profile", displayName: "Agent", avatar: true })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("rejects an avatar source larger than 8 MiB before opening Core", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dsh-keet-setup-avatar-large-"))
    try {
      const avatarPath = path.join(directory, "avatar.png")
      await writeFile(avatarPath, Buffer.alloc(AVATAR_MAX_SOURCE_BYTES + 1))
      const stderr = output()
      let started = 0
      const code = await runSetup(
        ["profile", "--workspace", "/workspace", "--avatar", avatarPath], Readable.from([]) as never, output().stream, stderr.stream,
        { coreFactory: async () => { started += 1; throw new Error("must not start") } },
      )
      expect(code).toBe(1)
      expect(started).toBe(0)
      expect(stderr.value()).toBe("dsh-keet-setup: operation failed; check DSH_HOME, the fixed runtime, workspace, and input.\n")
      expect(stderr.value()).not.toContain(avatarPath)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function makePreparedAvatar(): PreparedAvatar {
  const variant = (size: number) => {
    const bytes = Buffer.from(`setup-avatar-${size}`)
    return { bytes, contentType: "image/png", width: size, height: size, hash: createHash("sha256").update(bytes).digest("hex") }
  }
  return { small: variant(64), medium: variant(128), large: variant(256) }
}
