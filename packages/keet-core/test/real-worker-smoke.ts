import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { KeetIntegrationCore } from "../src/index.js"

if (process.env.KEET_OFFICIAL_RUNTIME_SMOKE !== "1") {
  console.log("official runtime smoke skipped (set KEET_OFFICIAL_RUNTIME_SMOKE=1 to opt in)")
} else {
  const executablePath = required("KEET_EXECUTABLE_PATH")
  const bundlePath = required("KEET_BUNDLE_PATH")
  const dataPath = await mkdtemp(path.join(tmpdir(), "keet-official-smoke-"))
  let core: KeetIntegrationCore | undefined
  try {
    core = await KeetIntegrationCore.start({ executablePath, bundlePath, dataPath, swarming: false })
    const status = await core.status()
    const groups = await core.listGroups()
    let replyToRelationObserved = false
    if (core.createRoom) {
      const groupId = await core.createRoom({ title: "Keet for Agent replyTo relation smoke" })
      await core.sendMessage(groupId, "replyTo relation smoke source")
      const source = (await core.readRecentMessages(groupId, 50)).find((message) => message.text === "replyTo relation smoke source")
      if (!source) throw new Error("official worker did not return the smoke source message")
      await core.sendMessage(groupId, "replyTo relation smoke response", source.messageId)
      const history = await core.readRecentMessages(groupId, 50)
      replyToRelationObserved = history.some((message) => message.text === "replyTo relation smoke response" && message.replyTo?.deviceId === source.messageId.deviceId && message.replyTo.seq === source.messageId.seq)
      if (!replyToRelationObserved) throw new Error("official worker did not preserve the replyTo relation")
    }
    console.log(JSON.stringify({ ok: true, appVersion: status.appVersion, coreVersion: status.coreVersion, abi: status.abi, groupCount: groups.length, replyToRelationObserved }))
  } finally {
    await core?.close()
    await rm(dataPath, { recursive: true, force: true })
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required when official smoke is enabled`)
  return value
}
