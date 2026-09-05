import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
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
  const identityA = path.join(parent, "identity-a")
  const identityB = path.join(workspaceB, KEET_IDENTITY_RELATIVE_PATH)
  let sidecarA: KeetIntegrationCore | undefined
  let sidecarB: KeetIntegrationCore | undefined
  try {
    if (path.dirname(bundlePath) !== path.dirname(executablePath)) throw new Error("official runtime files must share one directory")
    const runtimeLink = path.join(dshHome, "runtimes", "keet", KEET_RUNTIME_DIRECTORY)
    await mkdir(path.dirname(runtimeLink), { recursive: true })
    await mkdir(workspaceB, { recursive: true })
    await symlink(path.dirname(executablePath), runtimeLink, "dir")
    sidecarA = await KeetIntegrationCore.start({ executablePath, bundlePath, dataPath: identityA, swarming: true })
    if (!sidecarA.createRoom || !sidecarA.createInvitation) throw new Error("Core onboarding helpers are unavailable")
    const groupId = await sidecarA.createRoom({ title: "Keet for Agent onboarding smoke" })
    const invitation = await sidecarA.createInvitation(groupId)
    const snapshotText = "onboarding snapshot admission"
    await sidecarA.sendMessage(groupId, snapshotText)
    await waitFor(async () => (await sidecarA!.readRecentMessages(groupId, 50)).some((message) => message.text === snapshotText))

    const joined = await runSetup(setupPath, ["join", "--workspace", workspaceB], invitation.url, dshHome)
    if (joined.operation !== "join" || joined.groupId !== groupId) throw new Error("onboarding returned an unexpected group result")
    const profile = await runSetup(setupPath, ["profile", "--workspace", workspaceB, "--display-name", "Keet Assistant"], undefined, dshHome)
    if (profile.operation !== "profile" || profile.displayName !== "Keet Assistant") throw new Error("profile returned an unexpected result")

    sidecarB = await KeetIntegrationCore.start({ executablePath, bundlePath, dataPath: identityB, swarming: true })
    await waitFor(async () => {
      const groupsA = await sidecarA!.listGroups()
      const groupsB = await sidecarB!.listGroups()
      if (!groupsA.some((group) => group.groupId === groupId) || !groupsB.some((group) => group.groupId === groupId)) return false
      const membersA = await sidecarA!.listMembers(groupId)
      const membersB = await sidecarB!.listMembers(groupId)
      return membersA.some((member) => member.displayName === "Keet Assistant") && membersB.some((member) => member.displayName === "Keet Assistant")
    })
    const callbacks: string[] = []
    const subscription = sidecarB.watchMessages(groupId, (message) => callbacks.push(message.text))
    try {
      await waitFor(async () => (await sidecarB!.readRecentMessages(groupId, 50)).some((message) => message.text === snapshotText))
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      if (callbacks.includes(snapshotText)) throw new Error("subscription replayed an existing message during snapshot admission")

      const liveText = "onboarding live callback"
      await sidecarA.sendMessage(groupId, liveText)
      await waitFor(async () => callbacks.includes(liveText))
      if (callbacks.includes(snapshotText)) throw new Error("subscription delivered the snapshot message as live input")
    } finally {
      await subscription.close().catch(() => undefined)
    }
    console.log(JSON.stringify({ ok: true, groupObservedBy: 2, updatedLabelObservedBy: 2, snapshotSuppressed: true, liveCallbackObserved: true }))
  } finally {
    await sidecarB?.close().catch(() => undefined)
    await sidecarA?.close().catch(() => undefined)
    await rm(parent, { recursive: true, force: true })
  }
}

interface SetupResult {
  ok?: boolean
  operation?: "join" | "profile"
  groupId?: string
  displayName?: string
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
