import { describe, expect, it } from "vitest"
import { createKeetToolDefinitions, KEET_LIST_MEMBERS, KEET_READ_RECENT_MESSAGES, KEET_SEND_MESSAGE } from "../packages/dsh-keet/src/keet-tools.js"
import type { KeetCore, KeetMessageId } from "../packages/dsh-keet/src/core-contract.js"

const groupId = "group-fixed"
const target: KeetMessageId = { deviceId: "device-a", seq: 4 }

function fakeCore(overrides: Partial<KeetCore> = {}): KeetCore {
  return {
    status: async () => ({ state: "ready", appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: false, identityId: "bot" }),
    listGroups: async () => [{ groupId }],
    validateGroup: async () => ({ groupId }),
    listMembers: async () => [{ memberId: "z", displayName: "Zed" }, { memberId: "a", displayName: "Alice" }],
    readRecentMessages: async () => [{ messageId: target, groupId, senderId: "a", senderLabel: "Alice", timestamp: 1, text: "hello" }],
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

describe("fixed-group Keet tools", () => {
  it("registers exactly the three closed fixed-group tools", () => {
    const tools = createKeetToolDefinitions({ getCore: () => fakeCore(), groupId, isReady: () => true })
    expect(tools.map((tool) => tool.name)).toEqual([KEET_LIST_MEMBERS, KEET_READ_RECENT_MESSAGES, KEET_SEND_MESSAGE])
    expect(tools[0]!.parameters).toEqual({ type: "object", properties: {} })
    expect(JSON.stringify(tools)).not.toContain("roomId")
  })

  it("bounds and deterministically sorts the current roster", async () => {
    const definitions = createKeetToolDefinitions({ getCore: () => fakeCore(), groupId, isReady: () => true })
    const result = await definitions[0]!.execute({}, exec()) as { members: Array<{ memberId: string }> }
    expect(result.members.map((member) => member.memberId)).toEqual(["a", "z"])
    const rendered = definitions[0]!.output.render({}, result)
    expect(rendered[0]?.type).toBe("text")
    expect((rendered[0] as { type: "text"; text: string }).text).toContain("Alice (a)")
  })

  it("reads bounded chronological history and keeps the canonical reply shape", async () => {
    const calls: unknown[] = []
    const core = fakeCore({ readRecentMessages: async (_group, last) => { calls.push([_group, last]); return [{ messageId: target, groupId, senderId: "a\"<&", senderLabel: "Alice\r\n<&", timestamp: 1, text: "<hello> & goodbye", replyTo: { deviceId: "device-self", seq: 3 } }] } })
    const tool = createKeetToolDefinitions({ getCore: () => core, groupId, isReady: () => true })[1]!
    const result = await tool.execute({ last: 1 }, exec()) as { messages: Array<{ replyTo?: KeetMessageId }> }
    expect(calls).toEqual([[groupId, 1]])
    expect(result.messages[0]!.replyTo).toEqual({ deviceId: "device-self", seq: 3 })
    const rendered = (tool.output.render({}, result as never)[0] as { type: "text"; text: string }).text
    expect(rendered).toContain('message_id={"deviceId":"device-a","seq":4}')
    expect(rendered).not.toContain("\u0000")
    expect(rendered).toContain('sender_id="a&quot;&lt;&amp;" sender_label="Alice &lt;&amp;"')
    expect(rendered).toContain("&lt;hello&gt; &amp; goodbye")
    await expect(tool.execute({ last: 0 }, exec())).rejects.toThrow("1 to 50")
    await expect(tool.execute({ last: 51 }, exec())).rejects.toThrow("1 to 50")
  })

  it("sends only to the configured group and records the delivery ID", async () => {
    const calls: unknown[][] = []
    const core = fakeCore({ sendMessage: async (...args) => { calls.push(args as unknown[]); return { deviceId: "device-b", seq: 9 } } })
    const receipts: KeetMessageId[] = []
    const tool = createKeetToolDefinitions({ getCore: () => core, groupId, isReady: () => true, onMessageSent: (id) => { if (id) receipts.push(id!) } })[2]!
    const result = await tool.execute({ text: "hello", replyTo: target }, exec()) as { sent: true; messageId: KeetMessageId }
    expect(result).toEqual({ sent: true, messageId: { deviceId: "device-b", seq: 9 } })
    const rendered = (tool.output.render({}, result as never)[0] as { type: "text"; text: string }).text
    expect(rendered).toContain('({"deviceId":"device-b","seq":9})')
    expect(rendered).not.toContain("\u0000")
    expect(calls).toEqual([[groupId, "hello", target, expect.anything()]])
    expect(receipts).toEqual([{ deviceId: "device-b", seq: 9 }])
    await expect(tool.execute({ text: "   " }, exec())).rejects.toThrow("non-empty")
    await expect(tool.execute({ text: "bad", replyTo: { deviceId: "", seq: -1 } }, exec())).rejects.toThrow("canonical")
  })

  it("fails closed before readiness or cancellation without invoking Core", async () => {
    let invoked = 0
    const core = fakeCore({ sendMessage: async () => { invoked += 1; return undefined } })
    const tool = createKeetToolDefinitions({ getCore: () => core, groupId, isReady: () => false })[2]!
    await expect(tool.execute({ text: "nope" }, exec())).rejects.toThrow("not ready")
    expect(invoked).toBe(0)
    const controller = new AbortController()
    controller.abort()
    const cancelled = createKeetToolDefinitions({ getCore: () => core, groupId, isReady: () => true })[2]!
    await expect(cancelled.execute({ text: "nope" }, exec(controller.signal))).rejects.toThrow("cancelled")
    expect(invoked).toBe(0)
  })
})
