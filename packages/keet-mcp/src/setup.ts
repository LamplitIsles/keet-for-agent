#!/usr/bin/env node
import { realpath, stat } from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { KeetIntegrationCore, KEET_COMPATIBILITY, validateKeetUsername, type KeetCore, type KeetCoreOptions, type PreparedAvatar } from "@lamplitisles/keet-integration-core"
import { prepareAvatar } from "./setup-avatar.js"

const MAX_INVITATION_BYTES = 8_192
const MAX_ID_LENGTH = 512
const MAX_NAME_LENGTH = 128
const HELP = `Usage: keet-mcp-setup <command> [options]

Commands:
  status                         Show the integration identity
  list                           List joined rooms
  inspect                        Inspect one invitation read from stdin
  join                           Join one invitation read from stdin
  dm-requests                    List pending DM requests
  dm-accept --member-id ID       Accept one pending DM request
  leave --group-id ID --yes      Leave one joined Default group
  profile [--display-name NAME] [--avatar FILE]
  username --username NAME       Set the searchable Keet username

Required environment: KEET_MCP_RUNTIME_DIR, KEET_MCP_IDENTITY_DIR.
Stop the gateway that owns this identity before running a command. Invitations
are read from stdin; never pass them in shell arguments.`

type Command = "status" | "list" | "inspect" | "join" | "dm-requests" | "dm-accept" | "leave" | "profile" | "username"
type SetupCore = Pick<KeetCore, "status" | "listGroups" | "inspectInvitation" | "joinInvitation" | "listPendingDmRequests" | "acceptDmRequest" | "leaveGroup" | "updateIdentityProfile" | "setUsername" | "close">
type Parsed = { command: Command; memberId?: string; groupId?: string; yes?: boolean; displayName?: string; avatarPath?: string; username?: string }
export interface SetupDependencies {
  env?: NodeJS.ProcessEnv
  stdin?: NodeJS.ReadableStream
  stdout?: Pick<NodeJS.WritableStream, "write">
  stderr?: Pick<NodeJS.WritableStream, "write">
  createCore?: (options: KeetCoreOptions) => Promise<SetupCore>
  prepareAvatar?: (file: string) => Promise<PreparedAvatar>
}

export function parseSetupArgs(argv: readonly string[]): Parsed {
  const [command, ...args] = argv
  if (!["status", "list", "inspect", "join", "dm-requests", "dm-accept", "leave", "profile", "username"].includes(command ?? "")) throw new Error("invalid command")
  const values = new Map<string, string>()
  let yes = false
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!
    if (flag === "--yes") { if (yes) throw new Error("duplicate confirmation"); yes = true; continue }
    if (!["--member-id", "--group-id", "--display-name", "--avatar", "--username"].includes(flag) || !args[index + 1] || values.has(flag)) throw new Error("invalid arguments")
    values.set(flag, args[++index]!)
  }
  const allowed: Record<Command, string[]> = {
    status: [], list: [], inspect: [], join: [], "dm-requests": [], "dm-accept": ["--member-id"],
    leave: ["--group-id"], profile: ["--display-name", "--avatar"], username: ["--username"],
  }
  if ([...values.keys()].some((flag) => !allowed[command as Command].includes(flag))) throw new Error("invalid arguments")
  if (yes !== (command === "leave")) throw new Error("leave requires --yes")
  const memberId = values.get("--member-id")?.trim()
  const groupId = values.get("--group-id")?.trim()
  const displayName = values.get("--display-name")?.trim()
  const avatarPath = values.get("--avatar")
  const username = values.get("--username")
  if (command === "dm-accept" && (!memberId || memberId.length > MAX_ID_LENGTH)) throw new Error("invalid member id")
  if (command === "leave" && (!groupId || groupId.length > MAX_ID_LENGTH)) throw new Error("invalid group id")
  if (command === "profile" && ((!displayName && !avatarPath) || (displayName !== undefined && displayName.length > MAX_NAME_LENGTH))) throw new Error("invalid profile")
  if (command === "username") validateKeetUsername(username ?? "")
  return { command: command as Command, ...(memberId ? { memberId } : {}), ...(groupId ? { groupId } : {}), ...(yes ? { yes } : {}), ...(displayName ? { displayName } : {}), ...(avatarPath ? { avatarPath } : {}), ...(username ? { username } : {}) }
}

export async function readInvitation(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += bytes.byteLength
    if (size > MAX_INVITATION_BYTES) throw new Error("invitation too large")
    chunks.push(bytes)
  }
  const invitation = Buffer.concat(chunks).toString("utf8").trim()
  if (!/^keet:\/\/chat\/[A-Za-z0-9._~%!$&'()*+,;=:@/?-]+$/.test(invitation)) throw new Error("invalid invitation")
  return invitation
}

export async function runSetup(argv: readonly string[], dependencies: SetupDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { stdout.write(`${HELP}\n`); return 0 }
  try {
    const parsed = parseSetupArgs(argv)
    const invitation = parsed.command === "join" || parsed.command === "inspect" ? await readInvitation(dependencies.stdin ?? process.stdin) : undefined
    const avatar = parsed.avatarPath ? await (dependencies.prepareAvatar ?? prepareAvatar)(parsed.avatarPath) : undefined
    const env = dependencies.env ?? process.env
    const runtimeDir = env.KEET_MCP_RUNTIME_DIR
    const identityDir = env.KEET_MCP_IDENTITY_DIR
    if (!runtimeDir || !path.isAbsolute(runtimeDir) || !identityDir || !path.isAbsolute(identityDir)) throw new Error("runtime and identity directories are required")
    if (!(await stat(identityDir)).isDirectory()) throw new Error("identity directory does not exist")
    const identity = await realpath(identityDir)
    const options: KeetCoreOptions = {
      executablePath: path.join(runtimeDir, "bare"), bundlePath: path.join(runtimeDir, "core-worker.bundle"), dataPath: identity,
      appVersion: KEET_COMPATIBILITY.appVersion, expectedCoreVersion: KEET_COMPATIBILITY.coreVersion, expectedAbi: KEET_COMPATIBILITY.abi,
    }
    const core = await (dependencies.createCore ? dependencies.createCore(options) : KeetIntegrationCore.start(options))
    try {
      let result: unknown
      switch (parsed.command) {
        case "status": result = await core.status(); break
        case "list": result = await core.listGroups(); break
        case "inspect": result = await core.inspectInvitation(invitation!); break
        case "join": result = await core.joinInvitation(invitation!); break
        case "dm-requests": result = await core.listPendingDmRequests(); break
        case "dm-accept": result = await core.acceptDmRequest(parsed.memberId!); break
        case "leave": {
          const group = (await core.listGroups()).find((room) => room.groupId === parsed.groupId)
          if (group?.roomType !== "Default") throw new Error("not a joined Default group")
          await core.leaveGroup(parsed.groupId!); result = { left: true, groupId: parsed.groupId }; break
        }
        case "profile": await core.updateIdentityProfile({ ...(parsed.displayName ? { displayName: parsed.displayName } : {}), ...(avatar ? { avatar } : {}) }); result = { updated: true }; break
        case "username": result = await core.setUsername(parsed.username!); break
      }
      stdout.write(`${JSON.stringify(result)}\n`)
      return parsed.command === "username" && typeof result === "object" && result !== null && "status" in result && result.status === "pending" ? 1 : 0
    } finally { await core.close() }
  } catch {
    stderr.write("keet-mcp-setup: operation failed; check the command, runtime, identity ownership, and input.\n")
    return 1
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) process.exitCode = await runSetup(process.argv.slice(2))
