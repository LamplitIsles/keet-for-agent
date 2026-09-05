export interface SessionHeaderLike {
  id: string;
  origin?: string;
  agentPreset?: string;
  [key: string]: unknown;
}

export interface SessionEventLike {
  type?: string;
  time?: number;
  data?: unknown;
  [key: string]: unknown;
}

export interface SessionInspectionLike {
  meta: SessionHeaderLike;
  events: readonly SessionEventLike[];
}

export interface WorkspaceLike {
  id: string;
  path: string;
  sessionIds: readonly string[];
  [key: string]: unknown;
}

export interface ActiveSessionCandidate {
  sessionId: string;
  inspection: SessionInspectionLike;
  lastHumanPromptAt: number;
}

function sourceKind(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const source = (data as { source?: unknown }).source;
  if (typeof source !== "object" || source === null) return undefined;
  const kind = (source as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

function hasHumanPromptContent(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return true;
  const content = (data as { content?: unknown }).content;
  if (content === undefined) return true;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => typeof block === "object" && block !== null && (block as { type?: unknown; text?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" && (block as { text: string }).text.trim().length > 0);
}

/** Return the latest timestamp at which a persisted human user prompt entered the session. */
export function lastHumanPromptAt(inspection: SessionInspectionLike): number | undefined {
  let latest: number | undefined;
  for (const event of inspection.events) {
    if (event.type !== "user/message" || sourceKind(event.data) !== "user" || !hasHumanPromptContent(event.data)) continue;
    const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : undefined;
    if (time !== undefined && (latest === undefined || time > latest)) latest = time;
  }
  return latest;
}

/**
 * Select one session from the workspace's authoritative ordered `sessionIds`.
 * Archived, blank, and subagent-origin rows never become a bridge target. Ties
 * use the stable session id so the result does not depend on storage iteration.
 */
export function selectMostRecentEligibleSession(
  workspace: WorkspaceLike,
  inspections: ReadonlyMap<string, SessionInspectionLike>,
  archivedSessionIds: ReadonlySet<string> = new Set()
): ActiveSessionCandidate | undefined {
  const candidates: ActiveSessionCandidate[] = [];
  for (const rawId of workspace.sessionIds) {
    const sessionId = String(rawId);
    if (archivedSessionIds.has(sessionId)) continue;
    const inspection = inspections.get(sessionId);
    if (!inspection) continue;
    const origin = inspection.meta.origin;
    if (origin === "subagent") continue;
    const last = lastHumanPromptAt(inspection);
    if (last === undefined) continue;
    candidates.push({ sessionId, inspection, lastHumanPromptAt: last });
  }
  candidates.sort((left, right) => {
    if (left.lastHumanPromptAt !== right.lastHumanPromptAt) return right.lastHumanPromptAt - left.lastHumanPromptAt;
    // Compare code points directly so ties do not depend on the host locale.
    return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
  });
  return candidates[0];
}
