import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { isDirectExecution, parseArgs, readInvitation, runSetup } from "../packages/dsh-keet/src/setup.js"
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
    expect(parseArgs(["join", "--workspace", "/workspace"])).toMatchObject({ command: "join", workspaceDir: "/workspace" })
    expect(parseArgs(["profile", "--workspace", "/workspace", "--display-name", "Keet Bot"])).toMatchObject({ command: "profile", workspaceDir: "/workspace", displayName: "Keet Bot" })
    expect(parseArgs(["profile", "--workspace", "/workspace", "--avatar", "/tmp/avatar.png"])).toMatchObject({ command: "profile", avatarPath: "/tmp/avatar.png" })
    expect(parseArgs(["dm-requests", "--workspace", "/workspace"])).toMatchObject({ command: "dm-requests" })
    expect(parseArgs(["dm-accept", "--workspace", "/workspace", "--member-id", "peer"])).toMatchObject({ command: "dm-accept", memberId: "peer" })
    expect(parseArgs(["username", "--workspace", "/workspace", "--username", "agent_name1"])).toEqual({ command: "username", workspaceDir: "/workspace", username: "agent_name1" })
    expect(() => parseArgs(["join", "--workspace", "/workspace", "keet://chat/secret"])).toThrow()
    expect(() => parseArgs(["join", "--runtime-dir", "/runtime"])).toThrow()
    expect(() => parseArgs(["profile", "--workspace", "/workspace", "--display-name", "   "])).toThrow()
    expect(() => parseArgs(["profile", "--workspace", "/workspace"])).toThrow()
    for (const username of ["agent_name", "1234", "a-1", " a1", "a1 ", "a1", `a1${"x".repeat(63)}`]) {
      expect(() => parseArgs(["username", "--workspace", "/workspace", "--username", username])).toThrow()
    }
    expect(() => parseArgs(["username", "--workspace", "/workspace", "--username", "agent1", "--member-id", "peer"])).toThrow()
  })

  it("requires exactly one bounded room invitation on stdin", async () => {
    await expect(readInvitation(Readable.from(["keet://chat/token\n"]))).resolves.toBe("keet://chat/token")
    await expect(readInvitation(Readable.from(["keet://chat/one\nkeet://chat/two\n"]))).rejects.toThrow()
    await expect(readInvitation(Readable.from(["https://example.invalid/token"]))).rejects.toThrow()
  })

  it("joins through the injected Core and prints one redacted machine result", async () => {
    const calls: string[] = []
    let receivedOptions: Record<string, unknown> | undefined
    const stdout = output()
    const stderr = output()
    const code = await runSetup(
      ["join", "--workspace", "/workspace"],
      Readable.from(["keet://chat/secret-token\n"]) as never, stdout.stream, stderr.stream,
      {
        resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
        coreFactory: async (options) => { receivedOptions = options as unknown as Record<string, unknown>; return { joinInvitation: async (invitation) => { calls.push(invitation); return { groupId: "group-result" } }, updateIdentityProfile: async () => undefined, setUsername: async () => undefined, listPendingDmRequests: async () => [], acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }), close: async () => undefined } },
      },
    )
    expect(code).toBe(0)
    expect(calls).toEqual(["keet://chat/secret-token"])
    expect(stdout.value().trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(stdout.value())).toEqual({ ok: true, operation: "join" })
    expect(stdout.value()).not.toContain("secret-token")
    expect(stderr.value()).toBe("")
    expect(receivedOptions).toMatchObject({ executablePath: "/runtime/bare", bundlePath: "/runtime/core-worker.bundle", dataPath: "/identity", appVersion: "4.21.0", expectedCoreVersion: "4.21.5", expectedAbi: 35 })
  })

  it("updates only the display name for profile and does not start Core for malformed join input", async () => {
    const stdout = output()
    let profile = ""
    let started = 0
    const profileCode = await runSetup(
      ["profile", "--workspace", "/workspace", "--display-name", "  Agent  "],
      Readable.from([]) as never, stdout.stream, output().stream,
      {
        resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
        coreFactory: async () => { started += 1; return { joinInvitation: async () => ({ groupId: "unused" }), updateIdentityProfile: async (value) => { profile = value.displayName ?? "" }, setUsername: async () => undefined, listPendingDmRequests: async () => [], acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }), close: async () => undefined } },
      },
    )
    expect(profileCode).toBe(0)
    expect(started).toBe(1)
    expect(profile).toBe("  Agent  ")
    expect(stdout.value()).toContain('"operation":"profile"')

    const invalidOut = output(); const invalidErr = output(); let invalidStarted = 0
    const invalidCode = await runSetup(["join", "--workspace", "/workspace"], Readable.from(["not an invitation"]) as never, invalidOut.stream, invalidErr.stream, { coreFactory: async () => { invalidStarted += 1; throw new Error("must not start") } })
    expect(invalidCode).toBe(1)
    expect(invalidStarted).toBe(0)
    expect(invalidOut.value()).toBe("")
    expect(invalidErr.value()).not.toContain("not an invitation")
  })

  it("lists and accepts pending DMs through redacted machine results", async () => {
    const pendingOut = output()
    const pendingCode = await runSetup(
      ["dm-requests", "--workspace", "/workspace"], Readable.from([]) as never, pendingOut.stream, output().stream,
      {
        resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
        coreFactory: async () => ({ joinInvitation: async () => ({ groupId: "unused" }), updateIdentityProfile: async () => undefined, setUsername: async () => undefined, listPendingDmRequests: async () => [{ memberId: "peer", displayName: "Peer" }], acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }), close: async () => undefined }),
      },
    )
    expect(pendingCode).toBe(0)
    expect(JSON.parse(pendingOut.value())).toEqual({ ok: true, operation: "dm-requests", requests: [{ memberId: "peer", displayName: "Peer" }] })
    expect(pendingOut.value()).not.toContain("private-room")
    const acceptedOut = output()
    const acceptedCode = await runSetup(
      ["dm-accept", "--workspace", "/workspace", "--member-id", "peer"], Readable.from([]) as never, acceptedOut.stream, output().stream,
      {
        resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
        coreFactory: async () => ({ joinInvitation: async () => ({ groupId: "unused" }), updateIdentityProfile: async () => undefined, setUsername: async () => undefined, listPendingDmRequests: async () => [], acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }), close: async () => undefined }),
      },
    )
    expect(acceptedCode).toBe(0)
    expect(JSON.parse(acceptedOut.value())).toEqual({ ok: true, operation: "dm-accept", memberId: "peer" })
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
          setUsername: async (username) => { received = username },
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
    expect(closes).toBe(2)
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
          coreFactory: async () => ({ joinInvitation: async () => ({ groupId: "unused" }), updateIdentityProfile: async (value) => { received = value }, setUsername: async () => undefined, listPendingDmRequests: async () => [], acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }), close: async () => undefined }),
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
          coreFactory: async () => ({ joinInvitation: async () => ({ groupId: "unused" }), updateIdentityProfile: async (value) => { received = value }, setUsername: async () => undefined, listPendingDmRequests: async () => [], acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }), close: async () => undefined }),
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
