#!/usr/bin/env node

// Test-only fd-3 worker. It models only the small transport contract retained
// by the Core process suite; policy and normalization cases use an in-process
// mocked, unstarted KeetSidecar instead.
import net from "node:net"
import TinyBufferRPC from "tiny-buffer-rpc"
import any from "tiny-buffer-rpc/any.js"
import { writeFile } from "node:fs/promises"
import path from "node:path"

const dataPath = process.argv[2]
const ipc = new net.Socket({ fd: 3, readable: true, writable: true })
const groupId = "group-test"
const selfId = "identity-self"
const groups = [{ roomId: groupId, title: "Test group", description: "fixture" }]
const members = [
  { memberId: selfId, displayName: "Fixture Bot" },
  { memberId: "member-alice", displayName: "Alice" },
]
const messages = [
  { roomId: groupId, messageId: { deviceId: "device-alice", seq: 1 }, senderId: "member-alice", senderName: "Alice", timestamp: 1, type: "text", text: "initial context" },
  { roomId: groupId, messageId: { deviceId: "device-self", seq: 2 }, senderId: selfId, senderName: "Fixture Bot", timestamp: 2, type: "text", text: "initial self" },
  { roomId: groupId, messageId: { deviceId: "device-system", seq: 3 }, senderId: "system", timestamp: 3, type: "system", text: "ignored system" },
]
const streams = new Set()
let nextSeq = 10

const rpc = new TinyBufferRPC((message) => {
  const frame = Buffer.allocUnsafe(message.length + 4)
  frame.writeUInt32LE(message.length, 0)
  message.copy(frame, 4)
  ipc.write(frame)
})

rpc.register(0, { request: any, response: any, onrequest: () => true })
rpc.register(1, { request: any, response: any, onrequest: () => ({ modules: { "keet-core": "4.21.5" }, abi: { production: 35 } }) })
rpc.register(6, { request: any, response: any, onrequest: async () => {
  if (dataPath.includes("identity-stall")) {
    await writeFile(path.join(dataPath, "identity-read-started"), "ready")
    return new Promise(() => undefined)
  }
  return { memberId: selfId, displayName: "Fixture Bot" }
} })
rpc.register(39, { request: any, response: any, onrequest: ([room]) => room === groupId ? ({ roomId: groupId, title: "Test group", description: "fixture", roomType: "Default" }) : null })
rpc.register(43, { request: any, response: any, onrequest: () => ({ rooms: groups }) })
rpc.register(66, { request: any, response: any, onrequest: () => members })
rpc.register(104, {
  request: any,
  response: any,
  onrequest: ([roomId, text, options]) => {
    const human = typeof text === "string" && text.startsWith("[human] ")
    const sent = {
      roomId,
      messageId: { deviceId: human ? "device-alice" : "device-self", seq: nextSeq++ },
      senderId: human ? "member-alice" : selfId,
      senderName: human ? "Alice" : "Fixture Bot",
      timestamp: Date.now(),
      type: "text",
      text: human ? text.slice(8) : text,
      ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
    }
    messages.push(sent)
    for (const stream of streams) stream.write([sent])
    return sent.messageId
  },
})
rpc.register(136, { request: any, response: any, onrequest: ([roomId, options]) => messages.filter((message) => message.roomId === roomId).slice(-(options?.limit ?? 50)) })
rpc.register(139, {
  request: any,
  response: any,
  dedup: true,
  onstream: async (stream) => {
    streams.add(stream)
    stream.once("close", () => streams.delete(stream))
    stream.write(messages)
    for await (const args of stream) void args
  },
})
// Representative native reaction mutation used by the fd-3 process contract.
rpc.register(156, {
  request: any,
  response: any,
  onrequest: ([roomId, messageId, emoji]) => {
    if (roomId !== groupId || !messageId || typeof emoji !== "string") return { ok: false }
    return { key: Buffer.alloc(32), length: 1 }
  },
})
rpc.register(159, {
  request: any,
  response: any,
  onrequest: ([roomId, messageId]) => roomId === groupId && messageId
    ? { digest: { total: 0, reactions: [] }, mine: [] }
    : null,
})
rpc.register(171, {
  request: any,
  response: any,
  onrequest: ([roomId, bytes, metadata]) => ({
    metadata,
    pointer: { externalBlob: { id: `fixture-${roomId}`, blob: Buffer.from(bytes ?? []) } },
  }),
})
rpc.register(174, { request: any, response: any, onrequest: () => ({}) })
rpc.register(184, {
  request: any,
  response: any,
  dedup: true,
  onstream: (stream) => {
    let request
    stream.on("data", (args) => { request = args })
    stream.once("end", () => {
      const file = request?.[1]
      const blob = file?.pointer?.externalBlob?.blob
      const bytes = Buffer.isBuffer(blob) || blob instanceof Uint8Array ? Buffer.from(blob) : Buffer.alloc(0)
      if (bytes.length) stream.write(bytes)
      stream.end()
    })
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
