import { KeetSidecar } from "../../packages/keet-core/src/sidecar.ts"
import { fileURLToPath } from "node:url"

const mode = process.argv[2]
const dataPath = process.argv[3]
const fixture = fileURLToPath(new URL("./fake-worker.mjs", import.meta.url))
const sidecar = new KeetSidecar({
  executablePath: process.execPath,
  bundlePath: fixture,
  dataPath,
  swarming: false,
  startupTimeoutMs: 3_000,
  shutdownTimeoutMs: 1_000,
})

if (mode === "hold") {
  try {
    await sidecar.start()
    process.stdout.write("ready\n")
    process.once("SIGTERM", async () => {
      await sidecar.close()
      process.exit(0)
    })
    await new Promise(() => undefined)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
} else if (mode === "attempt") {
  try {
    await sidecar.start()
    process.stdout.write("ready\n")
    await sidecar.close()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
} else {
  process.stderr.write("unknown lock-holder mode\n")
  process.exitCode = 1
}
