import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { PreparedAvatar, PreparedAvatarVariant } from "./core-contract.js"

type SharpFactory = (input: Buffer, options?: Record<string, unknown>) => any

export const AVATAR_VARIANT_SIZES = Object.freeze({ small: 64, medium: 128, large: 256 })
export const AVATAR_MAX_SOURCE_BYTES = 8 * 1024 * 1024
export const AVATAR_MAX_VARIANT_BYTES = 512 * 1024
export const AVATAR_MAX_PIXELS = 20_000_000

export function validatePreparedAvatar(avatar: PreparedAvatar): void {
  if (!avatar || typeof avatar !== "object") throw new Error("avatar is invalid")
  for (const name of ["small", "medium", "large"] as const) {
    const variant = avatar[name]
    if (!variant || !(variant.bytes instanceof Uint8Array) || variant.bytes.byteLength < 1 || variant.bytes.byteLength > AVATAR_MAX_VARIANT_BYTES) throw new Error("avatar variant is invalid")
    const expectedSize = AVATAR_VARIANT_SIZES[name]
    if (variant.width !== expectedSize || variant.height !== expectedSize) throw new Error("avatar dimensions are invalid")
    if (!/^image\/(?:png|jpeg|webp)$/.test(variant.contentType) || !/^[a-f0-9]{64}$/i.test(variant.hash)) throw new Error("avatar metadata is invalid")
    if (createHash("sha256").update(variant.bytes).digest("hex") !== variant.hash.toLowerCase()) throw new Error("avatar hash does not match its bytes")
  }
}

/**
 * Decode one ordinary local image and produce the three bounded square PNGs
 * required by the Keet profile RPC. The path is deliberately consumed only by
 * this human setup adapter; it is never placed in a Core/public value.
 */
export async function prepareAvatar(inputPath: string): Promise<PreparedAvatar> {
  if (typeof inputPath !== "string" || !inputPath.trim() || inputPath.length > 4_096) throw new Error("avatar input is invalid")
  const resolved = path.resolve(inputPath)
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(resolved)
  } catch {
    throw new Error("avatar input is unreadable")
  }
  if (!info.isFile() || info.size < 1) throw new Error("avatar input is unreadable")
  if (info.size > AVATAR_MAX_SOURCE_BYTES) throw new Error("avatar input is too large")
  let source: Buffer
  try {
    source = await readFile(resolved)
  } catch {
    throw new Error("avatar input is unreadable")
  }
  if (source.byteLength > AVATAR_MAX_SOURCE_BYTES) throw new Error("avatar input is too large")
  const extension = path.extname(resolved).toLowerCase()
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) throw new Error("avatar format is unsupported")
  try {
    const loaded = await import("sharp")
    const sharpFactory = (loaded.default ?? loaded) as unknown as SharpFactory
    const image = sharpFactory(source, { limitInputPixels: AVATAR_MAX_PIXELS, failOn: "error" })
    const metadata = await image.metadata()
    if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format)) throw new Error("avatar format is unsupported")
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > AVATAR_MAX_PIXELS) throw new Error("avatar dimensions are invalid")
    const variants: Partial<Record<keyof typeof AVATAR_VARIANT_SIZES, PreparedAvatarVariant>> = {}
    for (const [name, size] of Object.entries(AVATAR_VARIANT_SIZES) as Array<[keyof typeof AVATAR_VARIANT_SIZES, number]>) {
      const bytes = await image.clone().rotate().resize(size, size, { fit: "cover", position: "centre", withoutEnlargement: false }).png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toBuffer()
      if (bytes.byteLength < 1 || bytes.byteLength > AVATAR_MAX_VARIANT_BYTES) throw new Error("avatar variant is too large")
      variants[name] = {
        bytes,
        contentType: "image/png",
        width: size,
        height: size,
        hash: createHash("sha256").update(bytes).digest("hex"),
      }
    }
    if (!variants.small || !variants.medium || !variants.large) throw new Error("avatar image processing failed")
    const result = { small: variants.small, medium: variants.medium, large: variants.large }
    validatePreparedAvatar(result)
    return result
  } catch {
    throw new Error("avatar image processing failed")
  }
}
