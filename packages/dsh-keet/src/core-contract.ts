/**
 * Public adapter-side contracts. The implementation is bundled into the Host
 * entry, so the distributed package does not expose a workspace-only type
 * dependency in its declarations.
 */
export interface KeetMessageId {
  readonly deviceId: string
  readonly seq: number
}
export type KeetImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif"
/** Opaque Integration Core image descriptor; its worker pointer is never model-visible. */
export interface KeetImageFile {
  readonly file: unknown
  readonly mediaType: KeetImageMediaType
  readonly name?: string
  readonly bytes?: number
  readonly width?: number
  readonly height?: number
}
export interface KeetImagePreview {
  readonly bytes: Uint8Array
  readonly mediaType: KeetImageMediaType
  readonly width: number
  readonly height: number
}
export interface PreparedKeetImage {
  readonly bytes: Uint8Array
  readonly mediaType: KeetImageMediaType
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly preview?: KeetImagePreview
}

export interface KeetReactionSummary {
  /** Unicode emoji or a colon-wrapped bounded Keet wire shortcode. */
  readonly emoji: string
  readonly count: number
  /** True when the Integration Identity applied this reaction. */
  readonly own: boolean
}

export interface KeetMember {
  readonly memberId: string
  readonly displayName: string
  readonly avatar?: { readonly present: true; readonly digest?: string }
}

export type KeetRoomType = "Default" | "Broadcast" | "DirectMessage"
export interface ManagedGroup {
  readonly groupId: string
  readonly title?: string
  readonly description?: string
  readonly roomType?: KeetRoomType
  readonly dmMemberId?: string
}
export interface KeetPendingDmRequest { readonly memberId: string; readonly displayName?: string }
export interface KeetManagedDm extends ManagedGroup { readonly roomType: "DirectMessage"; readonly dmMemberId: string }
export interface PreparedAvatarVariant { readonly bytes: Uint8Array; readonly contentType: string; readonly width: number; readonly height: number; readonly hash: string }
export interface PreparedAvatar { readonly small: PreparedAvatarVariant; readonly medium: PreparedAvatarVariant; readonly large: PreparedAvatarVariant }

export interface KeetMessage {
  readonly messageId: KeetMessageId
  readonly groupId: string
  readonly senderId: string
  readonly senderLabel: string
  readonly timestamp: number
  readonly text: string
  readonly images?: readonly KeetImageFile[]
  /** Bridge-internal top-level chat position; never rendered to the Agent. */
  readonly chatIndex?: number
  readonly mentions?: readonly string[]
  readonly replyTo?: KeetMessageId
  readonly reactions?: readonly KeetReactionSummary[]
}

export interface KeetReadiness { readonly state: "ready"; readonly appVersion: string; readonly coreVersion: string; readonly abi: number; readonly swarming: boolean; readonly identityId: string; readonly displayName?: string }
export interface KeetSubscription {
  readonly closed: boolean
  readonly terminationReason?: "closed" | "connection-failed"
  onTerminate?(handler: (reason: "closed" | "connection-failed") => void): () => void
  close(): Promise<void>
}
export interface InvitationInfo { readonly isRoomInvitation: true; readonly title?: string; readonly description?: string }
export interface JoinResult { readonly groupId: string }
export interface KeetUsernameResult { readonly status: "searchable" | "pending"; readonly submitted: boolean }

export interface KeetCore {
  status(): Promise<KeetReadiness>
  listGroups(): Promise<ManagedGroup[]>
  resolveDm(memberId: string, signal?: AbortSignal): Promise<KeetManagedDm>
  listPendingDmRequests(signal?: AbortSignal): Promise<KeetPendingDmRequest[]>
  acceptDmRequest(memberId: string, signal?: AbortSignal): Promise<KeetManagedDm>
  listMembers(groupId: string): Promise<KeetMember[]>
  readRecentMessages(groupId: string, last?: number, signal?: AbortSignal): Promise<KeetMessage[]>
  readImage(groupId: string, image: KeetImageFile, signal?: AbortSignal): Promise<Uint8Array>
  sendImage(groupId: string, image: PreparedKeetImage, signal?: AbortSignal): Promise<void>
  watchMessages(groupId: string, handler: (message: KeetMessage) => void, signal?: AbortSignal): KeetSubscription
  /** Mark a Managed DM read through the native chat-index boundary. */
  setUnreadAnchor(groupId: string, length: number, signal?: AbortSignal): Promise<void>
  /** Publish one native Managed DM typing timestamp refresh. */
  updateTypingIndicator(groupId: string, signal?: AbortSignal): Promise<void>
  /** Native reaction mutation against one exact canonical message. */
  addReaction(groupId: string, messageId: KeetMessageId, reaction: string, signal?: AbortSignal): Promise<void>
  sendMessage(groupId: string, text: string, replyTo?: KeetMessageId, signal?: AbortSignal): Promise<KeetMessageId | undefined>
  inspectInvitation(invitation: string, signal?: AbortSignal): Promise<InvitationInfo>
  joinInvitation(invitation: string, signal?: AbortSignal): Promise<JoinResult>
  updateDisplayName(displayName: string, signal?: AbortSignal): Promise<void>
  updateIdentityProfile(profile: { readonly displayName?: string; readonly avatar?: PreparedAvatar }, signal?: AbortSignal): Promise<void>
  close(): Promise<void>
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
  platform?: string
  arch?: string
}
