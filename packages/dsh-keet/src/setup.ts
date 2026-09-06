#!/usr/bin/env node
import { realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { KeetIntegrationCore, validateKeetUsername } from "@lamplitisles/keet-integration-core"
import type { KeetCore, KeetCoreOptions, KeetPendingDmRequest, KeetUsernameResult, PreparedAvatar } from "./core-contract.js"
import { prepareAvatar, validatePreparedAvatar } from "./avatar.js"
import { resolveKeetRuntimePaths } from "./local-paths.js"
import { createKeetRuntimeOptions } from "./runtime-options.js"

const MAX_INVITATION_BYTES = 8_192
const MAX_NAME = 128
const MAX_MEMBER_ID = 512

export interface SetupArguments {
  command: "join" | "profile" | "dm-requests" | "dm-accept" | "username"
  workspaceDir: string
  displayName?: string
  avatarPath?: string
  memberId?: string
  username?: string
}

type SetupCore = Pick<KeetCore, "close" | "joinInvitation" | "updateIdentityProfile" | "listPendingDmRequests" | "acceptDmRequest"> & {
  setUsername(username: string, signal?: AbortSignal): Promise<KeetUsernameResult>
}
export interface SetupDependencies {
  coreFactory?: (options: KeetCoreOptions) => Promise<SetupCore>
  resolveRuntimePaths?: (workspaceDir: string) => Promise<{ runtimeDir: string; identityDataDir: string }>
  prepareAvatar?: (avatarPath: string) => Promise<PreparedAvatar>
}

export function isDirectExecution(moduleUrl: string, argvEntry: string): boolean {
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry) } catch { return false }
}

export async function runSetup(argv: readonly string[], stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, dependencies: SetupDependencies = {}): Promise<number> {
  try {
    const parsed = parseArgs(argv)
    const invitation = parsed.command === "join" ? await readInvitation(stdin) : undefined
    // Decode/resize before a worker is opened. A malformed or oversized local
    // file therefore cannot claim a profile update or touch identity state.
    const avatar = parsed.avatarPath ? await (dependencies.prepareAvatar?.(parsed.avatarPath) ?? prepareAvatar(parsed.avatarPath)) : undefined
    if (avatar) validatePreparedAvatar(avatar)
    const paths = await (dependencies.resolveRuntimePaths?.(parsed.workspaceDir) ?? resolveKeetRuntimePaths(parsed.workspaceDir))
    const core = await (dependencies.coreFactory?.(createKeetRuntimeOptions(paths)) ?? KeetIntegrationCore.start(createKeetRuntimeOptions(paths)))
    try {
      if (parsed.command === "profile") {
        await core.updateIdentityProfile({ ...(parsed.displayName !== undefined ? { displayName: parsed.displayName } : {}), ...(avatar ? { avatar } : {}) })
        stdout.write(JSON.stringify({ ok: true, operation: "profile", ...(parsed.displayName !== undefined ? { displayName: parsed.displayName.trim() } : {}), ...(avatar ? { avatar: true } : {}) }) + "\n")
      } else if (parsed.command === "username") {
        const result = await core.setUsername(parsed.username!)
        if (!isUsernameResult(result)) throw new Error("invalid username result")
        if (result.status === "pending") {
          stdout.write(JSON.stringify({ ok: false, operation: "username", username: parsed.username, status: "pending", submitted: result.submitted, retryable: true }) + "\n")
          return 1
        }
        stdout.write(JSON.stringify({ ok: true, operation: "username", username: parsed.username }) + "\n")
      } else if (parsed.command === "dm-requests") {
        const requests = await core.listPendingDmRequests()
        stdout.write(JSON.stringify({ ok: true, operation: "dm-requests", requests: requests.slice(0, 32).map(publicPendingRequest) }) + "\n")
      } else if (parsed.command === "dm-accept") {
        if (!parsed.memberId) throw new Error("DM acceptance requires a Member ID")
        const result = await core.acceptDmRequest(parsed.memberId)
        stdout.write(JSON.stringify({ ok: true, operation: "dm-accept", memberId: result.dmMemberId }) + "\n")
      } else {
        await core.joinInvitation(invitation!)
        stdout.write(JSON.stringify({ ok: true, operation: "join" }) + "\n")
      }
      return 0
    } finally { await core.close() }
  } catch {
    stderr.write("dsh-keet-setup: operation failed; check DSH_HOME, the fixed runtime, workspace, and input.\n")
    return 1
  }
}

