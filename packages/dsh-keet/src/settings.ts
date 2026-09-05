import z from "@deepseek-ai/schemastery"
import { DEFAULT_SETTINGS, type KeetSettings } from "./constants.js"

export const KeetSettingsSchema = z.transform(
  z.object({ workspaceId: z.string().default(DEFAULT_SETTINGS.workspaceId) }),
  (value) => ({ workspaceId: value.workspaceId ?? "" }),
).default(DEFAULT_SETTINGS) as unknown as z<KeetSettings>
