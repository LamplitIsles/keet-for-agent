#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { KeetIntegrationCore, type KeetCoreOptions, type KeetManagedDm } from "@lamplitisles/keet-integration-core"
import { ApprovalBridge, verifyDestination, type ApprovalCore } from "./bridge.js"
import { readConfig, runtimeOptions, type BotConfig } from "./config.js"
import { ImpriInbox, type ApprovalInbox } from "./impri.js"
import { BotStore } from "./state.js"

type SetupCore = ApprovalCore & Pick<KeetIntegrationCore, "updateDisplayName" | "setUsername" | "acceptDmRequest">

function terminalLabel(value: string | undefined): string {
  return value?.replace(/\p{Cc}/gu, " ").trim().slice(0, 128) || "Unnamed"
}

function openCore(options: KeetCoreOptions, signal: AbortSignal): Promise<KeetIntegrationCore> {
  return KeetIntegrationCore.start(options, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

/** Human-only onboarding; the running channel never accepts other DM requests. */
export async function setupBot(
  core: SetupCore, store: BotStore, config: BotConfig, username: string,
  ask: (prompt: string) => Promise<string>, tell: (text: string) => void, signal: AbortSignal,
): Promise<void> {
  const existing = store.snapshot()
  const identity = await core.status()
  if (existing) {
    await store.bind(config.baseUrl, identity.identityId, existing.dmId)
    await verifyDestination(core, existing, signal)
    tell("Private DM is already bound. You can start the approval channel.")
    return
  }
  await core.updateDisplayName("Impri", signal)
  const reservation = await core.setUsername(username, signal)
  if (reservation.status !== "searchable") throw new Error("Keet username is not searchable yet; run setup again")
  tell(`Search for ${username} in Keet and send Impri a private DM request.`)
  for (;;) {
    await ask("After sending the request, press Enter to refresh: ")
    signal.throwIfAborted()
    const pending = await core.listPendingDmRequests(signal)
    const joined = (await core.listGroups()).filter((room): room is KeetManagedDm =>
      room.roomType === "DirectMessage" && !!room.dmMemberId && !pending.some((request) => request.memberId === room.dmMemberId))
    const choices = [
      ...joined.map((room) => ({ label: `Existing DM: ${terminalLabel(room.title)}`, room })),
      ...pending.map((request) => ({ label: `Pending request: ${terminalLabel(request.displayName)}`, request })),
    ]
    if (!choices.length) { tell("No private DM requests yet. Press Enter to refresh again."); continue }
    choices.forEach((choice, index) => tell(`${index + 1}. ${choice.label}`))
    const answer = (await ask("Select your private DM by number (leave blank to refresh): ")).trim()
    if (!/^[1-9][0-9]*$/.test(answer)) continue
    const choice = choices[Number(answer) - 1]
    if (!choice) continue
    const room = "room" in choice ? choice.room : await core.acceptDmRequest(choice.request.memberId, signal)
    const binding = { baseUrl: config.baseUrl, identityId: identity.identityId, dmId: room.groupId, requests: {} }
    await verifyDestination(core, binding, signal)
    await store.bind(config.baseUrl, identity.identityId, room.groupId)
    tell("Private DM bound. Only this DM will be used; other DM requests will not be accepted automatically.")
    return
  }
}

export interface RunOptions {
  config: BotConfig
  store: BotStore
  inbox: ApprovalInbox
  signal: AbortSignal
  log: (message: string) => void
  startCore?: (options: KeetCoreOptions, signal: AbortSignal) => Promise<ApprovalCore>
  pause?: (signal: AbortSignal) => Promise<void>
}

/** The store lock spans reconnects. Each connection owns one worker and poll loop. */
export async function runBot(options: RunOptions): Promise<void> {
  const { config, store, inbox, signal, log } = options
  const binding = store.snapshot()
  if (!binding) throw new Error("Run Impri Keet setup first")
  if (binding.baseUrl !== config.baseUrl) throw new Error("Bot state belongs to a different Impri instance")
  const pause = options.pause ?? (async (stop: AbortSignal) => { await delay(500, undefined, { signal: stop }) })
  const retryPause = options.pause ?? (async (stop: AbortSignal) => { await delay(5_000, undefined, { signal: stop }) })
  const startCore = options.startCore ?? openCore
  while (!signal.aborted) {
    let core: ApprovalCore | undefined
    const stopCore = () => { void core?.close().catch(() => undefined) }
    try {
      core = await startCore(runtimeOptions(config), signal)
      signal.addEventListener("abort", stopCore, { once: true })
      if (signal.aborted) { stopCore(); break }
      const bridge = new ApprovalBridge(core, inbox, store, config.inboxUrl, () => log("An approval could not be processed; it remains recoverable."))
      log("Keet approval channel connected.")
      while (!signal.aborted) {
        // Closing the worker on a stalled round also releases native RPC calls
        // that cannot be interrupted by canceling their JavaScript waiter alone.
        const round = new AbortController()
        const timeout = setTimeout(() => round.abort(), 60_000)
        const roundSignal = AbortSignal.any([signal, round.signal])
        roundSignal.addEventListener("abort", stopCore, { once: true })
        let healthy: boolean
        try { healthy = await bridge.tick(roundSignal) }
        finally {
          clearTimeout(timeout)
          roundSignal.removeEventListener("abort", stopCore)
        }
        if (!healthy) break
        await pause(signal)
      }
    } catch {
      if (!signal.aborted) log("Approval channel interrupted; reconnecting with saved state.")
    } finally {
      signal.removeEventListener("abort", stopCore)
      await core?.close()
    }
    if (!signal.aborted) {
      try { await retryPause(signal) } catch { signal.throwIfAborted() }
    }
  }
}

const HELP = `Usage:
  impri-keet setup --config FILE --username NAME
  impri-keet run --config FILE

Setup reserves the dedicated bot username and lets you select one private DM.
Run polls Impri and sends approval requests with ✅ / ❌ reactions to that DM.
Config JSON: baseUrl, inboxUrl, apiKey, runtimeDir, dataDir.
Keep config private; use a dedicated dataDir and an Impri actions-scoped key.
`

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) {
    process.stdout.write(HELP)
    return 0
  }
  const [command, ...args] = argv
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!
    const value = args[index + 1]
    if (!["--config", "--username"].includes(key) || flags.has(key) || !value || value.startsWith("--")) throw new Error("Invalid command arguments")
    flags.set(key, value)
  }
  if (!["setup", "run"].includes(command!) || !flags.has("--config")
    || (command === "setup") !== flags.has("--username")) throw new Error("Invalid command arguments; use --help")
  const config = await readConfig(flags.get("--config")!)
  const store = await BotStore.open(config.dataDir)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    if (command === "run") {
      await runBot({ config, store, inbox: new ImpriInbox(config.baseUrl, config.apiKey), signal: controller.signal,
        log: (message) => process.stderr.write(`impri-keet: ${message}\n`) })
    } else {
      const core = await openCore(runtimeOptions(config), controller.signal)
      const close = () => { void core.close().catch(() => undefined) }
      controller.signal.addEventListener("abort", close, { once: true })
      const terminal = createInterface({ input: process.stdin, output: process.stdout })
      try {
        controller.signal.throwIfAborted()
        await setupBot(core, store, config, flags.get("--username")!,
          (prompt) => terminal.question(prompt, { signal: controller.signal }),
          (text) => process.stdout.write(text + "\n"), controller.signal)
      } finally {
        terminal.close()
        controller.signal.removeEventListener("abort", close)
        await core.close()
      }
    }
    return 0
  } catch (error) {
    if (controller.signal.aborted) return 0
    throw error
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    await store.close()
  }
}

function directExecution(): boolean {
  try { return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]) }
  catch { return false }
}

if (directExecution()) {
  try { process.exitCode = await main(process.argv.slice(2)) }
  catch {
    // Native/API errors can carry private URLs and identity material. Keep
    // terminal diagnostics bounded; never print config or raw response bodies.
    process.stderr.write("impri-keet: operation failed. Check arguments, private config, runtime, and data-directory ownership; use --help.\n")
    process.exitCode = 1
  }
}
