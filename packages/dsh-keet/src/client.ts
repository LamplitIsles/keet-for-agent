import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client"
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client"
import type {} from "@deepseek-ai/dsh-api-workspace-controller/client"
import type {} from "@deepseek-ai/dsh-client-locale/client"
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client"
import type {} from "@deepseek-ai/dsh-client-ui-slots"
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client"
import { keetLocale } from "./client/labels.js"
import { KeetSettingsCard, type WorkspaceSource } from "./client/settings-card.js"
import { RPC_CHANNEL, RPC_ENDPOINT, RPC_ONBOARDING_ENDPOINT, SETTINGS_NAMESPACE, type KeetSettings } from "./constants.js"
import { decodeSettings } from "./settings-client.js"
import type { KeetLocaleKey } from "./client/labels.js"

export const inject = [
  "connection",
  "locale",
  "settingsScope",
  "slots",
  "workspaces",
] as const

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "dsh-keet": KeetLocaleKey
  }
}

interface ClientContextShape {
  locale: { register: (namespace: string, dictionaries: unknown) => () => void }
  settingsScope: { bind: <T>(spec: { namespace: string; decode?: (value: unknown) => T | undefined }) => SettingsScope<T> }
  connection: ConnectionHandle
  workspaces: { list: WorkspaceSource }
  slots: { inject: (slot: string, factory: () => unknown) => unknown; register: (options: unknown, component: unknown) => unknown }
  effect: (factory: () => unknown, label?: string) => unknown
}

function createReadinessApi(connection: Pick<ConnectionHandle, "rpc">) {
  return {
    async get(signal?: AbortSignal): Promise<unknown> {
      return connection.rpc.call(RPC_CHANNEL, RPC_ENDPOINT, {}, signal)
    },
    async onboarding(payload: unknown, signal?: AbortSignal): Promise<unknown> {
      return connection.rpc.call(RPC_CHANNEL, RPC_ONBOARDING_ENDPOINT, payload, signal)
    },
  }
}

export function apply(ctx: ClientContextShape): void {
  ctx.effect(() => ctx.locale.register(SETTINGS_NAMESPACE, keetLocale), "dsh-keet: dictionaries")
  const scope = ctx.settingsScope.bind<Partial<KeetSettings>>({ namespace: SETTINGS_NAMESPACE, decode: decodeSettings })
  const readiness = createReadinessApi(ctx.connection)
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register(
    {
      name: "settings.plugin.item",
      key: SETTINGS_NAMESPACE,
      priority: 0,
      inject: () => ({ scope, workspaceSource: ctx.workspaces.list, readiness }),
      locale: SETTINGS_NAMESPACE,
    },
    KeetSettingsCard,
  ))
}

export { KeetSettingsCard }
export type { KeetSettingsCardProps } from "./client/settings-card.js"
export default { inject, apply }
