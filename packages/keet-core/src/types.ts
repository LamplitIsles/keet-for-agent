/** The compatibility tuple admitted by this package. */
export const KEET_COMPATIBILITY = Object.freeze({
  appVersion: "4.21.0",
  coreVersion: "4.21.5",
  abi: 35,
  platform: "linux",
  arch: "x64",
})

/** The pinned native-addon closure size for the official Linux worker. */
export const KEET_NATIVE_ADDON_COUNT = 25

export interface KeetCompatibilityOptions {
  readonly appVersion?: string
  readonly expectedCoreVersion?: string
  readonly expectedAbi?: number
  readonly platform?: string
  readonly arch?: string
}

/**
 * Validate the one supported application/core/ABI/platform tuple. Both the
 * Integration Core admission path and the sidecar use this function so the
 * tuple cannot silently diverge between their checks.
 */
export function validateKeetCompatibility(options: KeetCompatibilityOptions): void {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (platform !== KEET_COMPATIBILITY.platform || arch !== KEET_COMPATIBILITY.arch) {
    throw new Error("Keet official runtime supports Linux x86-64 only")
  }
  if (options.appVersion !== undefined && options.appVersion !== KEET_COMPATIBILITY.appVersion) {
    throw new Error("unsupported Keet application version")
  }
  if (options.expectedCoreVersion !== undefined && options.expectedCoreVersion !== KEET_COMPATIBILITY.coreVersion) {
    throw new Error("unsupported Keet core version")
  }
  if (options.expectedAbi !== undefined && options.expectedAbi !== KEET_COMPATIBILITY.abi) {
    throw new Error("unsupported Keet ABI")
  }
}

export interface KeetMessageId {
  readonly deviceId: string
  readonly seq: number
}

/**
 * A bounded aggregate reaction digest attached to an ordinary message.
 * Reactor identities are deliberately not part of the reusable Core contract.
 */
export interface KeetReactionSummary {
  /** Unicode emoji or a colon-wrapped bounded Keet wire shortcode. */
  readonly emoji: string
  readonly count: number
  /** True when the Integration Identity is one of the reacting members. */
  readonly own: boolean
}

export interface KeetMember {
  readonly memberId: string
  readonly displayName: string
  /** Bounded verification-only observation; avatar bytes never cross this boundary. */
  readonly avatar?: { readonly present: true; readonly digest?: string }
}

/** Room types emitted by the pinned Keet worker. */
export type KeetRoomType = "Default" | "Broadcast" | "DirectMessage"

export interface KeetMessage {
  readonly messageId: KeetMessageId
  readonly groupId: string
  readonly senderId: string
  readonly senderLabel: string
  readonly timestamp: number
  readonly text: string
  /**
   * Normalized top-level chat position retained for bridge-owned read state.
   * Adapters must not render or expose this metadata to an Agent.
   */
  readonly chatIndex?: number
  readonly mentions?: readonly string[]
  readonly replyTo?: KeetMessageId
  readonly reactions?: readonly KeetReactionSummary[]
}

export interface ManagedGroup {
  readonly groupId: string
  readonly title?: string
  readonly description?: string
  /** Present when the worker supplied room metadata. */
  readonly roomType?: KeetRoomType
  /** Present only for a normalized direct-message room. */
  readonly dmMemberId?: string
}

/** A pending human-sent DM request, with internal room data kept private. */
export interface KeetPendingDmRequest {
  readonly memberId: string
  readonly displayName?: string
}

/** A resolved, already-established direct message. */
export interface KeetManagedDm extends ManagedGroup {
  readonly roomType: "DirectMessage"
  readonly dmMemberId: string
}

export interface PreparedAvatarVariant {
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly width: number
  readonly height: number
  readonly hash: string
}

export interface PreparedAvatar {
  readonly small: PreparedAvatarVariant
  readonly medium: PreparedAvatarVariant
  readonly large: PreparedAvatarVariant
}

