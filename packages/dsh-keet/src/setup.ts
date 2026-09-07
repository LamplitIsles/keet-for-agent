#!/usr/bin/env node
import { realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { KeetIntegrationCore, validateKeetUsername } from "@lamplitisles/keet-integration-core"
import type { KeetCore, KeetCoreOptions, KeetUsernameResult, PreparedAvatar } from "./core-contract.js"
import { prepareAvatar, validatePreparedAvatar } from "./avatar.js"
import { resolveKeetRuntimePaths } from "./local-paths.js"
import { createKeetRuntimeOptions } from "./runtime-options.js"

const MAX_NAME = 128

export interface SetupArguments {
  command: "profile" | "username"
  workspaceDir: string
  displayName?: string
  avatarPath?: string
  username?: string
}

type SetupCore = Pick<KeetCore, "close" | "updateIdentityProfile"> & {
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
    void stdin
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
      } else {
        const result = await core.setUsername(parsed.username!)
        if (!isUsernameResult(result)) throw new Error("invalid username result")
        if (result.status === "pending") {
          stdout.write(JSON.stringify({ ok: false, operation: "username", username: parsed.username, status: "pending", submitted: result.submitted, retryable: true }) + "\n")
          return 1
        }
        stdout.write(JSON.stringify({ ok: true, operation: "username", username: parsed.username }) + "\n")
      }
      return 0
    } finally { await core.close() }
  } catch {
    stderr.write("dsh-keet-setup: operation failed; check DSH_HOME, the fixed runtime, workspace, and input.\n")
    return 1
  }
}

function isUsernameResult(value: unknown): value is KeetUsernameResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const result = value as { status?: unknown; submitted?: unknown }
  return (result.status === "searchable" || result.status === "pending") && typeof result.submitted === "boolean"
}

export function parseArgs(argv: readonly string[]): SetupArguments {
  const [command, ...rest] = argv
  if (command !== "profile" && command !== "username") throw new Error("command")
  let workspaceDir = ""
  let displayName: string | undefined
  let avatarPath: string | undefined
  let username: string | undefined
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    const value = rest[index + 1]
    if ((flag === "--workspace" || flag === "--display-name" || flag === "--avatar" || flag === "--username") && value) {
      if (flag === "--workspace") workspaceDir = value
      else if (flag === "--display-name") displayName = value
      else if (flag === "--avatar") avatarPath = value
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
    if (username !== undefined) throw new Error("profile arguments")
    if (displayName === undefined && avatarPath === undefined) throw new Error("profile fields")
  }
  if (command === "username") {
    if (displayName !== undefined || avatarPath !== undefined || username === undefined) throw new Error("username arguments")
    validateKeetUsername(username)
  }
  return { command, workspaceDir: path.resolve(workspaceDir), ...(displayName !== undefined ? { displayName } : {}), ...(avatarPath !== undefined ? { avatarPath } : {}), ...(username !== undefined ? { username } : {}) }
}

if (process.argv[1] && isDirectExecution(import.meta.url, process.argv[1])) process.exitCode = await runSetup(process.argv.slice(2))
