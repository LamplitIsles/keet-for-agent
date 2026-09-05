import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { describe, expect, it } from "vitest"
import { KeetSettingsCard, type KeetSettingsCardProps, type WorkspaceSource } from "../packages/dsh-keet/src/client/settings-card.js"

const initial = { groupId: "group", workspaceId: "workspace" }

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
  it("stays hidden while settings are loading and starts collapsed when ready", async () => {
    const loading = scopeFixture({ status: "loading" })
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<KeetSettingsCard {...props(loading)} />) })
    expect(renderer.toJSON()).toBeNull()
    renderer.unmount()
    const ready = scopeFixture()
    renderer = await openCard(props(ready))
    expect(field(renderer, "groupId").props.value).toBe("group")
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

  it("allows saving a workspace before onboarding returns a group ID", async () => {
    const fixture = scopeFixture()
    fixture.publish({ groupId: "", workspaceId: "" })
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
    await act(async () => { field(renderer, "groupId").props.onChange({ target: { value: " " } }) })
    expect(field(renderer, "groupId").props["aria-invalid"]).toBe(true)
    const save = renderer.root.findByProps({ children: "Save" })
    expect(save.props.disabled).toBe(true)
    fixture.publish({ ...initial, groupId: "external" })
    expect(field(renderer, "groupId").props.value).toBe(" ")
    const discard = renderer.root.findByProps({ children: "Discard" })
    await act(async () => { discard.props.onClick() })
    expect(field(renderer, "groupId").props.value).toBe("external")
    await act(async () => { field(renderer, "groupId").props.onChange({ target: { value: "saved" } }) })
    await act(async () => { renderer.root.findByProps({ children: "Save" }).props.onClick() })
    expect(fixture.calls.at(-1)).toEqual({ field: "groupId", value: "saved" })
    renderer.unmount()
  })

  it("edits and saves the optional Managed DM peer alongside the group", async () => {
    const fixture = scopeFixture()
    const renderer = await openCard(props(fixture))
    expect(field(renderer, "dmMemberId").props.value).toBe("")
    await act(async () => { field(renderer, "dmMemberId").props.onChange({ target: { value: "peer-member-id" } }) })
    await act(async () => { renderer.root.findByProps({ children: "Save" }).props.onClick() })
    expect(fixture.calls.at(-1)).toEqual({ field: "dmMemberId", value: "peer-member-id" })
    renderer.unmount()
  })

  it("keeps a rejected draft and never writes from a read-only scope", async () => {
    const fixture = scopeFixture()
    fixture.setReject()
    const renderer = await openCard(props(fixture))
    await act(async () => { field(renderer, "groupId").props.onChange({ target: { value: "new-group" } }) })
    await act(async () => { renderer.root.findByProps({ children: "Save" }).props.onClick() })
    expect(field(renderer, "groupId").props.value).toBe("new-group")
    expect(renderer.root.findAllByProps({ role: "status" }).some((node) => String(node.props.children).includes("rejected"))).toBe(true)
    renderer.unmount()

    const readOnly = scopeFixture({ writable: false })
    const readonlyRenderer = await openCard(props(readOnly))
    await act(async () => { field(readonlyRenderer, "groupId").props.onChange({ target: { value: "ignored" } }) })
    expect(field(readonlyRenderer, "groupId").props.value).toBe("group")
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
