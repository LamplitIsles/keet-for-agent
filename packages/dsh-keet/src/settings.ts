import z from "@deepseek-ai/schemastery"
import { DEFAULT_SETTINGS, type KeetSettings } from "./constants.js"

export const KeetSettingsSchema = z.transform(
  z.object({
    workspaceId: z.string().default(DEFAULT_SETTINGS.workspaceId),
    memberJoinTriggers: z.dict(z.dict(z.boolean())).default(DEFAULT_SETTINGS.memberJoinTriggers),
  }),
  (value) => ({
    workspaceId: value.workspaceId ?? "",
    memberJoinTriggers: value.memberJoinTriggers ?? {},
  }),
).default(DEFAULT_SETTINGS) as unknown as z<KeetSettings>
