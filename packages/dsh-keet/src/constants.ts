export const PACKAGE_NAME = "dsh-keet"
export const PACKAGE_SPECIFIER = "@lamplitisles/dsh-keet"
export const SETTINGS_NAMESPACE = "dsh-keet"
export const RPC_CHANNEL = "/dsh-keet"
export const RPC_ENDPOINT = "readiness"
export const RPC_ONBOARDING_ENDPOINT = "onboarding"
export const MAX_PROMPT_CHARS = 16_000
export const MAX_CONTEXT_MESSAGE_CHARS = 4_000
export const MAX_PROVENANCE_CHARS = 512
export const MAX_GROUP_MEMBERS = 128
export const MAX_RECENT_MESSAGES = 50
export const MAX_MESSAGE_TEXT = 16_000
export const DEDUPE_LIMIT = 512
export const CONTEXT_BUFFER_LIMIT = 64
export const CLASSIFICATION_STOP_TIMEOUT_MS = 100
export const DM_TYPING_REFRESH_MS = 4_000
/** Bridge-owned roster observation cadence; not a user-facing setting. */
export const MEMBER_JOIN_POLL_INTERVAL_MS = 10_000
/** Maximum number of messages accepted in one durable inbox projection. */
export const MAX_INBOX_SPLICE_MESSAGES = 4_096

export type KeetMemberJoinTriggers = Readonly<Record<string, Readonly<Record<string, boolean>>>>

export interface KeetSettings {
  workspaceId: string
  /** Workspace-scoped preferences keyed by the stable native group ID. */
  memberJoinTriggers: KeetMemberJoinTriggers
}

export const DEFAULT_SETTINGS: KeetSettings = Object.freeze({
  workspaceId: "",
  memberJoinTriggers: Object.freeze({}),
})
