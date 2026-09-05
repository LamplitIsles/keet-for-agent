import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { describe, expect, it } from "vitest"
import { KeetSettingsCard, type KeetSettingsCardProps, type WorkspaceSource } from "../packages/dsh-keet/src/client/settings-card.js"
import { KeetSettingsSchema } from "../packages/dsh-keet/src/settings.js"

const initial = { workspaceId: "workspace" }

function scopeFixture(options: { status?: "loading" | "ready"; writable?: boolean } = {}) {
  let snapshot: any = { status: options.status ?? "ready", mode: "host", writable: options.writable ?? true, value: { ...initial }, revision: 1 }
  const listeners = new Set<() => void>()
  const calls: Array<{ field: string; value: unknown }> = []
  let reject = false
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      set: async (field: string, value: unknown) => { calls.push({ field, value }); if (reject) throw new Error("rejected"); snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value } }; listeners.forEach((listener) => listener()) },
      unset: async () => undefined,
    },
    calls,
    setReject: (value = true) => { reject = value },
    publish: (value: Record<string, unknown>) => { snapshot = { ...snapshot, value }; listeners.forEach((listener) => listener()) },
  }
}

function workspaceSource(): WorkspaceSource {
  return { getSnapshot: () => ({ phase: "ready", items: [{ workspaceId: "workspace", title: "Main" }, { workspaceId: "other", title: "Other" }] }), subscribe: () => () => undefined }
}

function props(fixture: ReturnType<typeof scopeFixture>): KeetSettingsCardProps {
  return { scope: fixture.scope as never, workspaceSource: workspaceSource(), readiness: { get: async () => ({ ok: true, value: { state: "ready" } }) } }
}

async function openCard(value: KeetSettingsCardProps): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(<KeetSettingsCard {...value} />) })
  const header = renderer.root.findByProps({ "aria-controls": "dsh-keet-settings-body" })
  await act(async () => { header.props.onClick() })
  return renderer
}

function field(renderer: ReactTestRenderer, name: string) { return renderer.root.findByProps({ "data-settings-field": name }) }

describe("native Keet settings card", () => {
  it("normalizes stored settings to the workspace-only schema", () => {
    expect(KeetSettingsSchema({ workspaceId: "workspace", groupId: "legacy-group", dmMemberId: "legacy-peer" } as never)).toEqual({ workspaceId: "workspace" })
    expect(KeetSettingsSchema({ groupId: "legacy-group" } as never)).toEqual({ workspaceId: "" })
  })

  it("stays hidden while settings are loading and starts collapsed when ready", async () => {
    const loading = scopeFixture({ status: "loading" })
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<KeetSettingsCard {...props(loading)} />) })
    expect(renderer.toJSON()).toBeNull()
    renderer.unmount()
    const ready = scopeFixture()
    renderer = await openCard(props(ready))
    expect(field(renderer, "workspaceId").props.value).toBe("workspace")
    renderer.unmount()
  })

  it("preserves the workspace source receiver", async () => {
    const fixture = scopeFixture()
    const source = {
      items: [{ workspaceId: "workspace", title: "Main" }],
      getSnapshot() { return { phase: "ready", items: this.items } },
      subscribe() { return () => undefined },
    }
    const renderer = await openCard({ ...props(fixture), workspaceSource: source })
    expect(field(renderer, "workspaceId").findAllByType("option").some((option) => option.props.children === "Main")).toBe(true)
    renderer.unmount()
  })

  it("allows saving a workspace before onboarding discovers any destination", async () => {
    const fixture = scopeFixture()
    fixture.publish({ workspaceId: "" })
    const renderer = await openCard(props(fixture))
    await act(async () => { field(renderer, "workspaceId").props.onChange({ target: { value: "workspace" } }) })
    expect(renderer.root.findByProps({ children: "Save" }).props.disabled).toBe(false)
    await act(async () => { renderer.root.findByProps({ children: "Save" }).props.onClick() })
    expect(fixture.calls).toEqual([{ field: "workspaceId", value: "workspace" }])
    renderer.unmount()
  })

  it("validates required values and supports conflict-safe discard/save", async () => {
    const fixture = scopeFixture()
    const renderer = await openCard(props(fixture))
    await act(async () => { field(renderer, "workspaceId").props.onChange({ target: { value: " " } }) })
    expect(field(renderer, "workspaceId").props["aria-invalid"]).toBe(true)
    const save = renderer.root.findByProps({ children: "Save" })
    expect(save.props.disabled).toBe(true)
    fixture.publish({ workspaceId: "external" })
    expect(field(renderer, "workspaceId").props.value).toBe(" ")
    const discard = renderer.root.findByProps({ children: "Discard" })
    await act(async () => { discard.props.onClick() })
    expect(field(renderer, "workspaceId").props.value).toBe("external")
    await act(async () => { field(renderer, "workspaceId").props.onChange({ target: { value: "other" } }) })
    await act(async () => { renderer.root.findByProps({ children: "Save" }).props.onClick() })
    expect(fixture.calls.at(-1)).toEqual({ field: "workspaceId", value: "other" })
    renderer.unmount()
  })

  it("exposes only the workspace field and ignores stored routing IDs", async () => {
    const fixture = scopeFixture()
    fixture.publish({ workspaceId: "workspace", groupId: "legacy-group", dmMemberId: "legacy-peer" })
    const renderer = await openCard(props(fixture))
    expect(renderer.root.findAllByProps({ "data-settings-field": "groupId" })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "data-settings-field": "dmMemberId" })).toHaveLength(0)
    renderer.unmount()
  })

  it("keeps a rejected draft and never writes from a read-only scope", async () => {
    const fixture = scopeFixture()
    fixture.setReject()
    const renderer = await openCard(props(fixture))
    await act(async () => { field(renderer, "workspaceId").props.onChange({ target: { value: "other" } }) })
    await act(async () => { renderer.root.findByProps({ children: "Save" }).props.onClick() })
    expect(field(renderer, "workspaceId").props.value).toBe("other")
    expect(renderer.root.findAllByProps({ role: "status" }).some((node) => String(node.props.children).includes("rejected"))).toBe(true)
    renderer.unmount()

    const readOnly = scopeFixture({ writable: false })
    const readonlyRenderer = await openCard(props(readOnly))
    await act(async () => { field(readonlyRenderer, "workspaceId").props.onChange({ target: { value: "ignored" } }) })
    expect(field(readonlyRenderer, "workspaceId").props.value).toBe("workspace")
    expect(readonlyRenderer.root.findByProps({ children: "Save" }).props.disabled).toBe(true)
    readonlyRenderer.unmount()
  })

  it.each(["disabled", "missing-settings", "connecting", "ready", "unbound", "failed"] as const)("renders bounded readiness state %s", async (state) => {
    const fixture = scopeFixture()
    const renderer = await openCard({ ...props(fixture), readiness: { get: async () => ({ ok: true, value: { state } }) } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(renderer.root.findByProps({ "data-readiness": state })).toBeTruthy()
    renderer.unmount()
  })
})
