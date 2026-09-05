import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { prepareAvatar } from "../packages/dsh-keet/src/avatar.js"

describe("avatar preparation", () => {
  it("creates deterministic square PNG variants with bounded hashes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dsh-keet-avatar-"))
    try {
      const input = path.join(directory, "source.png")
      await writeGeneratedAvatar(input)
      const script = `
        import { prepareAvatar, validatePreparedAvatar } from "./packages/dsh-keet/src/avatar.ts"
        const first = await prepareAvatar(process.env.AVATAR_INPUT)
        const second = await prepareAvatar(process.env.AVATAR_INPUT)
        validatePreparedAvatar(first)
        validatePreparedAvatar(second)
        for (const [name, size] of [["small", 64], ["medium", 128], ["large", 256]]) {
          if (first[name].width !== size || first[name].height !== size || first[name].contentType !== "image/png" || !/^[a-f0-9]{64}$/.test(first[name].hash)) throw new Error("invalid avatar variant")
          if (first[name].hash !== second[name].hash) throw new Error("avatar output is not deterministic")
        }
        console.log("ok")
      `
      const result = execFileSync("node", ["--import", "tsx", "--input-type=module", "-e", script], { cwd: path.resolve(new URL("..", import.meta.url).pathname), env: { ...process.env, AVATAR_INPUT: input }, encoding: "utf8" })
      expect(result.trim()).toBe("ok")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("rejects unsupported local formats before processing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dsh-keet-avatar-invalid-"))
    try {
      const input = path.join(directory, "source.gif")
      await writeFile(input, Buffer.from("not-an-image"))
      await expect(prepareAvatar(input)).rejects.toThrow("unsupported")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function writeGeneratedAvatar(destination: string): Promise<void> {
  const width = 3
  const height = 2
  const scanlines = Buffer.alloc(height * (1 + width * 4))
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = row * (1 + width * 4) + 1 + column * 4
      scanlines[offset] = 44
      scanlines[offset + 1] = 116
      scanlines[offset + 2] = 190
      scanlines[offset + 3] = 217
    }
  }
  await writeFile(destination, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.from([0, 0, 0, width, 0, 0, 0, height, 8, 6, 0, 0, 0])),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]))
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii")
  const payload = Buffer.concat([typeBytes, data])
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(payload), 8 + data.length)
  return chunk
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
