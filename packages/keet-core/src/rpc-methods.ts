export const RPC_METHODS = {
  swarmReady: 0,
  getVersion: 1,
  getIdentity: 6,
  getRoomInfo: 39,
  getLinkInfo: 22,
  createRoom: 25,
  startPairingRoom: 28,
  stopPairingRoom: 29,
  getRecentRooms: 43,
  createInvitation: 61,
  getMembers: 66,
  addChatMessage: 104,
  getChatMessages: 136,
  subscribeChatMessages: 139,
  /** Used only by the disposable opt-in official interoperability smoke. */
  sendDmRequest: 144,
  updateIdentityProfile: 19,
  getDmRequestsByStatus: 152,
  acceptDmRequest: 154,
  /** Global username registry lookup and mutations in the pinned worker. */
  lookupUsername: 195,
  registerUsername: 198,
  updateUsername: 199,
  checkUsername: 202,
  /** Native Managed DM read position; the worker enforces room/policy gates. */
  setUnreadAnchor: 218,
  /** Native Managed DM typing timestamp refresh; the worker enforces room gates. */
  updateTypingIndicator: 220,
  /** Native aggregate reaction mutation; the worker enforces room/message policy. */
  addReaction: 156,
  boot: 225,
  /** Working pinned file lifecycle; addFile/addFileBlob are missing stubs. */
  saveFileBlob: 171,
  sendFile: 174,
  readFileStream: 184,
} as const

export type RpcMethodName = keyof typeof RPC_METHODS
export type RpcStreamMethodName = 'subscribeChatMessages' | 'readFileStream'
