import type { Context } from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-commands"
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
  "commands",
  "attachments",
  "fs",
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
  commands: NonNullable<KeetBridgeDependencies["commands"]>
  attachments?: KeetBridgeDependencies["attachments"]
  workspaceFilesystem?: KeetBridgeDependencies["workspaceFilesystem"]
  filesystem?: KeetBridgeDependencies["filesystem"]
  fileSystem?: KeetBridgeDependencies["filesystem"]
  workspaceFs?: KeetBridgeDependencies["workspaceFs"]
  fs?: KeetBridgeDependencies["fs"]
}

export function apply(ctx: HostContext): void {
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, KeetSettingsSchema, { applies: "restart" })
  const attachments = capabilityOf<KeetBridgeDependencies["attachments"]>(ctx, "attachments")
  const workspaceFilesystem = capabilityOf<KeetBridgeDependencies["workspaceFilesystem"]>(ctx, "workspaceFilesystem")
  const filesystem = capabilityOf<KeetBridgeDependencies["filesystem"]>(ctx, "filesystem")
  const fileSystem = capabilityOf<KeetBridgeDependencies["filesystem"]>(ctx, "fileSystem")
  const workspaceFs = capabilityOf<KeetBridgeDependencies["workspaceFs"]>(ctx, "workspaceFs")
  const fs = capabilityOf<KeetBridgeDependencies["fs"]>(ctx, "fs")
  const bridgeDeps: KeetBridgeDependencies = {
    getSettings: () => settings.get(),
    workspaceRegistry: ctx.workspaceRegistry,
    resolveRuntimePaths: async (workspace) => await resolveKeetRuntimePaths(workspace.path),
    inspectSession: async (id) => await ctx.sessionController.inspect(id) as any,
    resolveAgent: async (id) => await ctx.sessionController.resolveAgent(id),
    coreFactory: async (options) => await KeetIntegrationCore.start(options),
    commands: ctx.commands,
    ...(attachments ? { attachments } : {}),
    ...(workspaceFilesystem ? { workspaceFilesystem } : {}),
    ...(filesystem ? { filesystem } : {}),
    ...(fileSystem ? { filesystem: fileSystem } : {}),
    ...(workspaceFs ? { workspaceFs } : {}),
    ...(fs ? { fs } : {}),
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
export type { KeetBridgeAgent, KeetBridgeDependencies, KeetBridgeReadiness, KeetBridgeReadinessState, KeetCommandService } from "./bridge.js"
export { createKeetToolDefinitions, normalizeManagedDestinationName, KEET_LIST_GROUPS, KEET_LIST_MEMBERS, KEET_READ_RECENT_MESSAGES, KEET_SEND_MESSAGE, KEET_SEND_IMAGE } from "./keet-tools.js"
export type { KeetToolDependencies, KeetListGroupsResult, KeetListMembersResult, KeetReadRecentMessagesResult, KeetSendMessageResult, KeetSendImageResult, KeetMemberResult, KeetGroupMessageResult, KeetDmMessageResult, ManagedDestination, ManagedDestinationSummary, ManagedDestinationKind, ActiveReactionTarget } from "./keet-tools.js"
export type { KeetAttachmentStore, KeetImageAttachmentRef, KeetSaveImageAttachment, KeetWorkspaceFileSystem, KeetImageAttachmentBlock } from "./image-contract.js"
export { KeetSettingsSchema } from "./settings.js"
export { ensureKeetIdentityDataDir, resolveKeetRuntimeDir, resolveKeetRuntimePaths } from "./local-paths.js"
export { decodeSettings, normalizeSettings, validateSettings } from "./settings-client.js"
export type { KeetSettings } from "./constants.js"
export { renderKeetContextPrompt, fitKeetReactionContext, classifyTrigger, normalizeKeetRecord, messageIdKey } from "./keet-protocol.js"
export type { KeetContextRecord, AdmittedKeetMessage, KeetIdentity, KeetRenderedMessageRecord, KeetDisplayMember, KeetReactionContext } from "./keet-protocol.js"
export { selectMostRecentEligibleSession, lastHumanPromptAt } from "./session-selection.js"
export type { SessionInspectionLike, SessionEventLike, SessionHeaderLike, WorkspaceLike, ActiveSessionCandidate } from "./session-selection.js"
export { prepareAvatar, validatePreparedAvatar, AVATAR_VARIANT_SIZES, AVATAR_MAX_SOURCE_BYTES, AVATAR_MAX_VARIANT_BYTES, AVATAR_MAX_PIXELS } from "./avatar.js"

export default { name, inject, apply }

function capabilityOf<T = unknown>(context: unknown, name: string): T | undefined {
  if (!context || (typeof context !== "object" && typeof context !== "function")) return undefined
  try { return (context as Record<string, unknown>)[name] as T | undefined } catch { return undefined }
}
