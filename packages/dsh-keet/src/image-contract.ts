import type { KeetImageMediaType } from "./core-contract.js"

/** Structural subset of DSH's durable attachment service used by the bridge. */
export interface KeetImageAttachmentRef {
  readonly attachmentId: string
  readonly mediaType: KeetImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}

export interface KeetSaveImageAttachment {
  readonly data: Uint8Array
  readonly mediaType: KeetImageMediaType
  readonly name?: string
}

export interface KeetAttachmentStore {
  readonly imageLimits?: {
    readonly maxImageBytes?: number
    readonly maxImagesPerMessage?: number
    readonly maxMessageImageBytes?: number
    readonly maxImagePixels?: number
    readonly maxImageDimension?: number
    readonly mediaTypes?: readonly KeetImageMediaType[]
  }
  validateImage?(input: KeetSaveImageAttachment): Promise<void>
  saveImages?(inputs: readonly KeetSaveImageAttachment[]): Promise<readonly KeetImageAttachmentRef[]>
}

/** Stable target shape returned by the DSH `ctx.fs` service. */
export interface KeetFileSystemTarget {
  readonly targetKey: unknown
  readonly displayPath: string
}

/**
 * Active Conversation workspace filesystem capability. The primary methods
 * mirror DSH's `ctx.fs` service: paths resolve to opaque targets, containment
 * is checked by the backend, and bounded bytes are read through that target.
 * The optional `readFile`/path helpers exist only for small test-owned fakes;
 * production composition uses the target-based methods above.
 */
export interface KeetWorkspaceFileSystem {
  readonly root?: string
  resolve?(path: string, options?: { readonly cwd?: string; readonly signal?: AbortSignal }): Promise<KeetFileSystemTarget>
  contains?(parent: KeetFileSystemTarget, child: KeetFileSystemTarget): boolean
  stat?(target: KeetFileSystemTarget, signal?: AbortSignal): Promise<{ readonly type: "file" | "directory" | "other"; readonly size?: number } | undefined>
  readBytes?(target: KeetFileSystemTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  resolvePath?(path: string, signal?: AbortSignal): string | Promise<string>
  realpath?(path: string, signal?: AbortSignal): string | Promise<string>
  readFile?(path: string, signal?: AbortSignal): Uint8Array | Promise<Uint8Array>
}

export interface KeetImageAttachmentBlock {
  readonly type: "image"
  readonly attachment: KeetImageAttachmentRef
}
