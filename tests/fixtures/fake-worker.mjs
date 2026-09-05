#!/usr/bin/env node

// Test-only fd-3 worker. It models the tiny subset of the pinned worker RPC
// surface exercised by Core tests; it never talks to a Keet network.
import net from "node:net"
import TinyBufferRPC from "tiny-buffer-rpc"
import any from "tiny-buffer-rpc/any.js"

const dataPath = process.argv[2]
const ipc = new net.Socket({ fd: 3, readable: true, writable: true })
const groupId = "group-test"
const dmGroupId = "group-dm"
const dmMemberId = "member-peer"
const selfId = "identity-self"
const dmMode = dataPath.includes("dm-flow") || dataPath.includes("dm-broadcast")
const roomTypesMode = dataPath.includes("room-types")
const broadcastGroupId = "group-broadcast"
const dmBroadcast = dataPath.includes("dm-broadcast")
let dmAccepted = dataPath.includes("dm-broadcast")
const groups = [{ roomId: groupId, title: "Test group", description: "fixture" }, ...(roomTypesMode ? [{ roomId: broadcastGroupId, title: "Broadcast", description: "fixture broadcast" }] : []), ...(dmMode ? [{ roomId: dmGroupId, title: "Managed DM", description: "fixture DM" }] : [])]
const members = [
  { memberId: selfId, displayName: "Fixture Bot" },
  { memberId: "member-alice", displayName: "Alice" },
]
const officialShape = dataPath.includes("official-shape")
const missingIdentity = dataPath.includes("missing-identity")
const messages = officialShape ? [
  {
    timestamp: 4,
    memberId: "member-alice",
    member: { memberId: "member-alice", displayName: "Official Alice" },
    id: { deviceId: "device-alice", seq: 11 },
    deleted: false,
    message: { text: "official mention" },
    chat: { text: "official mention", edited: false, mentions: [{ type: "mention", memberId: selfId }] },
  },
  {
    timestamp: 5,
    memberId: "member-alice",
    member: { memberId: "member-alice", displayName: "Official Alice" },
    id: { deviceId: "device-alice", seq: 12 },
    deleted: false,
    message: { text: "edited official record" },
    chat: { text: "edited official record", edited: true, mentions: [] },
  },
] : [
  { roomId: groupId, messageId: { deviceId: "device-alice", seq: 1 }, senderId: "member-alice", senderName: "Alice", timestamp: 1, type: "text", text: "initial context" },
  { roomId: groupId, messageId: { deviceId: "device-self", seq: 2 }, senderId: selfId, senderName: "Fixture Bot", timestamp: 2, type: "text", text: "initial self" },
  { roomId: groupId, messageId: { deviceId: "device-system", seq: 3 }, senderId: "system", timestamp: 3, type: "system", text: "ignored system" },
  { roomId: groupId, messageId: { deviceId: "device-alice", seq: 4 }, senderId: "member-alice", senderName: "Alice", timestamp: 4, type: "text", text: "ignored malformed reply", replyTo: { deviceId: "device-self" } },
  { roomId: groupId, messageId: { deviceId: "device-alice", seq: 5 }, senderId: "member-alice", senderName: "Alice", timestamp: 5, type: "text", text: "ignored masked malformed reply", replyTo: null, options: { replyTo: { deviceId: "device-self", seq: 2 } } },
]
const streams = new Set()
let nextSeq = 10
const invitationToken = "fixture-token"

const rpc = new TinyBufferRPC((message) => {
  const frame = Buffer.allocUnsafe(message.length + 4)
  frame.writeUInt32LE(message.length, 0)
  message.copy(frame, 4)
  ipc.write(frame)
})

