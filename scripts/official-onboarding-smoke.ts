import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { KeetIntegrationCore } from "@lamplitisles/keet-integration-core"
import { prepareAvatar } from "../packages/dsh-keet/src/avatar.js"
import { KEET_IDENTITY_RELATIVE_PATH } from "../packages/dsh-keet/src/local-paths.js"

/**
 * Disposable official-runtime onboarding check. It is deliberately inert
 * unless the operator opts in; ordinary tests never need network access or
 * official assets.
 */
if (process.env.KEET_OFFICIAL_ONBOARDING_SMOKE !== "1") {
  console.log("official onboarding smoke skipped (set KEET_OFFICIAL_ONBOARDING_SMOKE=1 to opt in)")
} else {
  const executablePath = required("KEET_EXECUTABLE_PATH")
  const bundlePath = required("KEET_BUNDLE_PATH")
  const parent = await mkdtemp(path.join(tmpdir(), "keet-onboarding-smoke-"))
  const workspaceB = path.join(parent, "workspace-b")
  const identityAPath = path.join(parent, "identity-a")
  const identityB = path.join(workspaceB, KEET_IDENTITY_RELATIVE_PATH)
  const avatarPath = path.join(parent, "agent-avatar.png")
  let sidecarA: KeetIntegrationCore | undefined
  let sidecarB: KeetIntegrationCore | undefined
  try {
    if (path.dirname(bundlePath) !== path.dirname(executablePath)) throw new Error("official runtime files must share one directory")
    await mkdir(workspaceB, { recursive: true })
    await writeGeneratedAvatar(avatarPath)
    const coreA = await KeetIntegrationCore.start({ executablePath, bundlePath, dataPath: identityAPath, swarming: true })
    sidecarA = coreA
    if (!coreA.createRoom || !coreA.createInvitation) throw new Error("Core onboarding helpers are unavailable")
    const groupId = await coreA.createRoom({ title: "Keet for Agent broadcast onboarding smoke", roomType: "Broadcast" })
    await waitFor(async () => (await coreA.listGroups()).some((group) => group.groupId === groupId && group.roomType === "Broadcast"))
    const moderatorText = "broadcast moderator post"
    await coreA.sendMessage(groupId, moderatorText)
    await waitFor(async () => (await coreA.readRecentMessages(groupId, 50)).some((message) => message.text === moderatorText))
    // Explicitly omit moderator/admin capabilities so the joined identity can
    // observe the persisted post while the native worker rejects its append.
    const invitation = await coreA.createInvitation(groupId, { canModerate: false, canAdmin: false })
    const snapshotText = "onboarding snapshot admission"
    await coreA.sendMessage(groupId, snapshotText)
    await waitFor(async () => (await coreA.readRecentMessages(groupId, 50)).some((message) => message.text === snapshotText))

    const coreB = await KeetIntegrationCore.start({ executablePath, bundlePath, dataPath: identityB, swarming: true })
    sidecarB = coreB
    const joined = await coreB.joinInvitation(invitation.url)
    if (joined.groupId !== groupId) throw new Error("onboarding returned an unexpected room")
    const avatar = await prepareAvatar(avatarPath)
    await coreB.updateIdentityProfile({ displayName: "Keet Assistant", avatar })
    await waitFor(async () => {
      const groupsA = await coreA.listGroups()
      const groupsB = await coreB.listGroups()
      if (!groupsA.some((group) => group.groupId === groupId && group.roomType === "Broadcast") || !groupsB.some((group) => group.groupId === groupId && group.roomType === "Broadcast")) return false
      const membersA = await coreA.listMembers(groupId)
      const membersB = await coreB.listMembers(groupId)
      return membersA.some((member) => member.displayName === "Keet Assistant" && member.avatar?.present === true) && membersB.some((member) => member.displayName === "Keet Assistant" && member.avatar?.present === true)
    })

    const roomInfoB = await coreB.sidecar.call("getRoomInfo", [groupId]) as { self?: { member?: { status?: { isModerator?: unknown; isAdmin?: unknown } } } }
    const ownStatus = roomInfoB.self?.member?.status
    if (ownStatus?.isModerator !== false || ownStatus?.isAdmin !== false) throw new Error("onboarding identity unexpectedly received moderator/admin permission")
    let peerPostRejected = false
    try {
      await coreB.sendMessage(groupId, "broadcast peer post must fail")
    } catch {
      peerPostRejected = true
    }
    if (!peerPostRejected) peerPostRejected = !(await coreB.readRecentMessages(groupId, 50)).some((message) => message.text === "broadcast peer post must fail")
    if (!peerPostRejected) throw new Error("non-moderator Broadcast post unexpectedly succeeded")

    await waitFor(async () => (await coreB.readRecentMessages(groupId, 50)).some((message) => message.text === snapshotText))
    console.log(JSON.stringify({ ok: true, broadcastRoomObservedBy: 2, broadcastModeratorPostPersisted: true, broadcastPeerPostRejected: peerPostRejected, updatedLabelObservedBy: 2, avatarObservedBy: 2, agentToolAvatarData: "absent" }))
  } finally {
    await sidecarB?.close().catch(() => undefined)
    await sidecarA?.close().catch(() => undefined)
    await rm(parent, { recursive: true, force: true })
  }
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error("official sidecars did not converge before the timeout")
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required when official onboarding smoke is enabled`)
  return value
}

async function writeGeneratedAvatar(destination: string): Promise<void> {
  const width = 3
  const height = 2
  const scanlines = Buffer.alloc(height * (1 + width * 4))
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = row * (1 + width * 4) + 1 + column * 4
      scanlines[offset] = 44
      scanlines[offset + 1] = 116
      scanlines[offset + 2] = 190
      scanlines[offset + 3] = 217
    }
  }
  await writeFile(destination, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.from([0, 0, 0, width, 0, 0, 0, height, 8, 6, 0, 0, 0])),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]))
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii")
  const payload = Buffer.concat([typeBytes, data])
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(payload), 8 + data.length)
  return chunk
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