/** Disposable interoperability helpers; never exposed by the DSH tools. */
export interface CreateGroupOptions {
  readonly title: string
  readonly description?: string
}

export interface Invitation {
  readonly token: string
  readonly url: string
}

export interface KeetReadiness {
  readonly state: "ready"
  readonly appVersion: string
  readonly coreVersion: string
  readonly abi: number
  readonly swarming: boolean
  readonly identityId: string
  readonly displayName?: string
}

export interface KeetSubscription {
  close(): Promise<void>
  readonly closed: boolean
  readonly terminationReason?: "closed" | "connection-failed"
  onTerminate?(handler: (reason: "closed" | "connection-failed") => void): () => void
}

export interface KeetCore {
  status(): Promise<KeetReadiness>
  listGroups(): Promise<ManagedGroup[]>
  /** Test/onboarding helper; normal DSH operation never creates rooms. */
  createRoom?(options: CreateGroupOptions): Promise<string>
  /** Test/onboarding helper; normal DSH operation never creates invitations. */
  createInvitation?(groupId: string, options?: Record<string, unknown>): Promise<Invitation>
  /** Resolve an accepted direct message by the other participant's Member ID. */
  resolveDm(memberId: string, signal?: AbortSignal): Promise<KeetManagedDm>
  /** List bounded pending requests without exposing internal room identifiers. */
  listPendingDmRequests(signal?: AbortSignal): Promise<KeetPendingDmRequest[]>
  /** Accept exactly one already-pending request and wait for its DM room. */
  acceptDmRequest(memberId: string, signal?: AbortSignal): Promise<KeetManagedDm>
  listMembers(groupId: string): Promise<KeetMember[]>
  readRecentMessages(groupId: string, last?: number, signal?: AbortSignal): Promise<KeetMessage[]>
  watchMessages(groupId: string, handler: (message: KeetMessage) => void, signal?: AbortSignal): KeetSubscription
  /** Mark a Managed DM read through the native chat-index boundary. */
  setUnreadAnchor(groupId: string, length: number, signal?: AbortSignal): Promise<void>
  /** Publish one native Managed DM typing timestamp refresh. */
  updateTypingIndicator(groupId: string, signal?: AbortSignal): Promise<void>
  /** Add one native Unicode emoji reaction to an exact message. */
  addReaction(groupId: string, messageId: KeetMessageId, reaction: string, signal?: AbortSignal): Promise<void>
  sendMessage(groupId: string, text: string, replyTo?: KeetMessageId, signal?: AbortSignal): Promise<KeetMessageId | undefined>
  inspectInvitation(invitation: string, signal?: AbortSignal): Promise<InvitationInfo>
  joinInvitation(invitation: string, signal?: AbortSignal): Promise<JoinResult>
  updateDisplayName(displayName: string, signal?: AbortSignal): Promise<void>
  /** Update the complete attested profile; omitted fields are preserved. */
  updateIdentityProfile(profile: { readonly displayName?: string; readonly avatar?: PreparedAvatar }, signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

export interface KeetRuntimeManifest {
  appVersion: string
  coreVersion: string
  abi: number
  executablePath?: string
  bundlePath?: string
  nativeAddonPaths?: readonly string[]
}

export interface KeetCoreOptions {
  executablePath: string
  bundlePath: string
  dataPath: string
  appVersion?: string
  expectedCoreVersion?: string
  expectedAbi?: number
  swarming?: boolean
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
  pairingTimeoutMs?: number
  nativeAddonPaths?: readonly string[]
  runtimeManifest?: KeetRuntimeManifest
  platform?: string
  arch?: string
  logger?: (entry: import("./sidecar.js").KeetSidecarLog) => void
}

export interface JoinResult {
  readonly groupId: string
}

export interface InvitationInfo {
  readonly isRoomInvitation: true
  readonly title?: string
  readonly description?: string
}
