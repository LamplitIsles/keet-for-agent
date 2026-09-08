import { readFile } from "node:fs/promises"
import path from "node:path"
import type { KeetCoreOptions } from "@lamplitisles/keet-integration-core"
import { httpBase } from "./impri.js"

export interface BotConfig {
  baseUrl: string
  inboxUrl: string
  apiKey: string
  runtimeDir: string
  dataDir: string
}

export async function readConfig(file: string): Promise<BotConfig> {
  const text = await readFile(file, "utf8")
  if (text.length > 16_384) throw new Error("Config is too large")
  const raw: unknown = JSON.parse(text)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid bot config")
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some((key) => !["baseUrl", "inboxUrl", "apiKey", "runtimeDir", "dataDir"].includes(key))) throw new Error("Unknown config field")
  if (typeof value.apiKey !== "string" || !/^im_[^\s]{1,512}$/.test(value.apiKey)) throw new Error("Invalid Impri API key")
  for (const key of ["runtimeDir", "dataDir"] as const) {
    if (typeof value[key] !== "string" || !path.isAbsolute(value[key]) || value[key].length > 4_096) throw new Error(`${key} must be an absolute path`)
  }
  return {
    baseUrl: httpBase(value.baseUrl), inboxUrl: httpBase(value.inboxUrl), apiKey: value.apiKey,
    runtimeDir: path.resolve(value.runtimeDir as string), dataDir: path.resolve(value.dataDir as string),
  }
}

export function runtimeOptions(config: BotConfig): KeetCoreOptions {
  return {
    executablePath: path.join(config.runtimeDir, "bare"),
    bundlePath: path.join(config.runtimeDir, "core-worker.bundle"),
    dataPath: path.join(config.dataDir, "identity"),
  }
}
