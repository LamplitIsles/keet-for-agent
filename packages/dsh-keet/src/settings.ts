import z from "@deepseek-ai/schemastery"
import { DEFAULT_SETTINGS, type KeetSettings } from "./constants.js"

export const KeetSettingsSchema: z<KeetSettings> = z.object({
  groupId: z.string().default(DEFAULT_SETTINGS.groupId),
  workspaceId: z.string().default(DEFAULT_SETTINGS.workspaceId),
  dmMemberId: z.string().default(DEFAULT_SETTINGS.dmMemberId),
})
