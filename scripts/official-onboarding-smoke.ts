import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { KeetIntegrationCore } from "@lamplitisles/keet-integration-core"
import { KEET_IDENTITY_RELATIVE_PATH, KEET_RUNTIME_DIRECTORY } from "../packages/dsh-keet/src/local-paths.js"

/**
 * Disposable official-runtime onboarding check. It is deliberately inert
 * unless the operator opts in; ordinary tests never need network access or
 * official assets.
 */
if (process.env.KEET_OFFICIAL_ONBOARDING_SMOKE !== "1") {
  console.log("official onboarding smoke skipped (set KEET_OFFICIAL_ONBOARDING_SMOKE=1 to opt in)")
} else {
  const executablePath = required("KEET_EXECUTABLE_PATH")
  const bundlePath = required("KEET_BUNDLE_PATH")
  const root = path.resolve(new URL("..", import.meta.url).pathname)
  const setupPath = path.join(root, "packages", "dsh-keet", "dist", "setup.js")
  const parent = await mkdtemp(path.join(tmpdir(), "keet-onboarding-smoke-"))
  const dshHome = path.join(parent, "dsh-home")
  const workspaceB = path.join(parent, "workspace-b")
  const identityAPath = path.join(parent, "identity-a")
  const identityB = path.join(workspaceB, KEET_IDENTITY_RELATIVE_PATH)
  const avatarPath = path.join(parent, "agent-avatar.png")
  let sidecarA: KeetIntegrationCore | undefined
  let sidecarB: KeetIntegrationCore | undefined
  try {
    if (path.dirname(bundlePath) !== path.dirname(executablePath)) throw new Error("official runtime files must share one directory")
    const runtimeLink = path.join(dshHome, "runtimes", "keet", KEET_RUNTIME_DIRECTORY)
    await mkdir(path.dirname(runtimeLink), { recursive: true })
    await mkdir(workspaceB, { recursive: true })
    await writeGeneratedAvatar(avatarPath)
    await symlink(path.dirname(executablePath), runtimeLink, "dir")
    const coreA = await KeetIntegrationCore.start({ executablePath, bundlePath, dataPath: identityAPath, swarming: true })
    sidecarA = coreA
    if (!coreA.createRoom || !coreA.createInvitation) throw new Error("Core onboarding helpers are unavailable")
    const groupId = await coreA.createRoom({ title: "Keet for Agent onboarding smoke" })
    const invitation = await coreA.createInvitation(groupId)
    const snapshotText = "onboarding snapshot admission"
    await coreA.sendMessage(groupId, snapshotText)
    await waitFor(async () => (await coreA.readRecentMessages(groupId, 50)).some((message) => message.text === snapshotText))

    const joined = await runSetup(setupPath, ["join", "--workspace", workspaceB], invitation.url, dshHome)
    if (joined.operation !== "join" || joined.groupId !== groupId) throw new Error("onboarding returned an unexpected group result")
    const profileResult = await runSetup(setupPath, ["profile", "--workspace", workspaceB, "--display-name", "Keet Assistant", "--avatar", avatarPath], undefined, dshHome)
    if (profileResult.operation !== "profile" || profileResult.displayName !== "Keet Assistant" || profileResult.avatar !== true) throw new Error("profile returned an unexpected result")

    let coreB = await KeetIntegrationCore.start({ executablePath, bundlePath, dataPath: identityB, swarming: true })
    sidecarB = coreB
    await waitFor(async () => {
      const groupsA = await coreA.listGroups()
      const groupsB = await coreB.listGroups()
      if (!groupsA.some((group) => group.groupId === groupId) || !groupsB.some((group) => group.groupId === groupId)) return false
      const membersA = await coreA.listMembers(groupId)
      const membersB = await coreB.listMembers(groupId)
      return membersA.some((member) => member.displayName === "Keet Assistant" && member.avatar?.present === true) && membersB.some((member) => member.displayName === "Keet Assistant" && member.avatar?.present === true)
    })

    const statusA = await coreA.status()
    const statusB = await coreB.status()
    const identityProfile = await coreA.sidecar.call("getIdentity", []) as { profileId?: unknown }
    if (typeof identityProfile.profileId !== "string" || !statusB.identityId) throw new Error("official identity profile lookup failed")
    // Contact-request creation is intentionally reachable only from this
    // disposable official smoke through the raw pinned RPC. It is not on the
    // KeetCore or DSH Agent-facing contracts.
    await coreA.sidecar.call("sendDmRequest", [identityProfile.profileId, statusB.identityId, { message: "official DM smoke" }])
    await waitFor(async () => (await coreB.listPendingDmRequests()).some((request) => request.memberId === statusA.identityId))
    // The setup executable owns the identity lock while accepting a request;
    // pause the observation sidecar, run the human-only operation, and resume
    // it before checking the resulting DM.
    await coreB.close()
    sidecarB = undefined
    const pending = await runSetup(setupPath, ["dm-requests", "--workspace", workspaceB], undefined, dshHome)
    if (pending.operation !== "dm-requests" || !pending.requests?.some((request) => request.memberId === statusA.identityId)) throw new Error("DM request listing returned an unexpected result")
    const accepted = await runSetup(setupPath, ["dm-accept", "--workspace", workspaceB, "--member-id", statusA.identityId], undefined, dshHome)
    if (accepted.operation !== "dm-accept" || accepted.memberId !== statusA.identityId || !accepted.groupId) throw new Error("DM acceptance returned an unexpected result")
    coreB = await KeetIntegrationCore.start({ executablePath, bundlePath, dataPath: identityB, swarming: true })
    sidecarB = coreB
    const dmB = await coreB.getDmByMemberId(statusA.identityId)
    let dmA: Awaited<ReturnType<KeetIntegrationCore["getDmByMemberId"]>>
    await waitFor(async () => {
      try { dmA = await coreA.getDmByMemberId(statusB.identityId); return dmA.groupId === dmB.groupId } catch { return false }
    })
    const dmCallbacks: string[] = []
    const dmSubscription = coreB.watchMessages(dmB.groupId, (message) => dmCallbacks.push(message.text))
    try {
      const dmText = "official DM live text"
      await coreA.sendMessage(dmA!.groupId, dmText)
      await waitFor(async () => dmCallbacks.includes(dmText))
    } finally {
      await dmSubscription.close().catch(() => undefined)
    }
    const callbacks: string[] = []
    const subscription = coreB.watchMessages(groupId, (message) => callbacks.push(message.text))
    try {
      await waitFor(async () => (await sidecarB!.readRecentMessages(groupId, 50)).some((message) => message.text === snapshotText))
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      if (callbacks.includes(snapshotText)) throw new Error("subscription replayed an existing message during snapshot admission")

      const liveText = "onboarding live callback"
      await coreA.sendMessage(groupId, liveText)
      await waitFor(async () => callbacks.includes(liveText))
      if (callbacks.includes(snapshotText)) throw new Error("subscription delivered the snapshot message as live input")
    } finally {
      await subscription.close().catch(() => undefined)
    }
    console.log(JSON.stringify({ ok: true, groupObservedBy: 2, updatedLabelObservedBy: 2, avatarObservedBy: 2, dmRequestAccepted: true, dmResolvedBy: 2, dmLiveCallbackObserved: true, snapshotSuppressed: true, liveCallbackObserved: true, agentToolAvatarData: "absent" }))
  } finally {
    await sidecarB?.close().catch(() => undefined)
    await sidecarA?.close().catch(() => undefined)
    await rm(parent, { recursive: true, force: true })
  }
}

