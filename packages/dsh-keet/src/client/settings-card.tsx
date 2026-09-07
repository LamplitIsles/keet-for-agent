import { createElement, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import type { SettingsScope, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client"
import styles from "./keet.module.dshcss"
import { SETTINGS_NAMESPACE, type KeetSettings } from "../constants.js"
import { normalizeSettings, validateSettings } from "../settings-client.js"
import { keetLabels } from "./labels.js"

export type ClientSettingsScope = SettingsScope<Partial<KeetSettings>>
export interface ReadinessApi {
  get?: (signal?: AbortSignal) => Promise<unknown>
  /** Human-only settings action transport; it never carries Agent data. */
  onboarding?: (payload: unknown, signal?: AbortSignal) => Promise<unknown>
  /** Raw endpoint seam used by deterministic client fixtures. */
  call?: (endpoint?: string, payload?: unknown, signal?: AbortSignal) => Promise<unknown>
}
export interface WorkspaceChoice { id?: string; workspaceId?: string; title?: string; path?: string }
export interface WorkspaceSource { getSnapshot?: () => { items?: readonly WorkspaceChoice[]; phase?: string }; subscribe?: (listener: () => void) => () => void }
export interface KeetSettingsCardProps { scope: ClientSettingsScope; readiness?: ReadinessApi; workspaces?: WorkspaceSource; workspaceSource?: WorkspaceSource; t?: (key: string) => string }

type ReadinessState = "disabled" | "missing-settings" | "connecting" | "ready" | "unbound" | "failed"
interface RuntimeReadiness { state: ReadinessState; workspaceId?: string; memberJoinGroups?: readonly MemberJoinGroup[] }
interface MemberJoinGroup { groupId: string; groupName: string; enabled: boolean }
interface PendingRequest { memberId: string; displayName: string; identityHint: string }
type ActionPhase = "idle" | "loading" | "success" | "failure" | "partial"
interface ActionStatus { phase: ActionPhase; retryToken?: string }
interface PendingState { phase: "idle" | "loading" | "ready" | "failure"; requests: readonly PendingRequest[] }

const EMPTY_READINESS: RuntimeReadiness = { state: "missing-settings" }
const EMPTY_PENDING: PendingState = { phase: "idle", requests: [] }
type WorkspaceSnapshotLike = { items?: readonly WorkspaceChoice[]; phase?: string }
const EMPTY_WORKSPACE_SNAPSHOT: WorkspaceSnapshotLike = { items: [], phase: "pending" }
const EMPTY_WORKSPACE_SUBSCRIBE = (_listener: () => void) => () => undefined

function valueOf(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  const envelope = value as { ok?: unknown; value?: unknown }
  return envelope.ok === true ? envelope.value : envelope.ok === false ? undefined : value
}

function readinessOf(value: unknown): RuntimeReadiness {
  const candidate = valueOf(value)
  const state = candidate && typeof candidate === "object" ? (candidate as { state?: unknown }).state : undefined
  const allowed: readonly ReadinessState[] = ["disabled", "missing-settings", "connecting", "ready", "unbound", "failed"]
  const rawGroups = candidate && typeof candidate === "object" ? (candidate as { memberJoinGroups?: unknown }).memberJoinGroups : undefined
  const memberJoinGroups = Array.isArray(rawGroups) ? rawGroups.flatMap((value): MemberJoinGroup[] => {
    if (!value || typeof value !== "object") return []
    const group = value as { groupId?: unknown; groupName?: unknown; enabled?: unknown }
    return typeof group.groupId === "string" && group.groupId.length > 0 && group.groupId.length <= 512
      && typeof group.groupName === "string" && group.groupName.length > 0 && group.groupName.length <= 512
      && typeof group.enabled === "boolean"
      ? [{ groupId: group.groupId, groupName: group.groupName, enabled: group.enabled }]
      : []
  }).slice(0, 128) : []
  return {
    state: allowed.includes(state as ReadinessState) ? state as ReadinessState : "failed",
    ...(candidate && typeof candidate === "object" && typeof (candidate as { workspaceId?: unknown }).workspaceId === "string" ? { workspaceId: (candidate as { workspaceId: string }).workspaceId } : {}),
    memberJoinGroups,
  }
}

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

function onboardingResult(value: unknown): { status?: unknown; requests?: unknown; retryToken?: unknown } | undefined {
  const result = valueOf(value)
  return result && typeof result === "object" ? result as { status?: unknown; requests?: unknown; retryToken?: unknown } : undefined
}

async function callOnboarding(api: ReadinessApi | undefined, payload: unknown, signal: AbortSignal): Promise<unknown> {
  if (api?.onboarding) return api.onboarding(payload, signal)
  if (api?.call) return api.call("onboarding", payload, signal)
  throw new Error("onboarding unavailable")
}

interface FrameProps {
  title: string
  description: string
  state: { available: boolean; writable: boolean; dirty: boolean; invalid: boolean; saving: boolean; failed: boolean }
  onSave: () => void
  onDiscard: () => void
  onOpen?: () => void
  children?: ReactNode
  t: (key: string) => string
}

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
  return createElement("li", { className: `${styles.card} ${open ? styles.cardOpen : ""}`, "data-plugin-card": SETTINGS_NAMESPACE }, createElement("button", {
    type: "button",
    className: styles.header,
    "aria-expanded": open,
    "aria-controls": bodyId,
    "aria-label": `${open ? "Collapse" : "Expand"}: ${props.title}`,
    "data-plugin-card-header": SETTINGS_NAMESPACE,
    onClick: () => setOpen((value) => {
      const next = !value
      if (next) props.onOpen?.()
      return next
    }),
  }, createElement("span", { className: styles.headText }, createElement("span", { className: styles.name }, props.title), createElement("span", { className: styles.description }, props.description)), props.state.dirty ? createElement("span", { className: styles.pending }, props.t("unsaved")) : null, createElement("span", { className: `${styles.chevron} ${open ? styles.chevronOpen : ""}`, "aria-hidden": true })), open ? createElement("div", { id: bodyId, className: styles.body }, !props.state.writable ? createElement("p", { className: styles.status, role: "status" }, props.t("readOnly")) : null, props.children, createElement("div", { className: styles.footer }, props.state.failed ? createElement("p", { className: `${styles.status} ${styles.invalid}`, role: "status" }, props.t("saveFailed")) : null, createElement("button", { type: "button", className: styles.discard, disabled: !props.state.dirty || props.state.saving, onClick: props.onDiscard }, props.t("discard")), createElement("button", { type: "button", className: styles.save, disabled: !props.state.dirty || props.state.invalid || props.state.saving || !props.state.writable, onClick: props.onSave }, props.state.saving ? props.t("saving") : props.t("save")))) : null)
}

export function KeetSettingsCard({ scope, readiness, workspaces, workspaceSource, t }: KeetSettingsCardProps) {
  const initial = scope.getSnapshot()
  const [snapshot, setSnapshot] = useState(initial)
  const [baseline, setBaseline] = useState(() => snapshotValue(initial))
  const [draft, setDraft] = useState<Partial<KeetSettings>>({})
  const [runtime, setRuntime] = useState<RuntimeReadiness>(EMPTY_READINESS)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [invitation, setInvitation] = useState("")
  const [joinStatus, setJoinStatus] = useState<ActionStatus>({ phase: "idle" })
  const [pending, setPending] = useState<PendingState>(EMPTY_PENDING)
  const [acceptStatuses, setAcceptStatuses] = useState<Record<string, ActionStatus>>({})
  const [memberJoinStatuses, setMemberJoinStatuses] = useState<Record<string, ActionPhase>>({})
  const [busy, setBusy] = useState<string | undefined>()
  const [sectionOpened, setSectionOpened] = useState(false)
  const id = useId()
  const actionController = useRef<AbortController | undefined>()
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false; actionController.current?.abort() }, [])
  useEffect(() => scope.subscribe(() => {
    const next = scope.getSnapshot()
    setSnapshot(next)
    // External refreshes advance the saved baseline while the local draft
    // remains authoritative for each edited field.
    setBaseline(snapshotValue(next))
  }), [scope])
  useEffect(() => {
    if (snapshot.status !== "ready" || !readiness) return
    let active = true
    const read = async () => {
      try {
        const value = readiness.get ? await readiness.get() : await readiness.call?.("readiness", {})
        if (active) setRuntime(readinessOf(value))
      } catch {
        if (active) setRuntime({ state: "failed" })
      }
    }
    void read()
    const timer = setInterval(() => void read(), 5_000)
    return () => { active = false; clearInterval(timer) }
  }, [readiness, snapshot.status])
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
  const savedWorkspaceId = baseline.workspaceId
  const runtimeWorkspaceMatches = Boolean(savedWorkspaceId) && runtime.workspaceId === savedWorkspaceId
  const workspaceRestartRequired = (dirty && "workspaceId" in draft) || (Boolean(savedWorkspaceId) && Boolean(runtime.workspaceId) && runtime.workspaceId !== savedWorkspaceId)
  const actionAllowed = writable && !dirty && !saving && !invalid && runtimeWorkspaceMatches && (runtime.state === "ready" || runtime.state === "unbound")
  const text = (key: string) => textFor(t, key)
  const edit = <K extends keyof KeetSettings>(field: K, value: KeetSettings[K]) => {
    if (writable && !saving) {
      setFailed(false)
      if (field === "workspaceId") {
        setJoinStatus({ phase: "idle" })
        setPending(EMPTY_PENDING)
        setAcceptStatuses({})
        setMemberJoinStatuses({})
      }
      setDraft((current) => ({ ...current, [field]: value }))
    }
  }

  const refreshReadiness = async (): Promise<void> => {
    if (!readiness?.get) return
    try {
      const value = await readiness.get()
      if (mounted.current) setRuntime(readinessOf(value))
    } catch {
      if (mounted.current) setRuntime({ state: "failed" })
    }
  }

  const refreshRequests = async (): Promise<void> => {
    if (busy?.startsWith("accept:") || busy?.startsWith("retry:")) return
    if (!actionAllowed) {
      setPending({ phase: "failure", requests: [] })
      return
    }
    setPending((current) => ({ ...current, phase: "loading" }))
    const controller = new AbortController()
    try {
      const result = onboardingResult(await callOnboarding(readiness, { workspaceId: savedWorkspaceId, operation: "list-pending-dm-requests" }, controller.signal))
      const requests = Array.isArray(result?.requests) ? result.requests.filter(isPendingRequest).slice(0, 32) : undefined
      if (!requests) throw new Error("invalid pending requests")
      if (mounted.current) setPending({ phase: "ready", requests })
    } catch {
      if (mounted.current) setPending({ phase: "failure", requests: [] })
    }
  }

  useEffect(() => {
    if (!sectionOpened || pending.phase !== "idle" || !actionAllowed) return
    void refreshRequests()
  }, [actionAllowed, pending.phase, sectionOpened])

  const runMutation = async (kind: "join" | "accept", memberId?: string, retryToken?: string): Promise<void> => {
    const actionKey = retryToken ? `retry:${retryToken}` : kind === "join" ? "join" : `accept:${memberId}`
    if (!actionAllowed || busy || (kind === "join" && !invitation.trim()) || (kind === "accept" && !memberId)) return
    const controller = new AbortController()
    actionController.current = controller
    setBusy(actionKey)
    if (kind === "join") setJoinStatus({ phase: "loading" })
    else setAcceptStatuses((current) => ({ ...current, [memberId!]: { phase: "loading" } }))
    try {
      const payload = retryToken
        ? { workspaceId: savedWorkspaceId, operation: "retry-admission", retryToken }
        : kind === "join"
          ? { workspaceId: savedWorkspaceId, operation: "join", invitation: invitation.trim() }
          : { workspaceId: savedWorkspaceId, operation: "accept-dm", memberId }
      const result = onboardingResult(await callOnboarding(readiness, payload, controller.signal))
      if (result?.status === "admitted") {
        if (kind === "join") {
          setJoinStatus({ phase: "success" })
          setInvitation("")
        } else {
          setAcceptStatuses((current) => ({ ...current, [memberId!]: { phase: "success" } }))
          setPending((current) => ({ ...current, requests: current.requests.filter((request) => request.memberId !== memberId) }))
        }
        await refreshReadiness()
        if (kind === "accept") await refreshRequests()
      } else if (result?.status === "partial" && typeof result.retryToken === "string" && result.retryToken.length <= 256) {
        if (kind === "join") setJoinStatus({ phase: "partial", retryToken: result.retryToken })
        else setAcceptStatuses((current) => ({ ...current, [memberId!]: { phase: "partial", retryToken: result.retryToken as string } }))
      } else {
        throw new Error("onboarding failed")
      }
    } catch {
      if (mounted.current) {
        if (kind === "join") setJoinStatus({ phase: "failure" })
        else setAcceptStatuses((current) => ({ ...current, [memberId!]: { phase: "failure" } }))
      }
    } finally {
      if (actionController.current === controller) actionController.current = undefined
      if (mounted.current) setBusy(undefined)
    }
  }

  const setMemberJoinTrigger = async (groupId: string, enabled: boolean): Promise<void> => {
    if (!actionAllowed || memberJoinStatuses[groupId] === "loading") return
    setMemberJoinStatuses((current) => ({ ...current, [groupId]: "loading" }))
    try {
      await scope.mutate([{ op: "set", path: ["memberJoinTriggers", savedWorkspaceId, groupId], value: enabled }])
      if (mounted.current) setMemberJoinStatuses((current) => ({ ...current, [groupId]: "success" }))
    } catch {
      if (mounted.current) setMemberJoinStatuses((current) => ({ ...current, [groupId]: "failure" }))
    }
  }

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
  const workspaceRestartHintId = `${id}-workspace-restart-hint`
  const workspaceField = createElement("div", { className: styles.field },
    createElement("label", { className: styles.label, htmlFor: `${id}-workspaceId` }, text("workspaceId")),
    createElement("select", { id: `${id}-workspaceId`, className: `${styles.select} ${workspaceIssue ? styles.inputInvalid : ""}`, value: String(effective.workspaceId), disabled: !writable || saving, onChange: (event: { target: { value: string } }) => edit("workspaceId", event.target.value), "aria-invalid": workspaceIssue ? true : undefined, "aria-describedby": `${id}-workspaceId-hint${workspaceRestartRequired ? ` ${workspaceRestartHintId}` : ""}`, "data-settings-field": "workspaceId" },
      createElement("option", { value: "" }, "—"),
      ...choices.map((choice) => createElement("option", { value: choice.id, key: choice.id }, choice.title)),
      stale ? createElement("option", { value: baseline.workspaceId }, baseline.workspaceId) : null,
    ),
    createElement("p", { className: `${styles.hint} ${stale || workspaceIssue ? styles.invalid : ""}`, id: `${id}-workspaceId-hint` }, stale ? text("workspaceMissing") : workspaceIssue === "required" ? text("required") : text("workspaceHint")),
    workspaceRestartRequired ? createElement("p", { className: styles.hint, id: workspaceRestartHintId, role: "status" }, text("restartHint")) : null,
  )

  const memberJoinGroups = runtime.memberJoinGroups ?? []
  const memberJoinControls = memberJoinGroups.length
    ? createElement("div", { className: styles.memberJoinSettings, "data-member-join-settings": true },
      createElement("p", { className: styles.hint }, text("memberJoinTriggerHint")),
      ...memberJoinGroups.map((group, index) => {
        const status = memberJoinStatuses[group.groupId]
        const enabled = baseline.memberJoinTriggers[savedWorkspaceId]?.[group.groupId] === true
        const statusText = status === "loading" ? text("memberJoinTriggerSaving") : status === "success" ? text("memberJoinTriggerSaved") : status === "failure" ? text("memberJoinTriggerSaveFailed") : ""
        return createElement("label", { className: styles.toggle, key: group.groupId, "data-member-join-group": index },
          createElement("input", {
            type: "checkbox",
            className: `${styles.checkbox} toggle`,
            checked: enabled,
            disabled: !actionAllowed || status === "loading",
            onChange: (event: { target: { checked: boolean } }) => void setMemberJoinTrigger(group.groupId, event.target.checked),
            "aria-label": `${text("memberJoinTrigger")}: ${group.groupName}`,
            "data-settings-field": "memberJoinTrigger",
          }),
          createElement("span", { className: styles.triggerName }, group.groupName),
          statusText ? createElement("span", { className: `${styles.triggerStatus} ${status === "failure" ? styles.invalid : ""}`, role: "status", "data-member-join-status": status }, statusText) : null,
        )
      }),
    )
    : null

  const joinFeedback = joinStatus.phase === "success"
    ? createElement("p", { className: styles.status, role: "status", "data-onboarding-status": "success" }, text("joinSuccess"))
    : joinStatus.phase === "failure"
      ? createElement("p", { className: `${styles.status} ${styles.invalid}`, role: "status", "data-onboarding-status": "failure" }, text("onboardingFailed"))
      : joinStatus.phase === "partial" && joinStatus.retryToken
        ? createElement("div", { className: styles.actionStatus, "data-onboarding-status": "partial" }, createElement("p", { className: `${styles.status} ${styles.invalid}`, role: "status" }, text("onboardingPartial")), createElement("button", { type: "button", className: styles.secondaryAction, disabled: !actionAllowed || busy !== undefined, onClick: () => void runMutation("join", undefined, joinStatus.retryToken), "data-onboarding-action": "retry" }, text("retryAdmission")))
        : null

  const onboarding = createElement("div", { className: styles.onboarding, "data-onboarding": SETTINGS_NAMESPACE },
    createElement("p", { className: styles.hint }, text("newMessagesHint")),
    createElement("div", { className: styles.field }, createElement("label", { className: styles.label, htmlFor: `${id}-invitation` }, text("invitation")), createElement("div", { className: styles.actionRow }, createElement("input", { id: `${id}-invitation`, className: styles.input, value: invitation, maxLength: 8_192, placeholder: "keet://chat/…", disabled: !actionAllowed || busy !== undefined, onChange: (event: { target: { value: string } }) => { setInvitation(event.target.value); setJoinStatus({ phase: "idle" }) }, "data-onboarding-field": "invitation" }), createElement("button", { type: "button", className: styles.primaryAction, disabled: !actionAllowed || busy !== undefined || !invitation.trim() || joinStatus.phase === "partial", onClick: () => void runMutation("join"), "data-onboarding-action": "join" }, busy === "join" ? text("joining") : text("join"))), createElement("p", { className: styles.hint }, text("invitationHint")), joinFeedback),
    createElement("div", { className: styles.field }, createElement("div", { className: styles.sectionHead }, createElement("span", { className: styles.label }, text("pendingRequests")), createElement("button", { type: "button", className: styles.secondaryAction, disabled: !actionAllowed || busy !== undefined, onClick: () => void refreshRequests(), "data-onboarding-action": "refresh" }, pending.phase === "loading" ? text("refreshing") : text("refresh"))), pending.phase === "idle" ? createElement("p", { className: styles.hint, role: "status" }, text("requestsHint")) : pending.phase === "loading" ? createElement("p", { className: styles.status, role: "status", "data-requests-state": "loading" }, text("requestsLoading")) : pending.phase === "failure" ? createElement("p", { className: `${styles.status} ${styles.invalid}`, role: "status", "data-requests-state": "failure" }, text("onboardingFailed")) : pending.requests.length === 0 ? createElement("p", { className: styles.status, role: "status", "data-requests-state": "empty" }, text("requestsEmpty")) : createElement("div", { className: styles.requestList, "data-pending-requests": true }, pending.requests.map((request, index) => {
      const status = acceptStatuses[request.memberId] ?? { phase: "idle" as const }
      const retry = status.phase === "partial" && status.retryToken
        ? createElement("button", { type: "button", className: styles.secondaryAction, disabled: !actionAllowed || busy !== undefined, onClick: () => void runMutation("accept", request.memberId, status.retryToken), "data-onboarding-action": "retry" }, text("retryAdmission"))
        : null
      const statusText = status.phase === "success" ? text("acceptSuccess") : status.phase === "failure" ? text("onboardingFailed") : status.phase === "partial" ? text("onboardingPartial") : ""
      return createElement("div", { className: styles.request, key: request.memberId, "data-pending-request": index }, createElement("span", { className: styles.requestIdentity }, createElement("span", null, request.displayName), createElement("span", { className: styles.identityHint }, request.identityHint)), createElement("span", { className: styles.requestActions }, statusText ? createElement("span", { className: `${styles.status} ${status.phase === "failure" || status.phase === "partial" ? styles.invalid : ""}`, role: "status" }, statusText) : null, retry, createElement("button", { type: "button", className: styles.primaryAction, disabled: !actionAllowed || busy !== undefined || status.phase === "loading" || status.phase === "partial" || status.phase === "success", onClick: () => void runMutation("accept", request.memberId), "data-onboarding-action": "accept" }, busy === `accept:${request.memberId}` ? text("accepting") : text("accept"))))
    }))),
  )

  const content = createElement("div", { className: styles.form, "data-settings-card": SETTINGS_NAMESPACE }, workspaceField, memberJoinControls, createElement("div", { className: styles.runtime, role: "status", "data-readiness": runtime.state }, createElement("strong", null, text("runtime")), createElement("span", { className: styles.runtimeState }, text(runtime.state))), onboarding)
  return createElement(Frame, { title: text("title"), description: text("description"), t: text, onOpen: () => setSectionOpened(true), state: { available: snapshot.status === "ready", writable, dirty, invalid, saving, failed }, onSave: () => void save(), onDiscard: () => { if (!saving) { setDraft({}); setFailed(false) } } }, content)
}

function isPendingRequest(value: unknown): value is PendingRequest {
  if (!value || typeof value !== "object") return false
  const candidate = value as { memberId?: unknown; displayName?: unknown; identityHint?: unknown }
  return typeof candidate.memberId === "string" && candidate.memberId.length > 0 && candidate.memberId.length <= 512
    && typeof candidate.displayName === "string" && candidate.displayName.length > 0 && candidate.displayName.length <= 512
    && typeof candidate.identityHint === "string" && candidate.identityHint.length > 0 && candidate.identityHint.length <= 32
}
