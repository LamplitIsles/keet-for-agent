import { describe, expect, it } from "vitest"
import { createKeetToolDefinitions, KEET_LIST_GROUPS, KEET_LIST_MEMBERS, KEET_READ_RECENT_MESSAGES, KEET_SEND_MESSAGE, type ManagedDestination } from "../packages/dsh-keet/src/keet-tools.js"
import type { KeetCore, KeetMessageId } from "../packages/dsh-keet/src/core-contract.js"

const groupId = "group-fixed"
const dmId = "group-dm"
const target: KeetMessageId = { deviceId: "device-a", seq: 4 }
const destinations: ManagedDestination[] = [
  { groupId, kind: "group", label: "Test group" },
  { groupId: dmId, kind: "dm", label: "Managed DM", peerMemberId: "member-peer" },
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
    updateDisplayName: async () => undefined,
    close: async () => undefined,
    ...overrides,
  }
}

const exec = (signal = new AbortController().signal) => ({ signal }) as never
const definitions = (core: KeetCore = fakeCore(), ready = true) => createKeetToolDefinitions({ getCore: () => core, destinations, isReady: () => ready })

describe("Managed Destination Keet tools", () => {
  it("registers the four closed tools and requires an explicit returned groupId", () => {
    const tools = definitions()
    expect(tools.map((tool) => tool.name)).toEqual([KEET_LIST_GROUPS, KEET_LIST_MEMBERS, KEET_READ_RECENT_MESSAGES, KEET_SEND_MESSAGE])
    expect(tools[0]!.parameters).toEqual({ type: "object", properties: {} })
    expect((tools[1]!.parameters as any).properties.groupId).toBeTruthy()
    expect(JSON.stringify(tools)).not.toContain("roomId")
  })

  it("lists only the immutable configured destinations and omits peer identity metadata", async () => {
    const tool = definitions()[0]!
    const result = await tool.execute({}, exec()) as { groups: ManagedDestination[] }
    expect(result.groups).toEqual([
      { groupId, kind: "group", label: "Test group" },
      { groupId: dmId, kind: "dm", label: "Managed DM" },
    ])
    expect(JSON.stringify(result)).not.toContain("member-peer")
  })

  it("bounds and deterministically sorts the selected destination roster", async () => {
    const tool = definitions()[1]!
    const result = await tool.execute({ groupId }, exec()) as { members: Array<{ memberId: string }> }
    expect(result.members.map((member) => member.memberId)).toEqual(["a", "z"])
    const rendered = tool.output.render({ groupId }, result as never)
    expect(rendered[0]?.type).toBe("text")
    expect((rendered[0] as { type: "text"; text: string }).text).toContain("Alice (a)")
  })

  it("rejects an unconfigured joined room before touching Core", async () => {
    let invoked = 0
    const core = fakeCore({ listMembers: async () => { invoked += 1; return [] } })
    await expect(definitions(core)[1]!.execute({ groupId: "joined-but-not-managed" }, exec())).rejects.toThrow("not an allowed")
    expect(invoked).toBe(0)
  })

  it("preserves regular reply provenance while routing the requested group", async () => {
    const calls: unknown[][] = []
    const core = fakeCore({ readRecentMessages: async (_id, last) => { calls.push([_id, last]); return [{ messageId: target, groupId, senderId: "a\"<&", senderLabel: "Alice\r\n<&", timestamp: 1, text: "<hello> & goodbye", replyTo: { deviceId: "device-self", seq: 3 } }] }, sendMessage: async (...args) => { calls.push(args as unknown[]); return { deviceId: "device-b", seq: 9 } } })
    const tools = definitions(core)
    const read = tools[2]!
    const result = await read.execute({ groupId, last: 1 }, exec()) as { messages: Array<{ replyTo?: KeetMessageId }> }
    expect(calls[0]).toEqual([groupId, 1])
    expect(result.messages[0]!.replyTo).toEqual({ deviceId: "device-self", seq: 3 })
    const rendered = (read.output.render({ groupId }, result as never)[0] as { type: "text"; text: string }).text
    expect(rendered).toContain('message_id={"deviceId":"device-a","seq":4}')
    expect(rendered).toContain("&lt;hello&gt; &amp; goodbye")
    const sent = await tools[3]!.execute({ groupId, text: "hello", replyTo: target }, exec()) as { sent: true; messageId: KeetMessageId }
    expect(sent).toEqual({ sent: true, messageId: { deviceId: "device-b", seq: 9 } })
    expect(calls.at(-1)).toEqual([groupId, "hello", target, expect.anything()])
    await expect(read.execute({ groupId, last: 0 }, exec())).rejects.toThrow("1 to 50")
  })

  it("hides DM message IDs, routes ordinary sends, and rejects DM replies", async () => {
    const calls: unknown[][] = []
    const core = fakeCore({ readRecentMessages: async (...args) => { calls.push(args as unknown[]); return [{ messageId: target, groupId: dmId, senderId: "member-peer", senderLabel: "Peer", timestamp: 1, text: "private", replyTo: target }] }, sendMessage: async (...args) => { calls.push(args as unknown[]); return target } })
    const tools = definitions(core)
    const read = tools[2]!
    const result = await read.execute({ groupId: dmId, last: 1 }, exec()) as { messages: Array<Record<string, unknown>> }
    expect(result.messages[0]).toEqual({ groupId: dmId, senderId: "member-peer", senderLabel: "Peer", timestamp: 1, text: "private" })
    const rendered = (read.output.render({ groupId: dmId }, result as never)[0] as { type: "text"; text: string }).text
    expect(rendered).not.toContain("message_id")
    expect(rendered).not.toContain("device-a")
    await expect(tools[3]!.execute({ groupId: dmId, text: "private reply", replyTo: target }, exec())).rejects.toThrow("DM sends do not support replyTo")
    expect(calls).toHaveLength(1)
    expect(await tools[3]!.execute({ groupId: dmId, text: "private response" }, exec())).toEqual({ sent: true })
    expect(calls.at(-1)).toEqual([dmId, "private response", undefined, expect.anything()])
  })

  it("fails closed before readiness or cancellation without invoking Core", async () => {
    let invoked = 0
    const core = fakeCore({ sendMessage: async () => { invoked += 1; return undefined } })
    const send = definitions(core, false)[3]!
    await expect(send.execute({ groupId, text: "nope" }, exec())).rejects.toThrow("not ready")
    expect(invoked).toBe(0)
    const controller = new AbortController(); controller.abort()
    await expect(definitions(core)[3]!.execute({ groupId, text: "nope" }, exec(controller.signal))).rejects.toThrow("cancelled")
    expect(invoked).toBe(0)
  })
})
