import { chmod, mkdtemp, open, rm, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { KeetHeapProfile } from "./types.js"

const MAX_METADATA_BYTES = 1024 * 1024
const READ_BYTES = 64 * 1024
const MAX_NODE_FIELDS = 32
const MAX_NODE_TYPES = 64
const MAX_TYPE_NAME_CHARS = 128

interface SnapshotMetadata {
  readonly nodeFieldCount: number
  readonly typeField: number
  readonly selfSizeField: number
  readonly typeNames: readonly string[]
  readonly nodesOffset: number
}

interface MutableTypeTotal {
  nodeCount: number
  selfSizeBytes: number
}

/**
 * Ask the worker to write its V8 snapshot into a unique private directory,
 * stream only structural totals from it, then remove the directory before the
 * caller receives a result. The full snapshot never crosses this boundary.
 */
export async function captureHeapProfile(
  writeSnapshot: (snapshotPath: string) => Promise<unknown>,
): Promise<KeetHeapProfile> {
  const directory = await mkdtemp(path.join(tmpdir(), "dsh-keet-heap-"))
  try {
    await chmod(directory, 0o700)
    const snapshotPath = path.join(directory, "heap.heapsnapshot")
    await writeSnapshot(snapshotPath)
    return await summarizeHeapSnapshot(snapshotPath)
  } finally {
    // The parent directory is mode 0700 while the worker writes. Retrying is
    // useful on filesystems which briefly retain a just-closed stream handle.
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

/** Stream the `nodes` array without materializing a potentially huge JSON file. */
export async function summarizeHeapSnapshot(snapshotPath: string): Promise<KeetHeapProfile> {
  const file = await open(snapshotPath, "r")
  try {
    const metadata = await readMetadata(file)
    return await sumNodes(file, metadata)
  } finally {
    await file.close()
  }
}

async function readMetadata(file: FileHandle): Promise<SnapshotMetadata> {
  let prefix = ""
  let position = 0
  while (position < MAX_METADATA_BYTES) {
    const bytes = Buffer.allocUnsafe(Math.min(READ_BYTES, MAX_METADATA_BYTES - position))
    const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, position)
    if (bytesRead === 0) break
    position += bytesRead
    prefix += bytes.subarray(0, bytesRead).toString("utf8")
    const marker = /"nodes"\s*:\s*\[/.exec(prefix)
    if (!marker || marker.index === undefined) continue

    const nodeFields = parseStringArray(extractJsonArray(prefix, "node_fields"), "node fields", MAX_NODE_FIELDS)
    const nodeTypes = parseNodeTypes(extractJsonArray(prefix, "node_types"))
    const typeField = nodeFields.indexOf("type")
    const selfSizeField = nodeFields.indexOf("self_size")
    if (typeField < 0 || selfSizeField < 0) throw new Error("invalid heap snapshot metadata")
    const typeNames = nodeTypes[typeField]
    if (!typeNames) throw new Error("invalid heap snapshot metadata")
    // Snapshot metadata precedes the node array and is ASCII. Its JavaScript
    // character index is therefore the byte offset needed by FileHandle.read.
    return {
      nodeFieldCount: nodeFields.length,
      typeField,
      selfSizeField,
      typeNames,
      nodesOffset: marker.index + marker[0].length,
    }
  }
  throw new Error("heap snapshot metadata is unavailable")
}

function extractJsonArray(prefix: string, key: string): string {
  const keyStart = prefix.indexOf(`"${key}"`)
  if (keyStart < 0) throw new Error("invalid heap snapshot metadata")
  const start = prefix.indexOf("[", keyStart + key.length + 2)
  if (start < 0) throw new Error("invalid heap snapshot metadata")
  let depth = 0
  let quote = false
  let escaped = false
  for (let index = start; index < prefix.length; index += 1) {
    const char = prefix[index]!
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === "\"") quote = false
      continue
    }
    if (char === "\"") { quote = true; continue }
    if (char === "[") depth += 1
    else if (char === "]") {
      depth -= 1
      if (depth === 0) return prefix.slice(start, index + 1)
      if (depth < 0) break
    }
  }
  throw new Error("invalid heap snapshot metadata")
}

function parseStringArray(source: string, label: string, maximum: number): readonly string[] {
  let value: unknown
  try { value = JSON.parse(source) } catch { throw new Error("invalid heap snapshot metadata") }
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum
    || value.some((item) => typeof item !== "string" || !item || item.length > MAX_TYPE_NAME_CHARS)) {
    throw new Error(`invalid ${label}`)
  }
  return Object.freeze([...value]) as readonly string[]
}

