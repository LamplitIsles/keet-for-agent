import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import type { KeetImageMediaType } from "@lamplitisles/keet-integration-core"

const extensions: Record<KeetImageMediaType, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
}
const types: Record<string, KeetImageMediaType> = Object.fromEntries(Object.entries(extensions).map(([type, extension]) => [extension, type as KeetImageMediaType]))
const referencePattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:png|jpg|webp|gif)$/
const maxBytes = 16 * 1024 * 1024

export class InboundImageStore {
  readonly directory: string
  constructor(stateDir: string) { this.directory = path.join(stateDir, "images") }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    if (!(await stat(this.directory)).isDirectory()) throw new Error("Inbound image store is not a directory.")
  }

  async save(bytes: Uint8Array, mediaType: KeetImageMediaType): Promise<string> {
    if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error("Inbound image exceeds the supported size.")
    const reference = `${randomUUID()}.${extensions[mediaType]}`
    const temporary = path.join(this.directory, `${reference}.pending`)
    const handle = await open(temporary, "wx", 0o600)
    try { await handle.writeFile(bytes); await handle.sync() }
    catch (error) { await handle.close(); await rm(temporary, { force: true }).catch(() => undefined); throw error }
    await handle.close()
    try {
      await rename(temporary, path.join(this.directory, reference))
      const directory = await open(this.directory, "r")
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error }
    return reference
  }

  async read(reference: string): Promise<{ bytes: Buffer; mediaType: KeetImageMediaType } | undefined> {
    if (!referencePattern.test(reference)) return undefined
    const mediaType = types[reference.slice(reference.lastIndexOf(".") + 1)]
    if (!mediaType) return undefined
    let handle: Awaited<ReturnType<typeof open>>
    try { handle = await open(path.join(this.directory, reference), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error }
    try {
      const info = await handle.stat()
      if (!info.isFile() || !info.size || info.size > maxBytes) return undefined
      const bytes = await handle.readFile()
      if (bytes.byteLength !== info.size) return undefined
      return { bytes, mediaType }
    } finally { await handle.close() }
  }
}
