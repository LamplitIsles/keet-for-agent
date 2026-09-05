import { DEFAULT_SETTINGS, type KeetSettings } from "./constants.js"

export function decodeSettings(value: unknown): Partial<KeetSettings> {
  if (!value || typeof value !== "object") return {}
  const input = value as Record<string, unknown>
  return {
    ...(typeof input.groupId === "string" ? { groupId: input.groupId } : {}),
    ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
    ...(typeof input.dmMemberId === "string" ? { dmMemberId: input.dmMemberId } : {}),
  }
}

export function normalizeSettings(value: unknown): KeetSettings {
  const decoded = decodeSettings(value)
  return {
    groupId: decoded.groupId ?? DEFAULT_SETTINGS.groupId,
    workspaceId: decoded.workspaceId ?? DEFAULT_SETTINGS.workspaceId,
    dmMemberId: decoded.dmMemberId?.trim() ?? DEFAULT_SETTINGS.dmMemberId,
  }
}

export interface SettingsValidation { valid: boolean; issues: Partial<Record<keyof KeetSettings, string>> }

export function validateSettings(value: Partial<KeetSettings>): SettingsValidation {
  const issues: SettingsValidation["issues"] = {}
  for (const key of ["groupId", "workspaceId"] as const) {
    if (!value[key]?.trim()) issues[key] = "required"
    else if (value[key]!.length > 512) issues[key] = "invalid"
  }
  if (value.dmMemberId !== undefined && value.dmMemberId.trim().length > 512) issues.dmMemberId = "invalid"
  return { valid: Object.keys(issues).length === 0, issues }
}
