import path from "node:path"
import { KEET_COMPATIBILITY, type KeetCoreOptions } from "@lamplitisles/keet-integration-core"

export interface KeetRuntimePaths {
  readonly runtimeDir: string
  readonly identityDataDir: string
}

/** Build the one pinned runtime tuple used by both the bridge and setup CLI. */
export function createKeetRuntimeOptions(paths: KeetRuntimePaths): KeetCoreOptions {
  return {
    executablePath: path.join(paths.runtimeDir, "bare"),
    bundlePath: path.join(paths.runtimeDir, "core-worker.bundle"),
    dataPath: paths.identityDataDir,
    appVersion: KEET_COMPATIBILITY.appVersion,
    expectedCoreVersion: KEET_COMPATIBILITY.coreVersion,
    expectedAbi: KEET_COMPATIBILITY.abi,
  }
}
