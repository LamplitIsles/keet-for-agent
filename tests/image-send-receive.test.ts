import { describe, expect, it, vi } from "vitest"
import { PassThrough } from "node:stream"
import { mkdtemp, readFile, rm, stat as statPath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { KeetIntegrationCore, KeetSidecar, type KeetImageFile, type KeetMessage, type ManagedGroup, type PreparedKeetImage } from "../packages/keet-core/src/index.js"
import { KeetBridge, type KeetBridgeAgent, type KeetBridgeDependencies } from "../packages/dsh-keet/src/bridge.js"
import { createKeetToolDefinitions, KEET_SEND_IMAGE, type ManagedDestination } from "../packages/dsh-keet/src/keet-tools.js"
import type { KeetAttachmentStore, KeetImageAttachmentRef, KeetWorkspaceFileSystem } from "../packages/dsh-keet/src/image-contract.js"
import type { ToolDefinition } from "@deepseek-ai/dsh-tools"

// The repository's existing avatar tests exercise the real sharp binary in a
// Node subprocess. These tool tests mock only the tiny decode/preview surface
// so the Bun test process remains independent of optional native libraries.
vi.mock("sharp", () => {
  const pipeline = () => ({
    metadata: async () => ({ format: "png", width: 1, height: 1 }),
    clone() { return this },
    rotate() { return this },
    resize() { return this },
    png() { return this },
    toBuffer: async () => PNG_1X1,
  })
  return { default: () => pipeline() }
})

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
const serializeDestinationSend = async <T>(_groupId: string, operation: () => Promise<T>): Promise<T> => await operation()

function imageFile(name: string, bytes = PNG_1X1.byteLength): KeetImageFile {
  return {
    file: { metadata: { mimetype: "image/png", size: bytes, name }, pointer: { externalBlob: { key: name, blob: Buffer.from(name) } } },
    mediaType: "image/png",
    name,
    bytes,
    width: 1,
    height: 1,
  }
}

function imageMessage(groupId: string, seq: number, text: string, images: readonly KeetImageFile[], senderId = "peer"): KeetMessage {
  return { groupId, messageId: { deviceId: "device-peer", seq }, senderId, senderLabel: "Peer", timestamp: seq, text, images }
}

function makeImageCore(options: {
  groups?: ManagedGroup[]
  onWatch?: (handler: (message: KeetMessage) => void, groupId: string) => void
  readImage?: (image: KeetImageFile) => Promise<Uint8Array>
  sendMessage?: (groupId: string, text: string) => Promise<{ deviceId: string; seq: number }>
  sendImage?: (groupId: string, image: PreparedKeetImage) => Promise<void>
} = {}) {
  const groups = options.groups ?? [{ groupId: "dm-room", roomType: "DirectMessage", title: "Peer DM", dmMemberId: "peer" }]
  const sent: Array<{ groupId: string; text: string }> = []
  const core = {
    status: async () => ({ state: "ready" as const, appVersion: "4.21.0", coreVersion: "4.21.5", abi: 35, swarming: false, identityId: "bot", displayName: "Bot" }),
    listGroups: async () => groups,
    listMembers: async () => [],
    readRecentMessages: async (): Promise<KeetMessage[]> => [],
    watchMessages: (_groupId: string, handler: (message: KeetMessage) => void) => {
      options.onWatch?.(handler, _groupId)
      return { closed: false, close: async () => undefined }
    },
    setUnreadAnchor: async () => undefined,
    updateTypingIndicator: async () => undefined,
    sendMessage: async (groupId: string, text: string) => {
      sent.push({ groupId, text })
      return options.sendMessage ? options.sendMessage(groupId, text) : { deviceId: "device-bot", seq: sent.length }
    },
    addReaction: async () => undefined,
    readImage: async (_groupId: string, image: KeetImageFile) => options.readImage ? options.readImage(image) : PNG_1X1,
    sendImage: async (groupId: string, image: PreparedKeetImage) => { await options.sendImage?.(groupId, image) },
    resolveDm: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }),
    listPendingDmRequests: async () => [],
    acceptDmRequest: async () => ({ groupId: "dm-room", roomType: "DirectMessage" as const, dmMemberId: "peer" }),
    inspectInvitation: async () => ({ isRoomInvitation: true as const }),
    joinInvitation: async () => ({ groupId: "dm-room" }),
    updateDisplayName: async () => undefined,
    updateIdentityProfile: async () => undefined,
    close: async () => undefined,
  }
  return { core, sent }
}

