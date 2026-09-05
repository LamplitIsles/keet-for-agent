export const PACKAGE_NAME = "dsh-keet"
export const PACKAGE_SPECIFIER = "@lamplitisles/dsh-keet"
export const SETTINGS_NAMESPACE = "dsh-keet"
export const RPC_CHANNEL = "/dsh-keet"
export const RPC_ENDPOINT = "readiness"
export const MAX_PROMPT_CHARS = 16_000
export const MAX_CONTEXT_MESSAGE_CHARS = 4_000
export const MAX_PROVENANCE_CHARS = 512
export const MAX_GROUP_MEMBERS = 128
export const MAX_RECENT_MESSAGES = 50
export const MAX_MESSAGE_TEXT = 16_000
export const DEDUPE_LIMIT = 512
export const CONTEXT_BUFFER_LIMIT = 64
export const CLASSIFICATION_STOP_TIMEOUT_MS = 100

export interface KeetSettings {
  groupId: string
  workspaceId: string
}

export const DEFAULT_SETTINGS: KeetSettings = Object.freeze({
  groupId: "",
  workspaceId: "",
})
