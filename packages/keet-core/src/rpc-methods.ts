export const RPC_METHODS = {
  swarmReady: 0,
  getVersion: 1,
  getIdentity: 6,
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
  updateIdentityProfile: 19,
  boot: 225,
} as const

export type RpcMethodName = keyof typeof RPC_METHODS
export type RpcStreamMethodName = 'subscribeChatMessages'
