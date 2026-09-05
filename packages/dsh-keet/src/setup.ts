#!/usr/bin/env node
import { realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { KeetIntegrationCore } from "@lamplitisles/keet-integration-core"
import type { KeetCore, KeetCoreOptions } from "./core-contract.js"
import { resolveKeetRuntimePaths } from "./local-paths.js"
import { createKeetRuntimeOptions } from "./runtime-options.js"

const MAX_INVITATION_BYTES = 8_192
const MAX_NAME = 128

export interface SetupArguments {
  command: "join" | "profile"
  workspaceDir: string
  displayName?: string
}

export interface SetupDependencies {
  coreFactory?: (options: KeetCoreOptions) => Promise<Pick<KeetCore, "joinInvitation" | "updateDisplayName" | "close">>
  resolveRuntimePaths?: (workspaceDir: string) => Promise<{ runtimeDir: string; identityDataDir: string }>
}

export function isDirectExecution(moduleUrl: string, argvEntry: string): boolean {
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry)
  } catch {
    return false
  }
}

export async function runSetup(
  argv: readonly string[],
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  dependencies: SetupDependencies = {},
): Promise<number> {
  try {
    const parsed = parseArgs(argv)
    // Validate and consume the one stdin invitation before starting a worker.
    // This keeps malformed input from creating or touching identity state.
    const invitation = parsed.command === "join" ? await readInvitation(stdin) : undefined
    const paths = await (dependencies.resolveRuntimePaths?.(parsed.workspaceDir) ?? resolveKeetRuntimePaths(parsed.workspaceDir))
    const options = createKeetRuntimeOptions(paths)
    const core = await (dependencies.coreFactory?.(options) ?? KeetIntegrationCore.start(options))
    try {
      if (parsed.command === "profile") {
        await core.updateDisplayName(parsed.displayName!)
        stdout.write(JSON.stringify({ ok: true, operation: "profile", displayName: parsed.displayName!.trim() }) + "\n")
      } else {
        const result = await core.joinInvitation(invitation!)
        stdout.write(JSON.stringify({ ok: true, operation: "join", groupId: result.groupId }) + "\n")
      }
      return 0
    } finally {
      await core.close()
    }
  } catch (error) {
    void error
    stderr.write("dsh-keet-setup: operation failed; check DSH_HOME, the fixed runtime, workspace, and input.\n")
    return 1
  }
}

export function parseArgs(argv: readonly string[]): SetupArguments {
  const [command, ...rest] = argv
  if (command !== "join" && command !== "profile") throw new Error("command")
  let workspaceDir = ""
  let displayName: string | undefined
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (flag === "--workspace" && value) { workspaceDir = value; index += 1; continue }
    if (flag === "--display-name" && value) { displayName = value; index += 1; continue }
    // Invitation-like arguments are rejected instead of accidentally accepting
    // a secret through argv. Unknown flags are also rejected closed.
    throw new Error("arguments")
  }
  if (!workspaceDir) throw new Error("workspace")
  if (command === "profile" && (!displayName || !displayName.trim() || displayName.length > MAX_NAME)) throw new Error("display name")
  if (command === "join" && displayName !== undefined) throw new Error("display name")
  return { command, workspaceDir: path.resolve(workspaceDir), ...(displayName !== undefined ? { displayName } : {}) }
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

if (process.argv[1] && isDirectExecution(import.meta.url, process.argv[1])) {
  process.exitCode = await runSetup(process.argv.slice(2))
}
