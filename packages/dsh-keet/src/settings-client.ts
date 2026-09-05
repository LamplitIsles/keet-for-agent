import { DEFAULT_SETTINGS, type KeetSettings } from "./constants.js"

export function decodeSettings(value: unknown): Partial<KeetSettings> {
  if (!value || typeof value !== "object") return {}
  const input = value as Record<string, unknown>
  return typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}
}

export function normalizeSettings(value: unknown): KeetSettings {
  const decoded = decodeSettings(value)
  return { workspaceId: decoded.workspaceId ?? DEFAULT_SETTINGS.workspaceId }
}

export interface SettingsValidation { valid: boolean; issues: Partial<Record<keyof KeetSettings, string>> }

export function validateSettings(value: Partial<KeetSettings>): SettingsValidation {
  const issues: SettingsValidation["issues"] = {}
  if (!value.workspaceId?.trim()) issues.workspaceId = "required"
  else if (value.workspaceId.length > 512) issues.workspaceId = "invalid"
  return { valid: Object.keys(issues).length === 0, issues }
}
