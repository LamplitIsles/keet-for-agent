import { DEFAULT_SETTINGS, type KeetSettings } from "./constants.js"

export function decodeSettings(value: unknown): Partial<KeetSettings> {
  if (!value || typeof value !== "object") return {}
  const input = value as Record<string, unknown>
  const memberJoinTriggers = decodeMemberJoinTriggers(input.memberJoinTriggers)
  return {
    ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
    ...(memberJoinTriggers ? { memberJoinTriggers } : {}),
  }
}

export function normalizeSettings(value: unknown): KeetSettings {
  const decoded = decodeSettings(value)
  return {
    workspaceId: decoded.workspaceId ?? DEFAULT_SETTINGS.workspaceId,
    memberJoinTriggers: decoded.memberJoinTriggers ?? DEFAULT_SETTINGS.memberJoinTriggers,
  }
}

export interface SettingsValidation { valid: boolean; issues: Partial<Record<keyof KeetSettings, string>> }

export function validateSettings(value: Partial<KeetSettings>): SettingsValidation {
  const issues: SettingsValidation["issues"] = {}
  if (!value.workspaceId?.trim()) issues.workspaceId = "required"
  else if (value.workspaceId.length > 512) issues.workspaceId = "invalid"
  return { valid: Object.keys(issues).length === 0, issues }
}

function decodeMemberJoinTriggers(value: unknown): KeetSettings["memberJoinTriggers"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value).flatMap(([workspaceId, groups]) => {
    if (!groups || typeof groups !== "object" || Array.isArray(groups)) return []
    const decodedGroups = Object.fromEntries(Object.entries(groups).filter(([, enabled]) => typeof enabled === "boolean")) as Readonly<Record<string, boolean>>
    return [[workspaceId, decodedGroups]]
  }))
}
