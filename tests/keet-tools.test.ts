import { describe, expect, it } from "vitest"
import { createKeetToolDefinitions, KEET_LIST_GROUPS, KEET_LIST_MEMBERS, KEET_READ_RECENT_MESSAGES, KEET_SEND_MESSAGE, type ManagedDestination } from "../packages/dsh-keet/src/keet-tools.js"
import type { KeetCore, KeetMessageId } from "../packages/dsh-keet/src/core-contract.js"

const groupId = "group-fixed"
const dmId = "group-dm"
const target: KeetMessageId = { deviceId: "device-a", seq: 4 }
const groupName = "Test group"
const dmName = "Managed DM"
const destinations: ManagedDestination[] = [
  { groupId, kind: "group", groupName },
  { groupId: dmId, kind: "dm", groupName: dmName, peerMemberId: "member-peer" },
]

function fakeCore(overrides: Partial<KeetCore> = {}): KeetCore {
  return {
    status: async () => ({ state: "ready", appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: false, identityId: "bot" }),
    listGroups: async () => [{ groupId, roomType: "Default" }, { groupId: dmId, roomType: "DirectMessage", dmMemberId: "member-peer" }],
    listMembers: async (id) => id === dmId ? [{ memberId: "bot", displayName: "Bot" }, { memberId: "member-peer", displayName: "Peer" }] : [{ memberId: "z", displayName: "Zed" }, { memberId: "a", displayName: "Alice" }],
    readRecentMessages: async (id) => [{ messageId: target, groupId: id, senderId: "a", senderLabel: "Alice", timestamp: 1, text: "hello", replyTo: { deviceId: "device-self", seq: 3 } }],
    readImage: async () => new Uint8Array([1]),
    sendImage: async () => undefined,
    watchMessages: () => ({ closed: false, close: async () => undefined }),
    setUnreadAnchor: async () => undefined,
    updateTypingIndicator: async () => undefined,
    addReaction: async () => undefined,
    sendMessage: async () => ({ deviceId: "device-b", seq: 9 }),
    inspectInvitation: async () => ({ isRoomInvitation: true }),
    leaveGroup: async () => undefined,
    joinInvitation: async () => ({ groupId }),
    resolveDm: async () => ({ groupId: dmId, roomType: "DirectMessage", dmMemberId: "member-peer" }),
    listPendingDmRequests: async () => [],
    acceptDmRequest: async () => ({ groupId: dmId, roomType: "DirectMessage", dmMemberId: "member-peer" }),
    updateIdentityProfile: async () => undefined,
    updateDisplayName: async () => undefined,
    close: async () => undefined,
    ...overrides,
  }
}

const exec = (signal = new AbortController().signal) => ({ signal }) as never
const serializeDestinationSend = async <T>(_groupId: string, operation: () => Promise<T>): Promise<T> => await operation()
const definitions = (core: KeetCore = fakeCore(), ready = true) => createKeetToolDefinitions({ getCore: () => core, getDestinations: () => destinations, isReady: () => ready, serializeDestinationSend })
const definitionsFor = (configured: ManagedDestination[], core: KeetCore = fakeCore()) => createKeetToolDefinitions({ getCore: () => core, getDestinations: () => configured, isReady: () => true, serializeDestinationSend })

