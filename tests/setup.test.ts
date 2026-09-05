import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { isDirectExecution, parseArgs, readInvitation, runSetup } from "../packages/dsh-keet/src/setup.js"
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
    expect(() => parseArgs(["join", "--workspace", "/workspace", "keet://chat/secret"])).toThrow()
    expect(() => parseArgs(["join", "--runtime-dir", "/runtime"])).toThrow()
    expect(() => parseArgs(["profile", "--workspace", "/workspace", "--display-name", "   "])).toThrow()
    expect(() => parseArgs(["profile", "--workspace", "/workspace"])).toThrow()
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
        coreFactory: async (options) => { receivedOptions = options as unknown as Record<string, unknown>; return { joinInvitation: async (invitation) => { calls.push(invitation); return { groupId: "group-result" } }, updateDisplayName: async () => undefined, close: async () => undefined } },
      },
    )
    expect(code).toBe(0)
    expect(calls).toEqual(["keet://chat/secret-token"])
    expect(stdout.value().trim().split("\n")).toHaveLength(1)
    expect(stdout.value()).toContain('"groupId":"group-result"')
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
        coreFactory: async () => { started += 1; return { joinInvitation: async () => ({ groupId: "unused" }), updateDisplayName: async (value) => { profile = value }, close: async () => undefined } },
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
        coreFactory: async () => ({ listPendingDmRequests: async () => [{ memberId: "peer", displayName: "Peer" }], close: async () => undefined }),
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
        coreFactory: async () => ({ acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage", dmMemberId: "peer" }), close: async () => undefined }),
      },
    )
    expect(acceptedCode).toBe(0)
    expect(JSON.parse(acceptedOut.value())).toEqual({ ok: true, operation: "dm-accept", memberId: "peer", groupId: "dm-room" })
  })

  it("prepares avatar data before opening Core and supports avatar-only profile updates", async () => {
    const stdout = output()
    const prepared = {} as PreparedAvatar
    let started = 0
    let received: unknown
    const code = await runSetup(
      ["profile", "--workspace", "/workspace", "--avatar", "/tmp/avatar.png"], Readable.from([]) as never, stdout.stream, output().stream,
      {
        prepareAvatar: async () => prepared,
        resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
        coreFactory: async () => { started += 1; return { updateIdentityProfile: async (value) => { received = value }, close: async () => undefined } },
      },
    )
    // The intentionally incomplete prepared value is rejected before the Core
    // is opened, proving failure atomicity at the setup seam.
    expect(code).toBe(1)
    expect(started).toBe(0)
    expect(received).toBeUndefined()
  })
})
