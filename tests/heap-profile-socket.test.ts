import { afterEach, describe, expect, it } from "vitest"
import { lstat, mkdtemp, rm } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { tmpdir } from "node:os"
import { keetHeapProfileSocketPath, startKeetHeapProfileSocket } from "../packages/dsh-keet/src/heap-profile-socket.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })))
})

async function dshHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "dsh-keet-socket-"))
  directories.push(directory)
  return directory
}

async function request(socketPath: string, value: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let response = ""
    const socket = net.createConnection(socketPath)
    socket.setEncoding("utf8")
    socket.setTimeout(2_000, () => { socket.destroy(new Error("socket request timed out")) })
    socket.once("connect", () => socket.end(value))
    socket.on("data", (chunk: string | Buffer) => { response += chunk.toString() })
    socket.once("error", reject)
    socket.once("end", () => resolve(response))
  })
}

describe("Keet heap profile socket", () => {
  it("exposes one owner-only structural response and removes its socket on disposal", async () => {
    const home = await dshHome()
    let captures = 0
    const close = await startKeetHeapProfileSocket({
      dshHome: home,
      capture: async () => {
        captures += 1
        return { nodeCount: 3, selfSizeBytes: 28, nodeTypes: [{ type: "array", nodeCount: 2, selfSizeBytes: 24 }, { type: "string", nodeCount: 1, selfSizeBytes: 4 }] }
      },
    })
    expect(close).toBeTypeOf("function")
    const socketPath = keetHeapProfileSocketPath(home)
    const info = await lstat(socketPath)
    expect(info.isSocket()).toBe(true)
    expect(info.mode & 0o777).toBe(0o600)
    await expect(request(socketPath, "capture\n")).resolves.toBe("{\"ok\":true,\"value\":{\"nodeCount\":3,\"selfSizeBytes\":28,\"nodeTypes\":[{\"type\":\"array\",\"nodeCount\":2,\"selfSizeBytes\":24},{\"type\":\"string\",\"nodeCount\":1,\"selfSizeBytes\":4}]}}\n")
    await expect(request(socketPath, "other\n")).resolves.toBe("{\"ok\":false,\"error\":\"profile unavailable\"}\n")
    expect(captures).toBe(1)
    await close!()
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
