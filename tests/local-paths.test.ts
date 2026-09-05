import { mkdtemp, realpath, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ensureKeetIdentityDataDir, resolveKeetRuntimeDir } from "../packages/dsh-keet/src/local-paths.js"

describe("Keet local path convention", () => {
  it("resolves the private runtime beneath DSH_HOME", () => {
    expect(resolveKeetRuntimeDir({ DSH_HOME: "/dsh-home" })).toBe("/dsh-home/runtimes/keet/4.21.0-linux-x64")
    expect(() => resolveKeetRuntimeDir({})).toThrow("DSH_HOME")
  })

  it("creates a workspace-owned identity directory", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "dsh-keet-workspace-"))
    try {
      const identity = await ensureKeetIdentityDataDir(workspace)
      expect(identity).toBe(path.join(await realpath(workspace), ".dsh", "dsh-keet", "identity"))
      expect((await stat(identity)).mode & 0o777).toBe(0o700)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
