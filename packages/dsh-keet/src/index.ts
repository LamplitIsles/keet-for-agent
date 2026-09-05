import type { Context } from "@deepseek-ai/cordis"
import { KeetIntegrationCore } from "@lamplitisles/keet-integration-core"
import { KeetBridge, bridgeRpcHandler, type KeetBridgeAgent, type KeetBridgeDependencies } from "./bridge.js"
import { RPC_CHANNEL, SETTINGS_NAMESPACE } from "./constants.js"
import { KeetSettingsSchema } from "./settings.js"
import { resolveKeetRuntimePaths } from "./local-paths.js"

export const name = "dsh-keet"
export const inject = [
  "connection",
  "settings",
  "tools",
  "systemPrompt",
  "workspaceRegistry",
  "sessionController",
] as const

type HostContext = Context & {
  connection: { rpc: { handle: (channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) => () => Promise<void> } }
  settings: { register: (namespace: string, schema: unknown, options?: unknown) => { get(): unknown } }
  workspaceRegistry: KeetBridgeDependencies["workspaceRegistry"]
  sessionController: {
    inspect: (sessionId: string, signal?: AbortSignal) => Promise<unknown>
    resolveAgent: KeetBridgeDependencies["resolveAgent"]
  }
}

export function apply(ctx: HostContext): void {
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, KeetSettingsSchema, { applies: "restart" })
  const bridgeDeps: KeetBridgeDependencies = {
    getSettings: () => settings.get(),
    workspaceRegistry: ctx.workspaceRegistry,
    resolveRuntimePaths: async (workspace) => await resolveKeetRuntimePaths(workspace.path),
    inspectSession: async (id) => await ctx.sessionController.inspect(id) as any,
    resolveAgent: async (id) => await ctx.sessionController.resolveAgent(id),
    coreFactory: async (options) => await KeetIntegrationCore.start(options),
    onError: () => { if (process.env.NODE_ENV !== "test") console.error("[dsh-keet] bridge operation failed") },
  }
  const bridge = new KeetBridge(bridgeDeps)
  ctx.effect(() => {
    const disposeRpc = ctx.connection.rpc.handle(RPC_CHANNEL, bridgeRpcHandler(bridge))
    void bridge.start()
    return async () => { await disposeRpc(); await bridge.stop() }
  }, "dsh-keet: bridge lifecycle")
}

export { KeetBridge, bridgeRpcHandler }
export type { KeetBridgeAgent, KeetBridgeDependencies, KeetBridgeReadiness, KeetBridgeReadinessState } from "./bridge.js"
export { createKeetToolDefinitions, KEET_LIST_GROUPS, KEET_LIST_MEMBERS, KEET_READ_RECENT_MESSAGES, KEET_SEND_MESSAGE } from "./keet-tools.js"
export type { KeetToolDependencies, KeetListGroupsResult, KeetListMembersResult, KeetReadRecentMessagesResult, KeetSendMessageResult, ManagedDestination, ManagedDestinationKind } from "./keet-tools.js"
export { KeetSettingsSchema } from "./settings.js"
export { ensureKeetIdentityDataDir, resolveKeetRuntimeDir, resolveKeetRuntimePaths } from "./local-paths.js"
export { decodeSettings, normalizeSettings, validateSettings } from "./settings-client.js"
export type { KeetSettings } from "./constants.js"
export { renderKeetContextPrompt, classifyTrigger, normalizeKeetRecord, messageIdKey } from "./keet-protocol.js"
export type { KeetContextRecord, AdmittedKeetMessage, KeetIdentity } from "./keet-protocol.js"
export { selectMostRecentEligibleSession, lastHumanPromptAt } from "./session-selection.js"
export type { SessionInspectionLike, SessionEventLike, SessionHeaderLike, WorkspaceLike, ActiveSessionCandidate } from "./session-selection.js"
export { prepareAvatar, validatePreparedAvatar, AVATAR_VARIANT_SIZES, AVATAR_MAX_SOURCE_BYTES, AVATAR_MAX_VARIANT_BYTES, AVATAR_MAX_PIXELS } from "./avatar.js"

export default { name, inject, apply }
