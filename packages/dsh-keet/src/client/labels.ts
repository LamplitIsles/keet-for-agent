export type KeetLocaleKey = "title" | "description" | "workspaceId" | "workspaceHint" | "workspaceMissing" | "runtime" | "restartHint" | "save" | "saving" | "discard" | "unsaved" | "readOnly" | "saveFailed" | "required" | "unbound" | "missing-settings" | "connecting" | "ready" | "failed" | "disabled"

export const keetLabels: Record<KeetLocaleKey, string> = {
  title: "Keet bridge",
  description: "Discover joined groups and accepted DMs in one existing DSH conversation.",
  workspaceId: "DSH workspace",
  workspaceHint: "Owns .dsh/dsh-keet/identity and supplies the latest eligible human conversation.",
  workspaceMissing: "The selected workspace is not available in this DSH deployment.",
  runtime: "Bridge readiness",
  restartHint: "Save settings, complete human-only onboarding or DM acceptance, then restart DSH.",
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

export const keetZhLabels = { ...keetLabels, title: "Keet bridge", description: "在一个现有 DSH 会话中自动发现已加入的群组和已接受的私信。" } as Record<KeetLocaleKey, string>
export const keetLocale = { en: keetLabels, zh: keetZhLabels } as const
