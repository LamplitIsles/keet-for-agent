import { describe, expect, it } from "vitest"
import { lastHumanPromptAt, selectMostRecentEligibleSession } from "../packages/dsh-keet/src/session-selection.js"

describe("existing DSH conversation selection", () => {
  it("chooses the latest non-archived, non-subagent human prompt", () => {
    const workspace = { id: "w", path: "/workspace", sessionIds: ["older", "newer", "subagent", "archived"] }
    const inspections = new Map([
      ["older", { meta: { id: "older" }, events: [{ type: "user/message", time: 2, data: { source: { kind: "user" }, content: "old" } }] }],
      ["newer", { meta: { id: "newer" }, events: [{ type: "user/message", time: 4, data: { source: { kind: "user" }, content: [{ type: "text", text: "new" }] } }] }],
      ["subagent", { meta: { id: "subagent", origin: "subagent" }, events: [{ type: "user/message", time: 99, data: { source: { kind: "user" }, content: "no" } }] }],
      ["archived", { meta: { id: "archived" }, events: [{ type: "user/message", time: 100, data: { source: { kind: "user" }, content: "no" } }] }],
    ])
    expect(selectMostRecentEligibleSession(workspace, inspections, new Set(["archived"]))).toMatchObject({ sessionId: "newer", lastHumanPromptAt: 4 })
  })

  it("ignores blank and non-human events and stays unbound when none qualify", () => {
    expect(lastHumanPromptAt({ meta: { id: "s" }, events: [{ type: "user/message", time: 1, data: { source: { kind: "user" }, content: " " } }, { type: "assistant/message", time: 2, data: { source: { kind: "assistant" }, content: "answer" } }] })).toBeUndefined()
    expect(selectMostRecentEligibleSession({ id: "w", path: "/workspace", sessionIds: ["s"] }, new Map([["s", { meta: { id: "s" }, events: [] }]]) )).toBeUndefined()
  })
})