describe("Managed Destination Keet tools", () => {
  it("registers the four closed tools and requires an explicit returned groupName", () => {
    const tools = definitions()
    expect(tools.map((tool) => tool.name)).toEqual([KEET_LIST_GROUPS, KEET_LIST_MEMBERS, KEET_READ_RECENT_MESSAGES, KEET_SEND_MESSAGE])
    expect(tools[0]!.parameters).toEqual({ type: "object", properties: {} })
    expect((tools[1]!.parameters as any).properties.groupName).toBeTruthy()
    expect(JSON.stringify(tools)).not.toContain("groupId")
    expect(JSON.stringify(tools)).not.toContain("roomId")
  })

  it("lists only the immutable configured destinations and omits peer identity metadata", async () => {
    const tool = definitions()[0]!
    const result = await tool.execute({}, exec()) as { groups: ManagedDestination[] }
    expect(result.groups).toEqual([
      { groupName, kind: "group" },
      { groupName: dmName, kind: "dm" },
    ])
    expect(JSON.stringify(result)).not.toContain("member-peer")
  })

  it("bounds and deterministically sorts the selected destination roster", async () => {
    const tool = definitions()[1]!
    const result = await tool.execute({ groupName }, exec()) as { members: Array<{ displayName: string }> }
    expect(result.members.map((member) => member.displayName)).toEqual(["Alice", "Zed"])
    const rendered = tool.output.render({ groupName }, result as never)
    expect(rendered[0]?.type).toBe("text")
    expect((rendered[0] as { type: "text"; text: string }).text).toContain("Alice")
    expect((rendered[0] as { type: "text"; text: string }).text).not.toContain("a")
  })

  it("rejects an unconfigured joined room before touching Core", async () => {
    let invoked = 0
    const core = fakeCore({ listMembers: async () => { invoked += 1; return [] } })
    await expect(definitions(core)[1]!.execute({ groupName: "joined-but-not-managed" }, exec())).rejects.toThrow("not an allowed")
    expect(invoked).toBe(0)
  })

  it("trims exact names and rejects normalized collisions before Core access", async () => {
    let invoked = 0
    const core = fakeCore({ sendMessage: async () => { invoked += 1; return target } })
    const tools = definitionsFor([
      { groupId: "first", kind: "group", groupName: "  Shared\nName  " },
      { groupId: "second", kind: "dm", groupName: "Shared Name" },
    ], core)
    const groups = await tools[0]!.execute({}, exec()) as { groups: Array<{ groupName: string; kind: string }> }
    expect(groups.groups).toEqual([{ groupName: "Shared Name", kind: "group" }, { groupName: "Shared Name", kind: "dm" }])
    await expect(tools[3]!.execute({ groupName: " Shared Name ", text: "must not send" }, exec())).rejects.toThrow("no message was sent")
    expect(invoked).toBe(0)
    await expect(tools[3]!.execute({ groupName: "shared name", text: "must not send" }, exec())).rejects.toThrow("not an allowed")
    expect(invoked).toBe(0)
  })

  it("preserves regular reply provenance while routing the requested group", async () => {
    const calls: unknown[][] = []
    const core = fakeCore({ readRecentMessages: async (_id, last) => { calls.push([_id, last]); return [{ messageId: target, groupId, senderId: "a\"<&", senderLabel: "Alice\r\n<&", timestamp: 1, text: "<hello> & goodbye", replyTo: { deviceId: "device-self", seq: 3 } }] }, sendMessage: async (...args) => { calls.push(args as unknown[]); return { deviceId: "device-b", seq: 9 } } })
    const tools = definitions(core)
    const read = tools[2]!
    const result = await read.execute({ groupName, last: 1 }, exec()) as { messages: Array<{ replyTo?: KeetMessageId; senderId?: string; groupId?: string }> }
    expect(calls[0]).toEqual([groupId, 1])
    expect(result.messages[0]!.replyTo).toEqual({ deviceId: "device-self", seq: 3 })
    expect(result.messages[0]).not.toHaveProperty("senderId")
    expect(result.messages[0]).not.toHaveProperty("groupId")
    const rendered = (read.output.render({ groupName }, result as never)[0] as { type: "text"; text: string }).text
    expect(rendered).toContain('message_id={"deviceId":"device-a","seq":4}')
    expect(rendered).toContain('reply_to={"deviceId":"device-self","seq":3}')
    expect(rendered).toContain("&lt;hello&gt; &amp; goodbye")
    const sent = await tools[3]!.execute({ groupName, text: "hello", replyTo: target }, exec()) as { sent: true; messageId?: KeetMessageId }
    expect(sent).toEqual({ sent: true })
    expect(sent).not.toHaveProperty("messageId")
    expect(calls.at(-1)).toEqual([groupId, "hello", target, expect.anything()])
    await expect(read.execute({ groupName, last: 0 }, exec())).rejects.toThrow("1 to 50")
  })

  it("resolves exact roster display names to native mentions without exposing member IDs", async () => {
    const calls: unknown[][] = []
    const core = fakeCore({ sendMessage: async (...args) => { calls.push(args as unknown[]); return target } })
    const send = definitions(core)[3]!
    await expect(send.execute({ groupName, text: "Welcome, Alice!", mentions: ["Alice", "Alice"] }, exec())).resolves.toEqual({ sent: true })
    expect(calls).toEqual([[groupId, "Welcome, Alice!", undefined, expect.anything(), ["a"]]])
    await expect(send.execute({ groupName, text: "no identity leak", mentions: ["Missing"] }, exec())).rejects.toThrow("current unique member")
    await expect(send.execute({ groupName: dmName, text: "no native DM mention", mentions: ["Peer"] }, exec())).rejects.toThrow("only for regular Managed Groups")
  })

  it("hides DM message IDs, routes ordinary sends, and rejects DM replies", async () => {
    const calls: unknown[][] = []
    const core = fakeCore({ readRecentMessages: async (...args) => { calls.push(args as unknown[]); return [{ messageId: target, groupId: dmId, senderId: "member-peer", senderLabel: "Peer", timestamp: 1, text: "private", replyTo: target }] }, sendMessage: async (...args) => { calls.push(args as unknown[]); return target } })
    const tools = definitions(core)
    const read = tools[2]!
    const result = await read.execute({ groupName: dmName, last: 1 }, exec()) as { messages: Array<Record<string, unknown>> }
    expect(result.messages[0]).toEqual({ senderLabel: "Peer", timestamp: 1, text: "private" })
    const rendered = (read.output.render({ groupName: dmName }, result as never)[0] as { type: "text"; text: string }).text
    expect(rendered).not.toContain("message_id")
    expect(rendered).not.toContain("device-a")
    await expect(tools[3]!.execute({ groupName: dmName, text: "private reply", replyTo: target }, exec())).rejects.toThrow("DM sends do not support replyTo")
    expect(calls).toHaveLength(1)
    expect(await tools[3]!.execute({ groupName: dmName, text: "private response" }, exec())).toEqual({ sent: true })
    expect(calls.at(-1)).toEqual([dmId, "private response", undefined, expect.anything()])

    const reactionCalls: unknown[][] = []
    const reactionCore = fakeCore({
      sendMessage: async (...args) => { reactionCalls.push(["text", ...args]); return target },
      addReaction: async (...args) => { reactionCalls.push(["reaction", ...args]) },
    })
    const reactionSend = createKeetToolDefinitions({ getCore: () => reactionCore, getDestinations: () => destinations, isReady: () => true, serializeDestinationSend, getActiveReactionTarget: () => ({ groupId: dmId, messageId: target }) })[3]!
    await expect(reactionSend.execute({ groupName: dmName, text: "private decorated", reaction: "💬" }, exec())).resolves.toEqual({ sent: true, reacted: true })
    expect(reactionCalls.map(([kind]) => kind)).toEqual(["text", "reaction"])
    expect(reactionCalls[0]).toEqual(["text", dmId, "private decorated", undefined, expect.anything()])
    expect(reactionCalls[1]).toEqual(["reaction", dmId, target, "💬", expect.anything()])
  })

  it("routes Managed Broadcast reads and plain-text sends while rejecting unsupported operations", async () => {
    const broadcastId = "group-broadcast"
    let memberReads = 0
    let sends = 0
    const core = fakeCore({
      listMembers: async () => { memberReads += 1; return [] },
      readRecentMessages: async (id) => [{ messageId: target, groupId: id, senderId: "moderator", senderLabel: "Moderator", timestamp: 1, text: "announcement", replyTo: { deviceId: "device-parent", seq: 2 } }],
      sendMessage: async (...args) => { sends += 1; return args[0] === broadcastId ? target : undefined },
    })
    const broadcast: ManagedDestination = { groupId: broadcastId, kind: "broadcast", groupName: "Announcements" }
    const tools = createKeetToolDefinitions({
      getCore: () => core,
      getDestinations: () => [broadcast],
      isReady: () => true,
      serializeDestinationSend,
      fs: {} as never,
    })
    await expect(tools[0]!.execute({}, exec())).resolves.toEqual({ groups: [{ groupName: "Announcements", kind: "broadcast" }] })
    await expect(tools[1]!.execute({ groupName: "Announcements" }, exec())).rejects.toThrow("rosters are unavailable")
    expect(memberReads).toBe(0)
    await expect(tools[2]!.execute({ groupName: "Announcements", last: 1 }, exec())).resolves.toEqual({ messages: [{ messageId: target, senderLabel: "Moderator", timestamp: 1, text: "announcement" }] })
    await expect(tools[3]!.execute({ groupName: "Announcements", text: "publish" }, exec())).resolves.toEqual({ sent: true })
    expect(sends).toBe(1)
    await expect(tools[3]!.execute({ groupName: "Announcements", text: "reply", replyTo: target }, exec())).rejects.toThrow("do not support replyTo")
    await expect(tools[3]!.execute({ groupName: "Announcements", text: "react", reaction: "📣" }, exec())).rejects.toThrow("do not support reactions")
    expect(sends).toBe(1)

    let rejectedSends = 0
    const rejectedCore = fakeCore({ sendMessage: async () => { rejectedSends += 1; throw new Error("MODERATORS_ONLY") } })
    const rejectedTools = createKeetToolDefinitions({ getCore: () => rejectedCore, getDestinations: () => [broadcast], isReady: () => true, serializeDestinationSend })
    await expect(rejectedTools[3]!.execute({ groupName: "Announcements", text: "must fail truthfully" }, exec())).rejects.toThrow("not sent")
    expect(rejectedSends).toBe(1)

    let undefinedSends = 0
    let undefinedReads = 0
    const undefinedCore = fakeCore({ sendMessage: async () => { undefinedSends += 1; return undefined }, readRecentMessages: async () => { undefinedReads += 1; return [] } })
    const undefinedTools = createKeetToolDefinitions({ getCore: () => undefinedCore, getDestinations: () => [broadcast], isReady: () => true, serializeDestinationSend })
    await expect(undefinedTools[3]!.execute({ groupName: "Announcements", text: "native append" }, exec())).resolves.toEqual({ sent: true })
    expect(undefinedSends).toBe(1)
    expect(undefinedReads).toBe(0)
  })

  it("does not turn missing display labels into model-visible identity IDs", async () => {
    const core = fakeCore({
      listMembers: async () => [{ memberId: "secret-member", displayName: "secret-member" }],
      readRecentMessages: async (id) => [{ messageId: target, groupId: id, senderId: "secret-sender", senderLabel: "secret-sender", timestamp: 1, text: "hello" }],
    })
    const tools = definitions(core)
    const members = await tools[1]!.execute({ groupName }, exec()) as { members: Array<{ displayName: string }> }
    expect(members).toEqual({ members: [{ displayName: "Unknown member" }] })
    const history = await tools[2]!.execute({ groupName, last: 1 }, exec()) as { messages: Array<Record<string, unknown>> }
    expect(history.messages[0]).toMatchObject({ senderLabel: "Unknown sender" })
    expect(JSON.stringify(history)).not.toContain("secret-sender")
  })

  it("fails closed before readiness or cancellation without invoking Core", async () => {
    let invoked = 0
    const core = fakeCore({ sendMessage: async () => { invoked += 1; return undefined } })
    const send = definitions(core, false)[3]!
    await expect(send.execute({ groupName, text: "nope" }, exec())).rejects.toThrow("not ready")
    expect(invoked).toBe(0)
    const controller = new AbortController(); controller.abort()
    await expect(definitions(core)[3]!.execute({ groupName, text: "nope" }, exec(controller.signal))).rejects.toThrow("cancelled")
    expect(invoked).toBe(0)
  })

  it("sends text before an optional reaction and keeps IDs out of the result", async () => {
    const calls: unknown[][] = []
    const core = fakeCore({
      sendMessage: async (...args) => { calls.push(["text", ...args]); return target },
      addReaction: async (...args) => { calls.push(["reaction", ...args]) },
    })
    const tools = createKeetToolDefinitions({ getCore: () => core, getDestinations: () => destinations, isReady: () => true, serializeDestinationSend, getActiveReactionTarget: () => ({ groupId, messageId: target }) })
    const send = tools.find((tool) => tool.name === KEET_SEND_MESSAGE)!
    expect(JSON.stringify(send.parameters)).not.toContain("messageId")
    await expect(send.execute({ groupName: ` ${groupName} `, text: "written reply", reaction: "👍🏽" }, exec())).resolves.toEqual({ sent: true, reacted: true })
    expect(calls.map(([kind]) => kind)).toEqual(["text", "reaction"])
    expect(calls[1]).toEqual(["reaction", groupId, target, "👍🏽", expect.anything()])
    const rendered = send.output.render({}, { sent: true, reacted: true } as never)
    expect((rendered[0] as { type: "text"; text: string }).text).not.toContain("device-a")
    expect((rendered[0] as { type: "text"; text: string }).text).toContain("reaction")
  })

  it("fails optional-reaction preconditions before sending text", async () => {
    let sent = 0
    let reacted = 0
    const core = fakeCore({ sendMessage: async () => { sent += 1; return target }, addReaction: async () => { reacted += 1 } })
    const sendUnavailable = createKeetToolDefinitions({ getCore: () => core, getDestinations: () => destinations, isReady: () => true, serializeDestinationSend, getActiveReactionTarget: () => undefined }).find((tool) => tool.name === KEET_SEND_MESSAGE)!
    await expect(sendUnavailable.execute({ groupName, text: "must not send", reaction: "👍" }, exec())).rejects.toThrow("unavailable outside")
    const sendDifferent = createKeetToolDefinitions({ getCore: () => core, getDestinations: () => destinations, isReady: () => true, serializeDestinationSend, getActiveReactionTarget: () => ({ groupId: "other", messageId: target }) }).find((tool) => tool.name === KEET_SEND_MESSAGE)!
    await expect(sendDifferent.execute({ groupName, text: "must not send", reaction: "👍" }, exec())).rejects.toThrow("different")
    const sendDuplicate = createKeetToolDefinitions({ getCore: () => core, getDestinations: () => [{ groupId: "first", kind: "group", groupName }, { groupId: "second", kind: "dm", groupName }], isReady: () => true, serializeDestinationSend, getActiveReactionTarget: () => ({ groupId: "first", messageId: target }) }).find((tool) => tool.name === KEET_SEND_MESSAGE)!
    await expect(sendDuplicate.execute({ groupName, text: "must not send", reaction: "👍" }, exec())).rejects.toThrow("no message was sent")
    await expect(sendUnavailable.execute({ groupName, text: "must not send", reaction: "not emoji" }, exec())).rejects.toThrow("exactly one Unicode emoji")
    const controller = new AbortController(); controller.abort()
    await expect(sendUnavailable.execute({ groupName, text: "must not send", reaction: "👍" }, exec(controller.signal))).rejects.toThrow("cancelled")
    expect(sent).toBe(0)
    expect(reacted).toBe(0)
  })

  it("returns truthful partial delivery when the optional reaction fails without retrying", async () => {
    const calls: string[] = []
    const core = fakeCore({
      sendMessage: async () => { calls.push("text"); return target },
      addReaction: async () => { calls.push("reaction"); throw new Error("provider rejected reaction") },
    })
    const tools = createKeetToolDefinitions({ getCore: () => core, getDestinations: () => destinations, isReady: () => true, serializeDestinationSend, getActiveReactionTarget: () => ({ groupId, messageId: target }) })
    const send = tools.find((tool) => tool.name === KEET_SEND_MESSAGE)!
    await expect(send.execute({ groupName, text: "text survives", reaction: "👍" }, exec())).resolves.toEqual({ sent: true, reacted: false })
    expect(calls).toEqual(["text", "reaction"])
    await expect(send.execute({ groupName, text: "text only" }, exec())).resolves.toEqual({ sent: true })
    expect(calls).toEqual(["text", "reaction", "text"])

    const failedCalls: string[] = []
    const failedCore = fakeCore({
      sendMessage: async () => { failedCalls.push("text"); throw new Error("provider text failure") },
      addReaction: async () => { failedCalls.push("reaction") },
    })
    const failedSend = createKeetToolDefinitions({ getCore: () => failedCore, getDestinations: () => destinations, isReady: () => true, serializeDestinationSend, getActiveReactionTarget: () => ({ groupId, messageId: target }) }).find((tool) => tool.name === KEET_SEND_MESSAGE)!
    await expect(failedSend.execute({ groupName, text: "text fails", reaction: "👍" }, exec())).rejects.toThrow("not sent")
    expect(failedCalls).toEqual(["text"])
  })

  it("treats Core send resolution as confirmation when readiness drops afterward", async () => {
    let ready = true
    let textSends = 0
    let resolveText!: (messageId: KeetMessageId) => void
    const textResult = new Promise<KeetMessageId>((resolve) => { resolveText = resolve })
    const textCore = fakeCore({ sendMessage: async () => { textSends += 1; return textResult } })
    const textSend = createKeetToolDefinitions({ getCore: () => textCore, getDestinations: () => destinations, isReady: () => ready, serializeDestinationSend })[3]!
    const textExecution = textSend.execute({ groupName, text: "confirmed text" }, exec())
    resolveText(target)
    ready = false
    await expect(textExecution).resolves.toEqual({ sent: true })
    expect(textSends).toBe(1)

    ready = true
    textSends = 0
    let reactionAttempts = 0
    let resolveReactionText!: (messageId: KeetMessageId) => void
    const reactionTextResult = new Promise<KeetMessageId>((resolve) => { resolveReactionText = resolve })
    const reactionCore = fakeCore({
      sendMessage: async () => { textSends += 1; return reactionTextResult },
      addReaction: async () => { reactionAttempts += 1 },
    })
    const reactionSend = createKeetToolDefinitions({ getCore: () => reactionCore, getDestinations: () => destinations, isReady: () => ready, serializeDestinationSend, getActiveReactionTarget: () => ({ groupId, messageId: target }) })[3]!
    const reactionExecution = reactionSend.execute({ groupName, text: "confirmed text with reaction", reaction: "👍" }, exec())
    resolveReactionText(target)
    ready = false
    await expect(reactionExecution).resolves.toEqual({ sent: true, reacted: false })
    expect(textSends).toBe(1)
    expect(reactionAttempts).toBe(0)
  })
})
