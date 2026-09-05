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
    validateGroup: async () => ({ groupId, roomType: "Default" }),
    listMembers: async (id) => id === dmId ? [{ memberId: "bot", displayName: "Bot" }, { memberId: "member-peer", displayName: "Peer" }] : [{ memberId: "z", displayName: "Zed" }, { memberId: "a", displayName: "Alice" }],
    readRecentMessages: async (id) => [{ messageId: target, groupId: id, senderId: "a", senderLabel: "Alice", timestamp: 1, text: "hello", replyTo: { deviceId: "device-self", seq: 3 } }],
    watchMessages: () => ({ closed: false, close: async () => undefined }),
    sendMessage: async () => ({ deviceId: "device-b", seq: 9 }),
    inspectInvitation: async () => ({ isRoomInvitation: true }),
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
const definitions = (core: KeetCore = fakeCore(), ready = true) => createKeetToolDefinitions({ getCore: () => core, destinations, isReady: () => ready })
const definitionsFor = (configured: ManagedDestination[], core: KeetCore = fakeCore()) => createKeetToolDefinitions({ getCore: () => core, destinations: configured, isReady: () => true })

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
    await expect(tools[3]!.execute({ groupName: "Shared Name", groupId: "first", text: "must not send" }, exec())).rejects.toThrow("groupName")
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
})