function publicPendingRequest(request: KeetPendingDmRequest): Record<string, string> {
  return { memberId: request.memberId.slice(0, MAX_MEMBER_ID), ...(request.displayName ? { displayName: request.displayName.slice(0, MAX_MEMBER_ID) } : {}) }
}

function isUsernameResult(value: unknown): value is KeetUsernameResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const result = value as { status?: unknown; submitted?: unknown }
  return (result.status === "searchable" || result.status === "pending") && typeof result.submitted === "boolean"
}

export function parseArgs(argv: readonly string[]): SetupArguments {
  const [command, ...rest] = argv
  if (command !== "join" && command !== "profile" && command !== "dm-requests" && command !== "dm-accept" && command !== "username") throw new Error("command")
  let workspaceDir = ""
  let displayName: string | undefined
  let avatarPath: string | undefined
  let memberId: string | undefined
  let username: string | undefined
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    const value = rest[index + 1]
    if ((flag === "--workspace" || flag === "--display-name" || flag === "--avatar" || flag === "--member-id" || flag === "--username") && value) {
      if (flag === "--workspace") workspaceDir = value
      else if (flag === "--display-name") displayName = value
      else if (flag === "--avatar") avatarPath = value
      else if (flag === "--member-id") memberId = value
      else username = value
      index += 1
      continue
    }
    throw new Error("arguments")
  }
  if (!workspaceDir) throw new Error("workspace")
  if (command === "profile") {
    if (displayName !== undefined && (!displayName.trim() || displayName.length > MAX_NAME)) throw new Error("display name")
    if (avatarPath !== undefined && (!avatarPath.trim() || avatarPath.length > 4_096)) throw new Error("avatar")
    if (memberId !== undefined || username !== undefined) throw new Error("profile arguments")
    if (displayName === undefined && avatarPath === undefined) throw new Error("profile fields")
  }
  if (command === "join" && (displayName !== undefined || avatarPath !== undefined || memberId !== undefined || username !== undefined)) throw new Error("join arguments")
  if (command === "dm-requests" && (displayName !== undefined || avatarPath !== undefined || memberId !== undefined || username !== undefined)) throw new Error("request arguments")
  if (command === "dm-accept") {
    if (!memberId || !memberId.trim() || memberId.length > MAX_MEMBER_ID || displayName !== undefined || avatarPath !== undefined || username !== undefined) throw new Error("member id")
  }
  if (command === "username") {
    if (displayName !== undefined || avatarPath !== undefined || memberId !== undefined || username === undefined) throw new Error("username arguments")
    validateKeetUsername(username)
  }
  return { command, workspaceDir: path.resolve(workspaceDir), ...(displayName !== undefined ? { displayName } : {}), ...(avatarPath !== undefined ? { avatarPath } : {}), ...(memberId !== undefined ? { memberId: memberId.trim() } : {}), ...(username !== undefined ? { username } : {}) }
}

export async function readInvitation(stdin: NodeJS.ReadableStream): Promise<string> {
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += value.byteLength
    if (bytes > MAX_INVITATION_BYTES) throw new Error("invitation too large")
    chunks.push(value)
  }
  const input = Buffer.concat(chunks).toString("utf8").trim()
  if (!/^keet:\/\/chat\/[A-Za-z0-9._~%!$&'()*+,;=:@/?-]+$/.test(input)) throw new Error("invalid invitation")
  return input
}

if (process.argv[1] && isDirectExecution(import.meta.url, process.argv[1])) process.exitCode = await runSetup(process.argv.slice(2))
