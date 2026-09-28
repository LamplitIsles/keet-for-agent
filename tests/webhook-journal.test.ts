import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { KeetCore, KeetMessage, KeetSubscription } from "@lamplitisles/keet-integration-core"

const gate = vi.hoisted(() => ({ beforeRename: undefined as undefined | (() => Promise<void>), beforeSequenceRename: undefined as undefined | (() => Promise<void>) }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, rename: async (from: string, to: string) => {
    if (from.endsWith("webhook-events.ndjson.replacement") && to.endsWith("webhook-events.ndjson")) await gate.beforeRename?.()
    if (from.endsWith("webhook-sequence.replacement") && to.endsWith("webhook-sequence")) await gate.beforeSequenceRename?.()
    return await actual.rename(from, to)
  } }
})

import { WebhookEventFeed } from "../packages/keet-mcp/src/webhook-event-feed.js"

const destination = { groupId: "group", groupName: "Group", kind: "group" as const }
const message = (sequence: number): KeetMessage => ({ groupId: "group", messageId: { deviceId: "alice", seq: sequence }, senderId: "alice", senderLabel: "Alice", timestamp: sequence, text: `message ${sequence}` })
const feeds: WebhookEventFeed[] = []
afterEach(async () => { gate.beforeRename = undefined; gate.beforeSequenceRename = undefined; await Promise.all(feeds.splice(0).map(async (feed) => await feed.close())) })

describe("webhook journal", () => {
  it("keeps a concurrent append when acknowledging an earlier event", async () => {
    const root = await mkdtemp(join(tmpdir(), "keet-webhook-journal-"))
    const received: number[] = []
    let secondArrived!: () => void
    const second = new Promise<void>((resolve) => { secondArrived = resolve })
    let releaseSecond!: () => void
    const server = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk
      const event = JSON.parse(body) as { sequence: number }
      received.push(event.sequence)
      if (event.sequence === 2) { secondArrived(); await new Promise<void>((resolve) => { releaseSecond = resolve }) }
      response.writeHead(204).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()! as import("node:net").AddressInfo
    let watcher!: (value: KeetMessage) => void
    const core = { readRecentMessages: vi.fn(async () => []), watchMessages: vi.fn((_id: string, handler: (value: KeetMessage) => void) => { watcher = handler; return { closed: false, close: async () => undefined } as KeetSubscription }) } as unknown as KeetCore
    const feed = new WebhookEventFeed({ stateDir: root, url: new URL(`http://127.0.0.1:${address.port}/api/keet/events`), core, identityId: "bot", destinations: [destination], onFatal: (error) => { throw error } })
    feeds.push(feed)
    let enteredRename!: () => void
    const renaming = new Promise<void>((resolve) => { enteredRename = resolve })
    let releaseRename!: () => void
    gate.beforeRename = async () => { gate.beforeRename = undefined; enteredRename(); await new Promise<void>((resolve) => { releaseRename = resolve }) }
    try {
      await feed.start()
      watcher(message(1))
      await renaming
      watcher(message(2))
      await new Promise((resolve) => setTimeout(resolve, 50))
      releaseRename()
      await second
      const persisted = await readFile(join(root, "webhook-events.ndjson"), "utf8")
      expect(persisted).toContain('"sequence":2')
      expect(received).toEqual([1, 2])
    } finally { releaseSecond?.(); await feed.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
  })
  it("waits for an accepted observation to finish persisting during close", async () => {
    const root = await mkdtemp(join(tmpdir(), "keet-webhook-journal-"))
    let watcher!: (value: KeetMessage) => void
    const core = { readRecentMessages: vi.fn(async () => []), watchMessages: vi.fn((_id: string, handler: (value: KeetMessage) => void) => { watcher = handler; return { closed: false, close: async () => undefined } as KeetSubscription }) } as unknown as KeetCore
    const feed = new WebhookEventFeed({ stateDir: root, url: new URL("http://127.0.0.1:1/api/keet/events"), core, identityId: "bot", destinations: [destination], onFatal: (error) => { throw error } })
    feeds.push(feed)
    try {
      await feed.start()
      let entered!: () => void
      const renaming = new Promise<void>((resolve) => { entered = resolve })
      let release!: () => void
      gate.beforeSequenceRename = async () => { gate.beforeSequenceRename = undefined; entered(); await new Promise<void>((resolve) => { release = resolve }) }
      watcher(message(1))
      await renaming
      let closed = false
      const closing = feed.close().then(() => { closed = true })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(closed).toBe(false)
      release()
      await closing
      expect((await readFile(join(root, "webhook-events.ndjson"), "utf8"))).toContain('"sequence":1')
    } finally { await feed.close(); await rm(root, { recursive: true, force: true }) }
  })
})