rpc.register(0, { request: any, response: any, onrequest: () => true })
rpc.register(1, { request: any, response: any, onrequest: () => ({ modules: { "keet-core": "4.21.5" }, abi: { production: 35 } }) })
rpc.register(6, { request: any, response: any, onrequest: () => missingIdentity ? {} : ({ memberId: selfId, displayName: "Fixture Bot" }) })
rpc.register(19, { request: any, response: any, onrequest: ([profile]) => { if (profile?.displayName) members[0].displayName = profile.displayName; if (profile?.avatar) members[0].avatar = profile.avatar; return {} } })
rpc.register(22, { request: any, response: any, onrequest: ([value]) => ({ isRoomInvitation: value === invitationToken, title: "Test group" }) })
rpc.register(25, { request: any, response: any, onrequest: ([options]) => { void options; return groupId } })
rpc.register(28, { request: any, response: any, onrequest: () => ({ roomId: groupId }) })
rpc.register(39, { request: any, response: any, onrequest: ([room]) => room === groupId ? ({ roomId: groupId, title: "Test group", description: "fixture", roomType: "Default" }) : room === broadcastGroupId && roomTypesMode ? ({ roomId: broadcastGroupId, title: "Broadcast", description: "fixture broadcast", roomType: "Broadcast" }) : room === dmGroupId && dmMode ? ({ roomId: dmGroupId, title: "Managed DM", description: "fixture DM", roomType: dmBroadcast ? "Broadcast" : "DirectMessage", dmMemberId }) : null })
rpc.register(43, { request: any, response: any, onrequest: () => ({ rooms: groups }) })
rpc.register(61, { request: any, response: any, onrequest: () => invitationToken })
rpc.register(66, { request: any, response: any, onrequest: ([room]) => room === dmGroupId && dmMode ? [...members, { memberId: dmMemberId, displayName: "Peer" }] : members })
rpc.register(151, { request: any, response: any, onrequest: ([memberId]) => dmMode && memberId === dmMemberId ? ({ roomId: dmGroupId, dmMemberId, recipient: dmMemberId }) : ({ roomId: null, dmMemberId: String(memberId ?? ""), recipient: String(memberId ?? "") }) })
rpc.register(152, { request: any, response: any, onrequest: ([status]) => dmMode && status === 3 && !dmAccepted ? [{ id: { memberId: dmMemberId, roomId: dmGroupId }, roomId: dmGroupId, senderContactInfo: { memberId: dmMemberId, displayName: "Peer" }, status: { isPending: true }, message: "private request" }] : [] })
rpc.register(154, { request: any, response: any, onrequest: ([request]) => { if (!dmMode || request?.memberId !== dmMemberId || request?.roomId !== dmGroupId) throw new Error("invalid DM request"); dmAccepted = true; return {} } })
rpc.register(104, {
  request: any,
  response: any,
  onrequest: ([roomId, text, options]) => {
    const human = typeof text === "string" && text.startsWith("[human] ")
    const sent = { roomId, messageId: { deviceId: human ? "device-alice" : "device-self", seq: nextSeq++ }, senderId: human ? "member-alice" : selfId, senderName: human ? "Alice" : members[0].displayName, timestamp: Date.now(), type: "text", text: human ? text.slice(8) : text, ...(options?.replyTo ? { replyTo: options.replyTo } : {}) }
    messages.push(sent)
    for (const stream of streams) stream.write([sent])
    return sent.messageId
  },
})
rpc.register(136, { request: any, response: any, onrequest: ([roomId, options]) => messages.filter((message) => officialShape || message.roomId === roomId).slice(-(options?.limit ?? 50)) })
rpc.register(139, {
  request: any,
  response: any,
  dedup: true,
  onstream: async (stream) => {
    streams.add(stream)
    stream.once("close", () => streams.delete(stream))
    stream.write(messages)
    for await (const args of stream) {
      if (Array.isArray(args) && args[0] === "emit-human") {
        const sent = { roomId: groupId, messageId: { deviceId: "device-alice", seq: nextSeq++ }, senderId: "member-alice", senderName: "Alice", timestamp: Date.now(), type: "text", text: String(args[1] ?? "external") }
        messages.push(sent)
        for (const target of streams) target.write([sent])
      }
    }
  },
})
rpc.register(225, { request: any, response: any, onrequest: () => ({}) })

let incoming = Buffer.alloc(0)
ipc.on("data", (chunk) => {
  incoming = Buffer.concat([incoming, chunk])
  while (incoming.length >= 4) {
    const length = incoming.readUInt32LE(0)
    if (incoming.length < length + 4) break
    rpc.recv(incoming.subarray(4, length + 4))
    incoming = incoming.subarray(length + 4)
  }
})
ipc.on("end", () => process.exit(0))

// Deliberately noisy output verifies that Sidecar never forwards worker output
// or its data path to caller logs.
console.error(`fixture worker output for ${dataPath}`)
console.log(`Keet core worker started on ${dataPath}`)

// A test-owned terminal mode exercises the sidecar's post-ready connection
// failure path without touching any real runtime or identity state.
if (dataPath.includes("terminal-exit")) setTimeout(() => process.exit(23), 200)