function parseNodeTypes(source: string): readonly (readonly string[])[] {
  let value: unknown
  try { value = JSON.parse(source) } catch { throw new Error("invalid heap snapshot metadata") }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_NODE_FIELDS) throw new Error("invalid heap snapshot metadata")
  return Object.freeze(value.map((entry, index) => {
    if (!Array.isArray(entry)) return Object.freeze([]) as readonly string[]
    // Only the type-field entry is used, but validate every metadata list so
    // a malformed header cannot be mistaken for a supported snapshot.
    return parseStringArray(JSON.stringify(entry), `node type ${index}`, MAX_NODE_TYPES)
  }))
}

async function sumNodes(file: FileHandle, metadata: SnapshotMetadata): Promise<KeetHeapProfile> {
  const totals: MutableTypeTotal[] = metadata.typeNames.map(() => ({ nodeCount: 0, selfSizeBytes: 0 }))
  let field = 0
  let nodeType: number | undefined
  let selfSize: number | undefined
  let nodeCount = 0
  let selfSizeBytes = 0
  let token = ""
  let state: "value-or-end" | "comma-or-end" = "value-or-end"
  let sawValue = false
  let position = metadata.nodesOffset

  const completeNodeField = (value: number): void => {
    if (field === metadata.typeField) nodeType = value
    if (field === metadata.selfSizeField) selfSize = value
    field += 1
    if (field !== metadata.nodeFieldCount) return
    if (nodeType === undefined || nodeType < 0 || nodeType >= totals.length || selfSize === undefined) {
      throw new Error("invalid heap snapshot nodes")
    }
    const total = totals[nodeType]!
    total.nodeCount = safeAdd(total.nodeCount, 1)
    total.selfSizeBytes = safeAdd(total.selfSizeBytes, selfSize)
    nodeCount = safeAdd(nodeCount, 1)
    selfSizeBytes = safeAdd(selfSizeBytes, selfSize)
    field = 0
    nodeType = undefined
    selfSize = undefined
  }
  const completeToken = (): void => {
    if (!token) return
    if (!/^\d+$/.test(token)) throw new Error("invalid heap snapshot nodes")
    const value = Number(token)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid heap snapshot nodes")
    completeNodeField(value)
    token = ""
    state = "comma-or-end"
    sawValue = true
  }

  while (true) {
    const bytes = Buffer.allocUnsafe(READ_BYTES)
    const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, position)
    if (bytesRead === 0) break
    position += bytesRead
    for (const code of bytes.subarray(0, bytesRead)) {
      if (code >= 0x30 && code <= 0x39) {
        if (!token && state !== "value-or-end") throw new Error("invalid heap snapshot nodes")
        if (token.length >= 16) throw new Error("invalid heap snapshot nodes")
        token += String.fromCharCode(code)
        continue
      }
      if (code === 0x2d) {
        // V8 node data is non-negative; reject a sign before it becomes a
        // partially accepted token.
        throw new Error("invalid heap snapshot nodes")
      }
      if (code === 0x2c) {
        completeToken()
        if (!hasCompletedValue(state)) throw new Error("invalid heap snapshot nodes")
        state = "value-or-end"
        continue
      }
      if (code === 0x5d) {
        completeToken()
        if (!hasCompletedValue(state) || field !== 0) throw new Error("invalid heap snapshot nodes")
        return Object.freeze({
          nodeCount,
          selfSizeBytes,
          nodeTypes: Object.freeze(metadata.typeNames.flatMap((type, index) => {
            const total = totals[index]!
            return total.nodeCount === 0 ? [] : [Object.freeze({ type, nodeCount: total.nodeCount, selfSizeBytes: total.selfSizeBytes })]
          })),
        })
      }
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        completeToken()
        continue
      }
      throw new Error("invalid heap snapshot nodes")
    }
  }
  // A valid snapshot always closes the node array. `sawValue` keeps an empty
  // array distinct from an abruptly truncated file after its opening bracket.
  if (!sawValue) throw new Error("invalid heap snapshot nodes")
  throw new Error("incomplete heap snapshot nodes")
}

function safeAdd(left: number, right: number): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new Error("heap snapshot total exceeds bounds")
  return result
}

function hasCompletedValue(state: "value-or-end" | "comma-or-end"): boolean {
  return state === "comma-or-end"
}