function makeAgent(attachments?: KeetAttachmentStore, fs?: KeetWorkspaceFileSystem) {
  const prompts: unknown[] = []
  const tools: ToolDefinition[] = []
  const agent: KeetBridgeAgent = {
    id: "session" as never,
    followup: async (message) => { prompts.push(message) },
    whenIdle: async () => undefined,
    ctx: {
      attachments,
      fs,
      tools: { register: (definition: ToolDefinition) => { tools.push(definition); return () => undefined } },
      systemPrompt: { section: () => () => undefined },
    } as never,
  }
  return { agent, prompts, tools }
}

function targetFilesystem(root: string, onRead?: () => void): KeetWorkspaceFileSystem {
  return {
    resolve: async (value, options) => {
      const displayPath = path.resolve(options?.cwd ?? root, value)
      return { targetKey: `target:${displayPath}`, displayPath }
    },
    contains: (parent, child) => child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}${path.sep}`),
    stat: async (target) => {
      try {
        const info = await statPath(target.displayPath)
        return { type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other", size: info.size }
      } catch {
        return undefined
      }
    },
    readBytes: async (target, _signal, maxBytes) => {
      onRead?.()
      const bytes = new Uint8Array(await readFile(target.displayPath))
      if (bytes.byteLength > maxBytes) throw new Error("too large")
      return bytes
    },
  }
}

function bridgeDeps(core: any, agent: KeetBridgeAgent, extras: Partial<KeetBridgeDependencies> = {}): KeetBridgeDependencies {
  return {
    getSettings: () => ({ workspaceId: "workspace" }),
    workspaceRegistry: { get: () => ({ id: "workspace", path: "/workspace", sessionIds: ["session"] }) },
    resolveRuntimePaths: async () => ({ runtimeDir: "/runtime", identityDataDir: "/identity" }),
    inspectSession: async () => ({ meta: { id: "session" }, events: [{ type: "user/message", time: 1, data: { source: { kind: "user" }, content: "hello" } }] }),
    resolveAgent: async () => ({ agent }),
    core,
    ...extras,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 96; i += 1) await Promise.resolve()
}

describe("Keet native image transfer", () => {
  it("normalizes external file records, streams bytes, and uses only saveFileBlob/sendFile", async () => {
    const calls: Array<{ name: string; args: unknown[] }> = []
    const sidecar = new KeetSidecar({ executablePath: "/inert/bare", bundlePath: "/inert/bundle", dataPath: "/inert/data", platform: "linux", arch: "x64" })
    sidecar.call = (async (name, args) => {
      calls.push({ name, args })
      if (name === "getChatMessages") return [{ roomId: "room", messageId: { deviceId: "peer", seq: 1 }, senderId: "peer", senderName: "Peer", timestamp: 1, text: "caption", type: "image", files: [{ metadata: { mimetype: "image/png", name: "one" }, pointer: { externalBlob: { key: "opaque-key", blob: Buffer.alloc(32) } } }] }]
      if (name === "saveFileBlob") return { metadata: args[2], pointer: { externalBlob: { key: "saved", blob: Buffer.from("blob-id") } } }
      if (name === "sendFile") return undefined
      return {}
    }) as typeof sidecar.call
    sidecar.subscribe = ((name, args) => {
      calls.push({ name, args })
      const stream = new PassThrough({ objectMode: true })
      if (name === "readFileStream") queueMicrotask(() => { stream.write(PNG_1X1.subarray(0, 9)); stream.write(PNG_1X1.subarray(9)); stream.end() })
      return stream
    }) as typeof sidecar.subscribe
    const core = new KeetIntegrationCore(sidecar)
    const history = await core.readRecentMessages("room", 1)
    expect(history[0]?.images).toHaveLength(1)
    expect(history[0]?.images?.[0]?.bytes).toBeUndefined()
    const bytes = await core.readImage("room", history[0]!.images![0]!)
    expect(Buffer.from(bytes)).toEqual(PNG_1X1)
    await core.sendImage("room", { bytes: PNG_1X1, mediaType: "image/png", width: 1, height: 1 })
    expect(calls.map(({ name }) => name)).toEqual(["getChatMessages", "readFileStream", "saveFileBlob", "sendFile"])
    expect(calls.find(({ name }) => name === "sendFile")?.args[0]).toBe("room")
    expect(calls.map(({ name }) => name)).not.toContain("addFile")
    await core.close()
  })

  it("fails closed for empty text without images and for malformed image metadata", async () => {
    const sidecar = new KeetSidecar({ executablePath: "/inert/bare", bundlePath: "/inert/bundle", dataPath: "/inert/data", platform: "linux", arch: "x64" })
    sidecar.call = (async (name) => name === "getChatMessages" ? [
      { roomId: "room", messageId: { deviceId: "peer", seq: 1 }, senderId: "peer", text: "", type: "text" },
      { roomId: "room", messageId: { deviceId: "peer", seq: 2 }, senderId: "peer", text: "caption", type: "image", files: [{ metadata: { mimetype: "image/png", dimensions: { width: "bad", height: 1 } }, pointer: { externalBlob: {} } }] },
    ] : []) as typeof sidecar.call
    const core = new KeetIntegrationCore(sidecar)
    await expect(core.readRecentMessages("room", 50)).resolves.toEqual([])
    await core.close()
  })

  it("cancels a streaming read and destroys the stream", async () => {
    const sidecar = new KeetSidecar({ executablePath: "/inert/bare", bundlePath: "/inert/bundle", dataPath: "/inert/data", platform: "linux", arch: "x64" })
    let destroyed = false
    sidecar.subscribe = (() => {
      const stream = new PassThrough({ objectMode: true })
      const destroy = stream.destroy.bind(stream)
      stream.destroy = ((error?: Error) => { destroyed = true; return destroy(error) }) as typeof stream.destroy
      return stream
    }) as typeof sidecar.subscribe
    const core = new KeetIntegrationCore(sidecar)
    const controller = new AbortController()
    const pending = core.readImage("room", imageFile("pending"), controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow("cancelled")
    expect(destroyed).toBe(true)
    await core.close()
  })
})

describe("Keet DM image bridge", () => {
  it("admits all images atomically and submits one ordered durable image turn", async () => {
    let deliver!: (message: KeetMessage) => void
    const admitted: string[] = []
    const refs: KeetImageAttachmentRef[] = [
      { attachmentId: "a", mediaType: "image/png", bytes: PNG_1X1.byteLength, width: 1, height: 1 },
      { attachmentId: "b", mediaType: "image/png", bytes: PNG_1X1.byteLength, width: 1, height: 1 },
    ]
    const attachments: KeetAttachmentStore = { saveImages: async (inputs) => { admitted.push(...inputs.map((input) => input.name ?? "")); return refs } }
    const { core } = makeImageCore({ onWatch: (handler) => { deliver = handler } })
    const fixture = makeAgent(attachments)
    const bridge = new KeetBridge(bridgeDeps(core, fixture.agent))
    await bridge.start()
    deliver(imageMessage("dm-room", 1, "look", [imageFile("first"), imageFile("second")]))
    await flush()
    expect(admitted).toEqual(["first", "second"])
    expect(fixture.prompts).toHaveLength(1)
    const content = (fixture.prompts[0] as any).content as Array<{ type: string; text?: string; attachment?: KeetImageAttachmentRef }>
    expect(content.filter((block) => block.type === "image").map((block) => block.attachment?.attachmentId)).toEqual(["a", "b"])
    expect(content.find((block) => block.type === "text")?.text).toContain("look")
    await bridge.stop()
  })

  it("retains one failed image record until the next successful DM trigger", async () => {
    let deliver!: (message: KeetMessage) => void
    let reads = 0
    const { core, sent } = makeImageCore({ onWatch: (handler) => { deliver = handler }, readImage: async () => { reads += 1; if (reads === 1) throw new Error("bad image"); return PNG_1X1 } })
    const attachments: KeetAttachmentStore = { saveImages: async () => [{ attachmentId: "ok", mediaType: "image/png", bytes: PNG_1X1.byteLength, width: 1, height: 1 }] }
    const fixture = makeAgent(attachments)
    const bridge = new KeetBridge(bridgeDeps(core, fixture.agent))
    await bridge.start()
    deliver(imageMessage("dm-room", 1, "broken", [imageFile("broken")]))
    await flush()
    expect(fixture.prompts).toHaveLength(0)
    expect(sent).toEqual([{ groupId: "dm-room", text: "I couldn't receive that image. Please resend it." }])
    expect(bridge.contextBuffers.get("dm-room")?.[0]?.imageFailure).toBe(true)
    deliver(imageMessage("dm-room", 2, "next", [imageFile("next")]))
    await flush()
    expect(fixture.prompts).toHaveLength(1)
    expect((fixture.prompts[0] as any).content.find((part: any) => part.type === "text")?.text).toContain("Image could not be received")
    await bridge.stop()
  })

  it("does not read image bytes for a group image part", async () => {
    let deliver!: (message: KeetMessage) => void
    let reads = 0
    const { core } = makeImageCore({ groups: [{ groupId: "group", roomType: "Default", title: "Group" }], onWatch: (handler) => { deliver = handler }, readImage: async () => { reads += 1; return PNG_1X1 } })
    const fixture = makeAgent({ saveImages: async () => [] })
    const bridge = new KeetBridge(bridgeDeps(core, fixture.agent))
    await bridge.start()
    deliver(imageMessage("group", 1, "mention", [imageFile("group")]))
    await flush()
    expect(reads).toBe(0)
    await bridge.stop()
  })

  it("treats an image caption of /compact as an image turn, not the DM command", async () => {
    let deliver!: (message: KeetMessage) => void
    let commandCalls = 0
    const { core, sent } = makeImageCore({ onWatch: (handler) => { deliver = handler } })
    const attachments: KeetAttachmentStore = { saveImages: async () => [{ attachmentId: "compact-image", mediaType: "image/png", bytes: PNG_1X1.byteLength, width: 1, height: 1 }] }
    const fixture = makeAgent(attachments)
    fixture.agent.ctx = { ...fixture.agent.ctx, commands: { execute: async () => { commandCalls += 1; return { kind: "success", text: "not compact" } } } } as never
    const bridge = new KeetBridge(bridgeDeps(core, fixture.agent))
    await bridge.start()
    deliver(imageMessage("dm-room", 1, "/compact", [imageFile("compact")]))
    await flush()
    expect(fixture.prompts).toHaveLength(1)
    expect(commandCalls).toBe(0)
    expect(sent).toEqual([])
    await bridge.stop()
  })

  it("does not notify after image admission is cancelled by bridge shutdown", async () => {
    let deliver!: (message: KeetMessage) => void
    const { core, sent } = makeImageCore({ onWatch: (handler) => { deliver = handler }, readImage: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      return PNG_1X1
    } })
    const fixture = makeAgent({ saveImages: async () => [{ attachmentId: "cancelled", mediaType: "image/png", bytes: PNG_1X1.byteLength, width: 1, height: 1 }] })
    const bridge = new KeetBridge(bridgeDeps(core, fixture.agent))
    await bridge.start()
    deliver(imageMessage("dm-room", 1, "cancel", [imageFile("cancel")]))
    await bridge.stop()
    expect(sent).toEqual([])
    expect(fixture.prompts).toHaveLength(0)
  })
})

describe("keet_send_image", () => {
  it("reads inside the workspace, preserves source bytes, and sends one adjacent caption", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keet-image-tool-"))
    try {
      const source = path.join(root, "image.png")
      await writeFile(source, PNG_1X1)
      const sent: Array<{ kind: "image" | "text"; value: unknown }> = []
      const core = makeImageCore({ sendImage: async (_groupId, image) => { sent.push({ kind: "image", value: image }) }, sendMessage: async (_groupId, text) => { sent.push({ kind: "text", value: text }); return { deviceId: "bot", seq: 1 } } }).core
      const fs = targetFilesystem(root)
      const tools = createKeetToolDefinitions({ getCore: () => core, destinations: [{ groupId: "dm-room", kind: "dm", groupName: "Peer DM" }], isReady: () => true, workspaceRoot: root, fs, serializeDestinationSend, attachments: { validateImage: async () => undefined } })
      const tool = tools.find((definition) => definition.name === KEET_SEND_IMAGE)!
      await expect(tool.execute({ groupName: "Peer DM", path: "image.png", caption: "shown" }, { signal: new AbortController().signal } as never)).resolves.toEqual({ sent: true })
      expect(sent.map(({ kind }) => kind)).toEqual(["image", "text"])
      expect(Buffer.from((sent[0]!.value as PreparedKeetImage).bytes)).toEqual(PNG_1X1)
      await expect(tool.execute({ groupName: "Peer DM", path: "https://example.test/image.png" }, { signal: new AbortController().signal } as never)).rejects.toThrow("workspace-contained")
      await expect(tool.execute({ groupName: "Peer DM", path: "../outside.png" }, { signal: new AbortController().signal } as never)).rejects.toThrow("workspace")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("uses the bound opaque-target filesystem and its canonical containment check", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keet-image-target-fs-"))
    try {
      const source = path.join(root, "image.png")
      await writeFile(source, PNG_1X1)
      const resolveTarget = async (value: string, options?: { cwd?: string }) => {
        const displayPath = path.resolve(options?.cwd ?? root, value)
        return { targetKey: `target:${displayPath}`, displayPath }
      }
      const fs: KeetWorkspaceFileSystem = {
        resolve: resolveTarget,
        contains: (parent, child) => child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}${path.sep}`),
        stat: async (target) => ({ type: "file", size: target.displayPath === source ? PNG_1X1.byteLength : 0 }),
        readBytes: async (target) => new Uint8Array(await readFile(target.displayPath)),
      }
      const sent: PreparedKeetImage[] = []
      const core = makeImageCore({ sendImage: async (_groupId, image) => { sent.push(image) } }).core
      const tool = createKeetToolDefinitions({ getCore: () => core, destinations: [{ groupId: "dm-room", kind: "dm", groupName: "Peer DM" }], isReady: () => true, workspaceRoot: root, fs, serializeDestinationSend, attachments: {} }).find((definition) => definition.name === KEET_SEND_IMAGE)!
      await expect(tool.execute({ groupName: "Peer DM", path: "image.png" }, { signal: new AbortController().signal } as never)).resolves.toEqual({ sent: true })
      expect(sent).toHaveLength(1)
      expect(Buffer.from(sent[0]!.bytes)).toEqual(PNG_1X1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("serializes an image, caption, failure notice, and text send per DM", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keet-image-order-"))
    let releaseImage: (() => void) | undefined
    try {
      await writeFile(path.join(root, "image.png"), PNG_1X1)
      let deliver!: (message: KeetMessage) => void
      let imageStarted!: () => void
      let failedRead!: () => void
      const imageGate = new Promise<void>((resolve) => { releaseImage = resolve })
      const imageReady = new Promise<void>((resolve) => { imageStarted = resolve })
      const failureReady = new Promise<void>((resolve) => { failedRead = resolve })
      const events: string[] = []
      const { core } = makeImageCore({
        onWatch: (handler) => { deliver = handler },
        readImage: async () => { failedRead(); throw new Error("bad image") },
        sendImage: async () => { events.push("image"); imageStarted(); await imageGate },
        sendMessage: async (_groupId, text) => {
          events.push(text === "caption" ? "caption" : text === "I couldn't receive that image. Please resend it." ? "notice" : "text")
          return { deviceId: "bot", seq: events.length }
        },
      })
      const attachments: KeetAttachmentStore = { saveImages: async () => [] }
      const fs = targetFilesystem(root)
      const fixture = makeAgent(attachments, fs)
      const bridge = new KeetBridge(bridgeDeps(core, fixture.agent, {
        attachments,
        fs,
        workspaceRegistry: { get: () => ({ id: "workspace", path: root, sessionIds: ["session"] }) },
      }))
      await bridge.start()
      const imageTool = fixture.tools.find((tool) => tool.name === KEET_SEND_IMAGE)!
      const textTool = fixture.tools.find((tool) => tool.name === "keet_send_message")!
      const imageRun = imageTool.execute({ groupName: "Peer DM", path: "image.png", caption: "caption" }, { signal: new AbortController().signal } as never)
      await imageReady
      deliver(imageMessage("dm-room", 1, "failed", [imageFile("failed")]))
      await failureReady
      await flush()
      const textRun = textTool.execute({ groupName: "Peer DM", text: "text" }, { signal: new AbortController().signal } as never)
      await Promise.resolve()
      expect(events).toEqual(["image"])
      releaseImage!()
      await Promise.all([imageRun, textRun])
      await flush()
      expect(events).toEqual(["image", "caption", "notice", "text"])
      await bridge.stop()
    } finally {
      releaseImage?.()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports image delivery when the adjacent caption fails and never retries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keet-image-partial-"))
    try {
      await writeFile(path.join(root, "image.png"), PNG_1X1)
      let images = 0
      let captions = 0
      const core = makeImageCore({ sendImage: async () => { images += 1 }, sendMessage: async () => { captions += 1; throw new Error("caption failed") } }).core
      const fs = targetFilesystem(root)
      const tool = createKeetToolDefinitions({ getCore: () => core, destinations: [{ groupId: "dm-room", kind: "dm", groupName: "Peer DM" }], isReady: () => true, workspaceRoot: root, fs, serializeDestinationSend, attachments: {} }).find((definition) => definition.name === KEET_SEND_IMAGE)!
      await expect(tool.execute({ groupName: "Peer DM", path: "image.png", caption: "shown" }, { signal: new AbortController().signal } as never)).rejects.toThrow(/image was delivered/i)
      expect(images).toBe(1)
      expect(captions).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects groups and unknown destinations before filesystem access", async () => {
    let reads = 0
    const fs: KeetWorkspaceFileSystem = { resolve: async (value, options) => ({ targetKey: value, displayPath: path.resolve(options?.cwd ?? "/workspace", value) }), contains: () => true, stat: async () => ({ type: "file", size: PNG_1X1.byteLength }), readBytes: async () => { reads += 1; return PNG_1X1 } }
    const destinations: ManagedDestination[] = [{ groupId: "group", kind: "group", groupName: "Group" }]
    const tool = createKeetToolDefinitions({ getCore: () => makeImageCore().core, destinations, isReady: () => true, fs, workspaceRoot: "/workspace", serializeDestinationSend, attachments: {} }).find((definition) => definition.name === KEET_SEND_IMAGE)
    expect(tool).toBeDefined()
    await expect(tool!.execute({ groupName: "Group", path: "image.png" }, { signal: new AbortController().signal } as never)).rejects.toThrow("only for Managed DMs")
    expect(reads).toBe(0)
  })

  it("keeps recent reads text-only and never follows historical image pointers", async () => {
    let reads = 0
    const { core } = makeImageCore({ readImage: async () => { reads += 1; return PNG_1X1 } })
    core.readRecentMessages = async () => [imageMessage("dm-room", 1, "historical caption", [imageFile("old")])]
    const tool = createKeetToolDefinitions({ getCore: () => core, destinations: [{ groupId: "dm-room", kind: "dm", groupName: "Peer DM" }], isReady: () => true, serializeDestinationSend }).find((definition) => definition.name === "keet_read_recent_messages")!
    await expect(tool.execute({ groupName: "Peer DM", last: 10 }, { signal: new AbortController().signal } as never)).resolves.toMatchObject({ messages: [{ text: "historical caption" }] })
    expect(reads).toBe(0)
  })
})
