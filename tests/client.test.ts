import type { Context as ClientContext } from "@deepseek-ai/cordis"
import { describe, expect, it, vi } from "vitest"
import { apply, inject, KeetSettingsCard } from "../packages/dsh-keet/src/client.js"
import { SETTINGS_NAMESPACE } from "../packages/dsh-keet/src/constants.js"

describe("Keet client Loader entry", () => {
  it("declares supported settings/workspace services and registers the native card", () => {
    expect(inject).toEqual(expect.arrayContaining(["connection", "locale", "settingsScope", "slots", "workspaces"]))
    expect(inject).not.toContain("remote")
    const localeRegister = vi.fn(() => () => undefined)
    const scope = { getSnapshot: () => ({ status: "ready", mode: "host", writable: true, value: {} }), subscribe: () => () => undefined, set: vi.fn(), unset: vi.fn() }
    const bind = vi.fn(() => scope)
    const workspaceSource = { getSnapshot: () => ({ items: [], phase: "ready" }), subscribe: () => () => undefined }
    let registeredComponent: unknown
    let registeredOptions: any
    const slots = {
      inject: vi.fn((_slot: string, factory: () => unknown) => factory()),
      register: vi.fn((options: any, component: unknown) => { registeredOptions = options; registeredComponent = component; return () => undefined }),
    }
    const context = {
      effect: (factory: () => unknown) => factory(),
      locale: { register: localeRegister },
      settingsScope: { bind },
      connection: { rpc: { call: vi.fn() } },
      slots,
      workspaces: { list: workspaceSource },
    } as unknown as ClientContext
    apply(context as never)
    expect(localeRegister).toHaveBeenCalledWith(SETTINGS_NAMESPACE, expect.objectContaining({ en: expect.any(Object) }))
    expect(registeredComponent).toBe(KeetSettingsCard)
    expect(registeredOptions.locale).toBe(SETTINGS_NAMESPACE)
    expect((registeredOptions.inject as () => any)().workspaceSource).toBe(workspaceSource)
    expect((registeredOptions.inject as () => any)().scope).toBe(scope)
  })
})
