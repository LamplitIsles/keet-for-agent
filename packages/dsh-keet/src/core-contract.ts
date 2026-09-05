/**
 * Public adapter-side contracts. The implementation is bundled into the Host
 * entry, so the distributed package does not expose a workspace-only type
 * dependency in its declarations.
 */
export interface KeetMessageId {
  readonly deviceId: string
  readonly seq: number
}

export interface KeetMember {
  readonly memberId: string
  readonly displayName: string
}

export interface KeetMessage {
  readonly messageId: KeetMessageId
  readonly groupId: string
  readonly senderId: string
  readonly senderLabel: string
  readonly timestamp: number
  readonly text: string
  readonly mentions?: readonly string[]
  readonly replyTo?: KeetMessageId
}

export interface ManagedGroup { readonly groupId: string; readonly title?: string; readonly description?: string }
export interface KeetReadiness { readonly state: "ready"; readonly appVersion: string; readonly coreVersion: string; readonly abi: number; readonly swarming: boolean; readonly identityId: string; readonly displayName?: string }
export interface KeetSubscription {
  readonly closed: boolean
  readonly terminationReason?: "closed" | "connection-failed"
  onTerminate?(handler: (reason: "closed" | "connection-failed") => void): () => void
  close(): Promise<void>
}
export interface InvitationInfo { readonly isRoomInvitation: true; readonly title?: string; readonly description?: string }
export interface JoinResult { readonly groupId: string }

export interface KeetCore {
  status(): Promise<KeetReadiness>
  listGroups(): Promise<ManagedGroup[]>
  validateGroup(groupId: string): Promise<ManagedGroup>
  listMembers(groupId: string): Promise<KeetMember[]>
  readRecentMessages(groupId: string, last?: number, signal?: AbortSignal): Promise<KeetMessage[]>
  watchMessages(groupId: string, handler: (message: KeetMessage) => void, signal?: AbortSignal): KeetSubscription
  sendMessage(groupId: string, text: string, replyTo?: KeetMessageId, signal?: AbortSignal): Promise<KeetMessageId | undefined>
  inspectInvitation(invitation: string, signal?: AbortSignal): Promise<InvitationInfo>
  joinInvitation(invitation: string, signal?: AbortSignal): Promise<JoinResult>
  updateDisplayName(displayName: string, signal?: AbortSignal): Promise<void>
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
