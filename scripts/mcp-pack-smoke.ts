import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

async function main(): Promise<void> {
  const root = resolve(new URL("..", import.meta.url).pathname)
  const packageRoot = join(root, "packages", "keet-mcp")
  if (!existsSync(join(packageRoot, "dist", "cli.js"))) throw new Error("mcp pack-smoke requires a fresh pnpm build")
  const temp = await mkdtemp(join(tmpdir(), "keet-mcp-pack-smoke-"))
  try {
    const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], { cwd: packageRoot })
    const filename = (JSON.parse(stdout) as Array<{ filename?: string }>)[0]?.filename
    if (!filename) throw new Error("npm pack did not create the gateway artifact")
    const artifact = join(temp, filename)
    const files = (await run("tar", ["-tzf", artifact])).stdout.split("\n").filter(Boolean)
    for (const required of ["package/dist/index.js", "package/dist/cli.js", "package/package.json", "package/README.md", "package/LICENSE"]) if (!files.includes(required)) throw new Error(`gateway artifact missing ${required}`)
    if (files.some((file) => file.includes(".scratch") || /(?:runtime|identity|invitation|message-data|\.(?:png|jpe?g|webp|gif|key|pem))$/i.test(file))) throw new Error("gateway artifact contains private material")
    const installed = join(temp, "installed")
    await run("npm", ["install", "--ignore-scripts", "--prefix", installed, artifact])
    const { stdout: help } = await run(process.execPath, [join(installed, "node_modules", ".bin", "keet-mcpd"), "--help"])
    if (!help.includes("KEET_MCP_TOKEN")) throw new Error("gateway executable help is unavailable")
  } finally { await rm(temp, { recursive: true, force: true }) }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
