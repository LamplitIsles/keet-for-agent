export type KeetLocaleKey = "title" | "description" | "groupId" | "groupIdHint" | "workspaceId" | "workspaceHint" | "workspaceMissing" | "runtime" | "restartHint" | "save" | "saving" | "discard" | "unsaved" | "readOnly" | "saveFailed" | "required" | "unbound" | "missing-settings" | "connecting" | "ready" | "failed" | "disabled"

export const keetLabels: Record<KeetLocaleKey, string> = {
  title: "Keet bridge",
  description: "Connect one Managed Group to an existing DSH conversation.",
  groupId: "Managed Group ID",
  groupIdHint: "Paste the group ID returned by dsh-keet-setup after joining the invitation.",
  workspaceId: "DSH workspace",
  workspaceHint: "Owns .dsh/dsh-keet/identity and supplies the latest eligible human conversation.",
  workspaceMissing: "The selected workspace is not available in this DSH deployment.",
  runtime: "Bridge readiness",
  restartHint: "Save the workspace first, run onboarding, paste its group ID, then restart DSH.",
  save: "Save",
  saving: "Saving…",
  discard: "Discard",
  unsaved: "Unsaved",
  readOnly: "This deployment is read-only.",
  saveFailed: "The deployment rejected these values; your draft was kept.",
  required: "Required",
  unbound: "No eligible existing conversation was found.",
  "missing-settings": "Incomplete settings",
  connecting: "Connecting…",
  ready: "Ready",
  failed: "Unavailable",
  disabled: "Stopped",
}

export const keetZhLabels = { ...keetLabels, title: "Keet bridge", description: "将一个 Managed Group 连接到现有 DSH 会话。" } as Record<KeetLocaleKey, string>
export const keetLocale = { en: keetLabels, zh: keetZhLabels } as const
