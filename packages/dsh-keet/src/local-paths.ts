import { chmod, mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { KEET_COMPATIBILITY } from "@lamplitisles/keet-integration-core"
import type { KeetRuntimePaths } from "./runtime-options.js"

export const KEET_RUNTIME_DIRECTORY = `${KEET_COMPATIBILITY.appVersion}-linux-x64`
export const KEET_IDENTITY_RELATIVE_PATH = path.join(".dsh", "dsh-keet", "identity")

export function resolveKeetRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = env.DSH_HOME?.trim()
  if (!dshHome) throw new Error("DSH_HOME is required")
  return path.resolve(dshHome, "runtimes", "keet", KEET_RUNTIME_DIRECTORY)
}

export async function ensureKeetIdentityDataDir(workspacePath: string): Promise<string> {
  const workspaceRoot = await realpath(workspacePath)
  const target = path.join(workspaceRoot, KEET_IDENTITY_RELATIVE_PATH)
  await mkdir(target, { recursive: true, mode: 0o700 })
  const resolved = await realpath(target)
  const relative = path.relative(workspaceRoot, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("identity directory escapes workspace")
  await chmod(resolved, 0o700)
  return resolved
}

export async function resolveKeetRuntimePaths(workspacePath: string, env: NodeJS.ProcessEnv = process.env): Promise<KeetRuntimePaths> {
  return {
    runtimeDir: resolveKeetRuntimeDir(env),
    identityDataDir: await ensureKeetIdentityDataDir(workspacePath),
  }
}
