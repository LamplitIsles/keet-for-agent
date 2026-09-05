import { createElement, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import type { SettingsScope, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client"
import styles from "./keet.module.dshcss"
import { SETTINGS_NAMESPACE, type KeetSettings } from "../constants.js"
import { normalizeSettings, validateSettings } from "../settings-client.js"
import type { KeetBridgeReadiness, KeetBridgeReadinessState } from "../bridge.js"
import { keetLabels } from "./labels.js"

export type ClientSettingsScope = SettingsScope<Partial<KeetSettings>>
export interface ReadinessApi { get?: (signal?: AbortSignal) => Promise<unknown>; call?: () => Promise<unknown> }
export interface WorkspaceChoice { id?: string; workspaceId?: string; title?: string; path?: string }
export interface WorkspaceSource { getSnapshot?: () => { items?: readonly WorkspaceChoice[]; phase?: string }; subscribe?: (listener: () => void) => () => void }
export interface KeetSettingsCardProps { scope: ClientSettingsScope; readiness?: ReadinessApi; workspaces?: WorkspaceSource; workspaceSource?: WorkspaceSource; t?: (key: string) => string }

const EMPTY_READINESS: KeetBridgeReadiness = { state: "missing-settings" }
type WorkspaceSnapshotLike = { items?: readonly WorkspaceChoice[]; phase?: string }
const EMPTY_WORKSPACE_SNAPSHOT: WorkspaceSnapshotLike = { items: [], phase: "pending" }
const EMPTY_WORKSPACE_SUBSCRIBE = (_listener: () => void) => () => undefined
function valueOf(value: unknown): unknown { return value && typeof value === "object" && (value as { ok?: unknown }).ok === true ? (value as { value?: unknown }).value : value }
function readinessOf(value: unknown): KeetBridgeReadiness { const candidate = valueOf(value); const state = candidate && typeof candidate === "object" ? (candidate as { state?: unknown }).state : undefined; const allowed: readonly KeetBridgeReadinessState[] = ["disabled", "missing-settings", "connecting", "ready", "unbound", "failed"]; return { state: allowed.includes(state as KeetBridgeReadinessState) ? state as KeetBridgeReadinessState : "failed" } }
function snapshotValue(snapshot: SettingsScopeSnapshot<Partial<KeetSettings>>): KeetSettings { return normalizeSettings(snapshot.value) }
function textFor(t: ((key: string) => string) | undefined, key: string): string { return t?.(key) ?? keetLabels[key as keyof typeof keetLabels] ?? key }
function sameWorkspaceSnapshot(left: WorkspaceSnapshotLike, right: WorkspaceSnapshotLike): boolean {
  if (left.phase !== right.phase) return false
  const leftItems = left.items ?? []
  const rightItems = right.items ?? []
  if (leftItems.length !== rightItems.length) return false
  return leftItems.every((item, index) => {
    const other = rightItems[index]
    return String(item.workspaceId ?? item.id ?? "") === String(other?.workspaceId ?? other?.id ?? "")
      && (item.title ?? item.path ?? "") === (other?.title ?? other?.path ?? "")
  })
}

interface FrameProps { title: string; description: string; state: { available: boolean; writable: boolean; dirty: boolean; invalid: boolean; saving: boolean; failed: boolean }; onSave: () => void; onDiscard: () => void; children?: ReactNode; t: (key: string) => string }
function Frame(props: FrameProps) {
  const [open, setOpen] = useState(false)
  const saveStarted = useRef(false)
  const bodyId = `${SETTINGS_NAMESPACE}-settings-body`
  useEffect(() => {
    if (props.state.saving) {
      saveStarted.current = true
      return
    }
    if (saveStarted.current && !props.state.dirty && !props.state.failed) {
      saveStarted.current = false
      setOpen(false)
    }
  }, [props.state.saving, props.state.dirty, props.state.failed])
  if (!props.state.available) return null
  return createElement("li", { className: `${styles.card} ${open ? styles.cardOpen : ""}`, "data-plugin-card": SETTINGS_NAMESPACE }, createElement("button", { type: "button", className: styles.header, "aria-expanded": open, "aria-controls": bodyId, "aria-label": `${open ? "Collapse" : "Expand"}: ${props.title}`, "data-plugin-card-header": SETTINGS_NAMESPACE, onClick: () => setOpen((value) => !value) }, createElement("span", { className: styles.headText }, createElement("span", { className: styles.name }, props.title), createElement("span", { className: styles.description }, props.description)), props.state.dirty ? createElement("span", { className: styles.pending }, props.t("unsaved")) : null, createElement("span", { className: `${styles.chevron} ${open ? styles.chevronOpen : ""}`, "aria-hidden": true })), open ? createElement("div", { id: bodyId, className: styles.body }, !props.state.writable ? createElement("p", { className: styles.status, role: "status" }, props.t("readOnly")) : null, props.children, createElement("div", { className: styles.footer }, props.state.failed ? createElement("p", { className: `${styles.status} ${styles.invalid}`, role: "status" }, props.t("saveFailed")) : null, createElement("button", { type: "button", className: styles.discard, disabled: !props.state.dirty || props.state.saving, onClick: props.onDiscard }, props.t("discard")), createElement("button", { type: "button", className: styles.save, disabled: !props.state.dirty || props.state.invalid || props.state.saving || !props.state.writable, onClick: props.onSave }, props.state.saving ? props.t("saving") : props.t("save")))) : null)
}

export function KeetSettingsCard({ scope, readiness, workspaces, workspaceSource, t }: KeetSettingsCardProps) {
  const initial = scope.getSnapshot()
  const [snapshot, setSnapshot] = useState(initial)
  const [baseline, setBaseline] = useState(() => snapshotValue(initial))
  const [draft, setDraft] = useState<Partial<KeetSettings>>({})
  const [runtime, setRuntime] = useState<KeetBridgeReadiness>(EMPTY_READINESS)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const id = useId()
  useEffect(() => scope.subscribe(() => {
    const next = scope.getSnapshot()
    setSnapshot(next)
    // External refreshes advance the saved baseline while the local draft
    // remains authoritative for each edited field.
    setBaseline(snapshotValue(next))
  }), [scope])
  useEffect(() => { if (snapshot.status !== "ready" || !readiness) return; let active = true; const read = async () => { try { const value = readiness.get ? await readiness.get() : await readiness.call?.(); if (active) setRuntime(readinessOf(value)) } catch { if (active) setRuntime({ state: "failed" }) } }; void read(); const timer = setInterval(() => void read(), 5_000); return () => { active = false; clearInterval(timer) } }, [readiness, snapshot.status])
  const source = workspaceSource ?? workspaces
  const workspaceAdapter = useMemo(() => {
    let cached = EMPTY_WORKSPACE_SNAPSHOT
    const read = source?.getSnapshot?.bind(source)
    return {
      subscribe: source?.subscribe ? source.subscribe.bind(source) : EMPTY_WORKSPACE_SUBSCRIBE,
      getSnapshot: () => {
        const next = read?.() ?? EMPTY_WORKSPACE_SNAPSHOT
        if (sameWorkspaceSnapshot(cached, next)) return cached
        cached = next
        return cached
      },
    }
  }, [source])
  const workspaceSnapshot = useSyncExternalStore(workspaceAdapter.subscribe, workspaceAdapter.getSnapshot, workspaceAdapter.getSnapshot)
  const choices = useMemo(() => (workspaceSnapshot.items ?? []).map((item) => ({ id: String(item.workspaceId ?? item.id ?? ""), title: item.title ?? item.path ?? String(item.workspaceId ?? item.id ?? "") })).filter((item) => item.id), [workspaceSnapshot.items])
  const writable = snapshot.status === "ready" && snapshot.mode === "host" && snapshot.writable === true
  const dirty = Object.keys(draft).length > 0
  const effective = { ...baseline, ...draft }
  const validation = validateSettings(effective)
  const stale = Boolean(effective.workspaceId && workspaceSnapshot.phase === "ready" && !choices.some((choice) => choice.id === effective.workspaceId))
  const invalid = stale || Boolean(validation.issues.workspaceId)
  const text = (key: string) => textFor(t, key)
  const edit = <K extends keyof KeetSettings>(field: K, value: KeetSettings[K]) => { if (writable && !saving) { setFailed(false); setDraft((current) => ({ ...current, [field]: value })) } }
  const save = async () => {
    if (!writable || !dirty || invalid || saving) return
    const staged = { ...draft }
    setSaving(true)
    setFailed(false)
    try {
      if ("workspaceId" in staged) await scope.set("workspaceId", staged.workspaceId!)
      const next = scope.getSnapshot()
      setSnapshot(next)
      setBaseline(snapshotValue(next))
      setDraft({})
    } catch {
      setDraft(staged)
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const workspaceIssue = validation.issues.workspaceId
  const workspaceField = createElement("div", { className: styles.field },
    createElement("label", { className: styles.label, htmlFor: `${id}-workspaceId` }, text("workspaceId")),
    createElement("select", { id: `${id}-workspaceId`, className: `${styles.select} ${workspaceIssue ? styles.inputInvalid : ""}`, value: String(effective.workspaceId), disabled: !writable || saving, onChange: (event: { target: { value: string } }) => edit("workspaceId", event.target.value), "aria-invalid": workspaceIssue ? true : undefined, "aria-describedby": `${id}-workspaceId-hint`, "data-settings-field": "workspaceId" },
      createElement("option", { value: "" }, "—"),
      ...choices.map((choice) => createElement("option", { value: choice.id, key: choice.id }, choice.title)),
      stale ? createElement("option", { value: baseline.workspaceId }, baseline.workspaceId) : null,
    ),
    createElement("p", { className: `${styles.hint} ${stale || workspaceIssue ? styles.invalid : ""}`, id: `${id}-workspaceId-hint` }, stale ? text("workspaceMissing") : workspaceIssue === "required" ? text("required") : text("workspaceHint")),
  )
  const content = createElement("div", { className: styles.form, "data-settings-card": SETTINGS_NAMESPACE }, workspaceField, createElement("div", { className: styles.runtime, role: "status", "data-readiness": runtime.state }, createElement("strong", null, text("runtime")), createElement("span", { className: styles.runtimeState }, text(runtime.state))), createElement("p", { className: styles.hint }, text("restartHint")))
  return createElement(Frame, { title: text("title"), description: text("description"), t: text, state: { available: snapshot.status === "ready", writable, dirty, invalid, saving, failed }, onSave: () => void save(), onDiscard: () => { if (!saving) { setDraft({}); setFailed(false) } } }, content)
}
