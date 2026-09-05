import { DEFAULT_SETTINGS, type KeetSettings } from "./constants.js"

export function decodeSettings(value: unknown): Partial<KeetSettings> {
  if (!value || typeof value !== "object") return {}
  const input = value as Record<string, unknown>
  return {
    ...(typeof input.groupId === "string" ? { groupId: input.groupId } : {}),
    ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
  }
}

export function normalizeSettings(value: unknown): KeetSettings {
  const decoded = decodeSettings(value)
  return {
    groupId: decoded.groupId ?? DEFAULT_SETTINGS.groupId,
    workspaceId: decoded.workspaceId ?? DEFAULT_SETTINGS.workspaceId,
  }
}

export interface SettingsValidation { valid: boolean; issues: Partial<Record<keyof KeetSettings, string>> }

export function validateSettings(value: Partial<KeetSettings>): SettingsValidation {
  const issues: SettingsValidation["issues"] = {}
  for (const key of ["groupId", "workspaceId"] as const) {
    if (!value[key]?.trim()) issues[key] = "required"
  }
  return { valid: Object.keys(issues).length === 0, issues }
}