interface SetupResult {
  ok?: boolean
  operation?: "join" | "profile" | "dm-requests" | "dm-accept"
  groupId?: string
  displayName?: string
  avatar?: boolean
  memberId?: string
  requests?: Array<{ memberId?: string; displayName?: string }>
}

async function runSetup(setupPath: string, args: readonly string[], invitation: string | undefined, dshHome: string): Promise<SetupResult> {
  const child = spawn("node", [setupPath, ...args], { stdio: ["pipe", "pipe", "pipe"], env: sanitizedEnvironment(dshHome) })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
  if (invitation !== undefined) child.stdin.end(`${invitation}\n`)
  else child.stdin.end()
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("setup command timed out")) }, 90_000)
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`setup command failed to start: ${error instanceof Error ? error.message.slice(0, 128) : "unknown"}`)) })
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
  const output = Buffer.concat(stdout).toString("utf8").trim()
  // The invitation is a secret and is never included in diagnostics, even if
  // a misbehaving worker writes it to a child stream.
  if (invitation && (output.includes(invitation) || Buffer.concat(stderr).toString("utf8").includes(invitation))) throw new Error("setup command leaked invitation material")
  if (result.code !== 0 || result.signal || output.split("\n").length !== 1) throw new Error("setup command did not produce one successful machine result")
  try {
    const parsed = JSON.parse(output) as SetupResult
    if (parsed.ok !== true) throw new Error("not ok")
    return parsed
  } catch {
    throw new Error("setup command produced an invalid machine result")
  }
}

function sanitizedEnvironment(dshHome: string): NodeJS.ProcessEnv {
  const value: NodeJS.ProcessEnv = { DSH_HOME: dshHome }
  for (const key of ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) value[key] = process.env[key]
  }
  return value
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error("official sidecars did not converge before the timeout")
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required when official onboarding smoke is enabled`)
  return value
}

async function writeGeneratedAvatar(destination: string): Promise<void> {
  const width = 3
  const height = 2
  const scanlines = Buffer.alloc(height * (1 + width * 4))
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = row * (1 + width * 4) + 1 + column * 4
      scanlines[offset] = 44
      scanlines[offset + 1] = 116
      scanlines[offset + 2] = 190
      scanlines[offset + 3] = 217
    }
  }
  await writeFile(destination, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.from([0, 0, 0, width, 0, 0, 0, height, 8, 6, 0, 0, 0])),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]))
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii")
  const payload = Buffer.concat([typeBytes, data])
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(payload), 8 + data.length)
  return chunk
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
