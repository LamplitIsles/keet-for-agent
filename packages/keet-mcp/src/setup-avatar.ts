import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { PreparedAvatar, PreparedAvatarVariant } from "@lamplitisles/keet-integration-core"

const SIZES = { small: 64, medium: 128, large: 256 } as const
const MAX_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_VARIANT_BYTES = 512 * 1024
const MAX_PIXELS = 20_000_000

/** Prepare the bounded square variants expected by Keet's native profile RPC. */
export async function prepareAvatar(file: string): Promise<PreparedAvatar> {
  if (!file.trim() || file.length > 4_096) throw new Error("invalid avatar path")
  const resolved = path.resolve(file)
  const info = await stat(resolved)
  if (!info.isFile() || info.size < 1 || info.size > MAX_SOURCE_BYTES) throw new Error("invalid avatar file")
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(resolved).toLowerCase())) throw new Error("unsupported avatar format")
  const source = await readFile(resolved)
  if (source.byteLength > MAX_SOURCE_BYTES) throw new Error("avatar file is too large")
  const { default: sharp } = await import("sharp")
  const image = sharp(source, { limitInputPixels: MAX_PIXELS, failOn: "error" })
  const metadata = await image.metadata()
  if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format) || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) throw new Error("invalid avatar image")
  const variants: Partial<Record<keyof typeof SIZES, PreparedAvatarVariant>> = {}
  for (const [name, size] of Object.entries(SIZES) as Array<[keyof typeof SIZES, number]>) {
    const bytes = await image.clone().rotate().resize(size, size, { fit: "cover", position: "centre" }).png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toBuffer()
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_VARIANT_BYTES) throw new Error("avatar variant is too large")
    variants[name] = { bytes, contentType: "image/png", width: size, height: size, hash: createHash("sha256").update(bytes).digest("hex") }
  }
  if (!variants.small || !variants.medium || !variants.large) throw new Error("incomplete avatar variants")
  return { small: variants.small, medium: variants.medium, large: variants.large }
}
