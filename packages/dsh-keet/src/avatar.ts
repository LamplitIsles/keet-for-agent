import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
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
  let source: Buffer
  try {
    const info = await stat(resolved)
    if (!info.isFile() || info.size < 1 || info.size > AVATAR_MAX_SOURCE_BYTES) throw new Error("avatar input is too large")
    source = await readFile(resolved)
  } catch {
    throw new Error("avatar input is unreadable")
  }
  if (source.byteLength > AVATAR_MAX_SOURCE_BYTES) throw new Error("avatar input is too large")
  const extension = path.extname(resolved).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) throw new Error("avatar format is unsupported")
  let image: any
  try {
    // Keep the native image module out of the setup import path. Some
    // operator environments do not have its optional platform runtime; the
    // deterministic ImageMagick fallback below still handles the same three
    // ordinary input formats without making profile-only commands fail.
    const loaded = await import("sharp")
    const sharpFactory = (loaded.default ?? loaded) as unknown as SharpFactory
    image = sharpFactory(source, { limitInputPixels: AVATAR_MAX_PIXELS, failOn: "error" })
    const metadata = await image.metadata()
    if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format)) throw new Error("avatar format is unsupported")
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > AVATAR_MAX_PIXELS) throw new Error("avatar dimensions are invalid")
  } catch {
    image = undefined
  }
  if (!image) await inspectWithImageMagick(source)
  const variants: Partial<Record<keyof typeof AVATAR_VARIANT_SIZES, PreparedAvatarVariant>> = {}
  for (const [name, size] of Object.entries(AVATAR_VARIANT_SIZES) as Array<[keyof typeof AVATAR_VARIANT_SIZES, number]>) {
    try {
      const bytes = image
        ? await image.clone().rotate().resize(size, size, { fit: "cover", position: "centre", withoutEnlargement: false }).png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toBuffer()
        : await convertWithImageMagick(source, size)
      if (bytes.byteLength < 1 || bytes.byteLength > AVATAR_MAX_VARIANT_BYTES) throw new Error("avatar variant is too large")
      variants[name] = {
        bytes,
        contentType: "image/png",
        width: size,
        height: size,
        hash: createHash("sha256").update(bytes).digest("hex"),
      }
    } catch {
      throw new Error("avatar image processing failed")
    }
  }
  if (!variants.small || !variants.medium || !variants.large) throw new Error("avatar image processing failed")
  const result = { small: variants.small, medium: variants.medium, large: variants.large }
  validatePreparedAvatar(result)
  return result
}

async function convertWithImageMagick(source: Buffer, size: number): Promise<Buffer> {
  const child = spawn("convert", ["-limit", "area", String(AVATAR_MAX_PIXELS), "-", "-auto-orient", "-resize", `${size}x${size}^`, "-gravity", "center", "-extent", `${size}x${size}`, "-strip", "PNG:-"], { stdio: ["pipe", "pipe", "pipe"] })
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk))
  const result = await new Promise<{ code: number | null; error?: Error }>((resolve, reject) => {
    child.once("error", (error) => reject(error))
    child.once("exit", (code) => resolve({ code }))
    child.stdin.end(source)
  })
  if (result.code !== 0) throw new Error(errors.length ? errors[0]!.toString("utf8").slice(0, 128) : "image conversion failed")
  return Buffer.concat(chunks)
}

async function inspectWithImageMagick(source: Buffer): Promise<void> {
  const child = spawn("identify", ["-limit", "area", String(AVATAR_MAX_PIXELS), "-format", "%m %w %h", "-"], { stdio: ["pipe", "pipe", "pipe"] })
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk))
  const result = await new Promise<{ code: number | null }>((resolve, reject) => {
    child.once("error", (error) => reject(error))
    child.once("exit", (code) => resolve({ code }))
    child.stdin.end(source)
  })
  if (result.code !== 0) throw new Error(errors.length ? errors[0]!.toString("utf8").slice(0, 128) : "image inspection failed")
  const [format, widthText, heightText] = Buffer.concat(chunks).toString("utf8").trim().split(/\s+/)
  const width = Number(widthText)
  const height = Number(heightText)
  if (!format || !["PNG", "JPEG", "WEBP"].includes(format.toUpperCase()) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > AVATAR_MAX_PIXELS) throw new Error("avatar dimensions or format are invalid")
}
