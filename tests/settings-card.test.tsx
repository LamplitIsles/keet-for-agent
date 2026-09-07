import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { describe, expect, it } from "vitest"
import { KeetSettingsCard, type KeetSettingsCardProps, type WorkspaceSource } from "../packages/dsh-keet/src/client/settings-card.js"
import { KeetSettingsSchema } from "../packages/dsh-keet/src/settings.js"

const initial = { workspaceId: "workspace" }

function scopeFixture(options: { status?: "loading" | "ready"; writable?: boolean; value?: Record<string, unknown> } = {}) {
  let snapshot: any = { status: options.status ?? "ready", mode: "host", writable: options.writable ?? true, value: options.value ?? { ...initial }, revision: 1 }
  const listeners = new Set<() => void>()
  const calls: Array<{ field: string; value: unknown }> = []
  const mutations: unknown[] = []
  let reject = false
  const publishSnapshot = (value: Record<string, unknown>) => { snapshot = { ...snapshot, value }; listeners.forEach((listener) => listener()) }
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      set: async (field: string, value: unknown) => { calls.push({ field, value }); if (reject) throw new Error("rejected"); snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value } }; listeners.forEach((listener) => listener()) },
      mutate: async (ops: readonly { op: string; path: readonly unknown[]; value?: unknown }[]) => {
        mutations.push(ops)
        if (reject) throw new Error("rejected")
        const current = snapshot.value as Record<string, any>
        const next = { ...current }
        for (const op of ops) {
          const [field, workspaceId, groupId] = op.path.map(String)
          if (op.op !== "set" || field !== "memberJoinTriggers" || !workspaceId || !groupId) continue
          const triggers = current.memberJoinTriggers as Record<string, Record<string, boolean>> | undefined
          next.memberJoinTriggers = { ...triggers, [workspaceId]: { ...(triggers?.[workspaceId] ?? {}), [groupId]: op.value } }
        }
        publishSnapshot(next)
      },
      unset: async () => undefined,
    },
    calls,
    mutations,
    setReject: (value = true) => { reject = value },
    publish: publishSnapshot,
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
    expect(KeetSettingsSchema({ workspaceId: "workspace", groupId: "legacy-group", dmMemberId: "legacy-peer" } as never)).toEqual({ workspaceId: "workspace", memberJoinTriggers: {} })
    expect(KeetSettingsSchema({ groupId: "legacy-group" } as never)).toEqual({ workspaceId: "", memberJoinTriggers: {} })
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

  it("saves independent member-join toggles and reports a rejected preference write", async () => {
    const fixture = scopeFixture({ value: {
      workspaceId: "workspace",
      memberJoinTriggers: { workspace: { "group-alpha": true } },
    } })
    const readiness = {
      get: async () => ({ ok: true, value: {
        state: "ready",
        workspaceId: "workspace",
        memberJoinGroups: [
          { groupId: "group-alpha", groupName: "Alpha", enabled: true },
          { groupId: "group-beta", groupName: "Beta", enabled: false },
        ],
      } }),
    }
    const renderer = await openCard({ ...props(fixture), readiness })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    let toggles = renderer.root.findAllByProps({ "data-settings-field": "memberJoinTrigger" })
    expect(toggles).toHaveLength(2)
    expect(toggles[0]!.props.checked).toBe(true)
    expect(toggles[1]!.props.checked).toBe(false)

    await act(async () => { toggles[1]!.props.onChange({ target: { checked: true } }) })
    expect(fixture.mutations).toEqual([[{ op: "set", path: ["memberJoinTriggers", "workspace", "group-beta"], value: true }]])
    toggles = renderer.root.findAllByProps({ "data-settings-field": "memberJoinTrigger" })
    expect(toggles[1]!.props.checked).toBe(true)
    expect(renderer.root.findByProps({ "data-member-join-status": "success" })).toBeTruthy()

    fixture.setReject()
    await act(async () => { toggles[0]!.props.onChange({ target: { checked: false } }) })
    toggles = renderer.root.findAllByProps({ "data-settings-field": "memberJoinTrigger" })
    expect(toggles[0]!.props.checked).toBe(true)
    expect(renderer.root.findByProps({ "data-member-join-status": "failure" })).toBeTruthy()
    renderer.unmount()
  })

  it("loads pending requests on open, distinguishes duplicate names, and accepts the exact hidden selector", async () => {
    const fixture = scopeFixture()
    const calls: unknown[] = []
    let pending = [
      { memberId: "peer-a", displayName: "Same name", identityHint: "#aaaaaaaa" },
      { memberId: "peer-b", displayName: "Same name", identityHint: "#bbbbbbbb" },
    ]
    const readiness = {
      get: async () => ({ ok: true, value: { state: "unbound", workspaceId: "workspace" } }),
      onboarding: async (payload: unknown) => {
        calls.push(payload)
        const operation = (payload as { operation?: string }).operation
        if (operation === "list-pending-dm-requests") return { ok: true, value: { status: "ready", requests: pending } }
        if (operation === "accept-dm") pending = pending.filter((request) => request.memberId !== (payload as { memberId?: string }).memberId)
        return { ok: true, value: { status: "admitted", destination: { groupName: "Same name", kind: "dm" } } }
      },
    }
    const renderer = await openCard({ ...props(fixture), readiness })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(calls[0]).toEqual({ workspaceId: "workspace", operation: "list-pending-dm-requests" })
    expect(renderer.root.findAll((node) => typeof node.props["data-pending-request"] === "number")).toHaveLength(2)
    expect(JSON.stringify(renderer.toJSON())).not.toContain("peer-a")
    expect(JSON.stringify(renderer.toJSON())).toContain("#aaaaaaaa")
    const accept = renderer.root.findAllByProps({ "data-onboarding-action": "accept" })[1]!
    await act(async () => { accept.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(calls).toEqual([
      { workspaceId: "workspace", operation: "list-pending-dm-requests" },
      { workspaceId: "workspace", operation: "accept-dm", memberId: "peer-b" },
      { workspaceId: "workspace", operation: "list-pending-dm-requests" },
    ])
    expect(renderer.root.findAll((node) => typeof node.props["data-pending-request"] === "number")).toHaveLength(1)
    renderer.unmount()
  })

  it("keeps invitation input transient and retries admission without repeating a confirmed join", async () => {
    const fixture = scopeFixture()
    const calls: unknown[] = []
    const readiness = {
      get: async () => ({ ok: true, value: { state: "ready", workspaceId: "workspace" } }),
      onboarding: async (payload: unknown) => {
        calls.push(payload)
        return (payload as { operation?: string }).operation === "retry-admission"
          ? { ok: true, value: { status: "admitted", destination: { groupName: "Joined", kind: "broadcast" } } }
          : { ok: true, value: { status: "partial", operation: "join", retryToken: "admission-opaque" } }
      },
    }
    const renderer = await openCard({ ...props(fixture), readiness })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const input = renderer.root.findByProps({ "data-onboarding-field": "invitation" })
    await act(async () => { input.props.onChange({ target: { value: "  keet://chat/transient  " } }) })
    const join = renderer.root.findByProps({ "data-onboarding-action": "join" })
    await act(async () => { join.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(calls.at(-1)).toEqual({ workspaceId: "workspace", operation: "join", invitation: "keet://chat/transient" })
    expect(renderer.root.findByProps({ "data-onboarding-status": "partial" })).toBeTruthy()
    const retry = renderer.root.findByProps({ "data-onboarding-action": "retry" })
    await act(async () => { retry.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(calls).toEqual([
      { workspaceId: "workspace", operation: "list-pending-dm-requests" },
      { workspaceId: "workspace", operation: "join", invitation: "keet://chat/transient" },
      { workspaceId: "workspace", operation: "retry-admission", retryToken: "admission-opaque" },
    ])
    expect(input.props.value).toBe("")
    renderer.unmount()
  })
})
