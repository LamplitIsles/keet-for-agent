export const ACTION_STATUSES = ["pending", "approved", "rejected", "expired", "executed", "execute_failed"] as const
export type ActionStatus = typeof ACTION_STATUSES[number]
export type Verdict = "approve" | "reject"

/** Only the Impri presentation and decision contract; payloads remain opaque. */
export interface ApprovalAction {
  id: string
  title: string
  kind: string
  preview: string
  status: ActionStatus
}

export interface ApprovalInbox {
  pending(signal: AbortSignal): AsyncIterable<ApprovalAction>
  get(id: string, signal: AbortSignal): Promise<ApprovalAction | null>
  decide(id: string, verdict: Verdict, signal: AbortSignal): Promise<void>
}

export class ImpriHttpError extends Error {
  constructor(readonly status: number) { super(`Impri request failed (HTTP ${status})`) }
}

export function httpBase(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("Expected an HTTP base URL")
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Expected an HTTP base URL without credentials, query, or fragment")
  }
  return url.href.replace(/\/+$/, "")
}

export function actionStatus(value: unknown): ActionStatus {
  if (!ACTION_STATUSES.includes(value as ActionStatus)) throw new Error("Invalid Impri action status")
  return value as ActionStatus
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Impri response")
  return value as Record<string, unknown>
}

export function actionId(value: unknown): string {
  if (typeof value !== "string" || !/^act_[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid Impri action ID")
  return value
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid Impri action text")
  return value
}

function action(value: unknown): ApprovalAction {
  const raw = record(value)
  const preview = record(raw.preview)
  return {
    id: actionId(raw.id),
    title: boundedText(raw.title, 500),
    kind: boundedText(raw.kind, 100),
    preview: boundedText(preview.body, 256 * 1024),
    status: actionStatus(raw.status),
  }
}

/** Narrow client: bounded, cancelable requests; no hidden retry of decisions. */
export class ImpriInbox implements ApprovalInbox {
  readonly baseUrl: string
  readonly #apiKey: string
  readonly #fetch: typeof fetch

  constructor(baseUrl: string, apiKey: string, fetcher: typeof fetch = fetch) {
    this.baseUrl = httpBase(baseUrl)
    if (!/^im_[^\s]{1,512}$/.test(apiKey)) throw new Error("Invalid Impri API key")
    this.#apiKey = apiKey
    this.#fetch = fetcher
  }

  async *pending(signal: AbortSignal): AsyncIterable<ApprovalAction> {
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const query = new URLSearchParams({ status: "pending", limit: "25" })
      if (cursor) query.set("cursor", cursor)
      const page = record(await this.request(`/actions?${query}`, signal))
      if (!Array.isArray(page.items) || page.items.length > 25 || typeof page.has_more !== "boolean") throw new Error("Invalid Impri page")
      for (const value of page.items) {
        const item = action(value)
        if (item.status !== "pending") throw new Error("Invalid Impri pending action")
        yield item
      }
      if (!page.has_more) return
      if (typeof page.next_cursor !== "string" || !page.next_cursor || page.next_cursor.length > 2_048 || seen.has(page.next_cursor)) {
        throw new Error("Invalid Impri cursor")
      }
      cursor = page.next_cursor
      seen.add(cursor)
      if (seen.size > 1_024) throw new Error("Impri inbox scan exceeded its page bound")
    } while (!signal.aborted)
    signal.throwIfAborted()
  }

  async get(id: string, signal: AbortSignal): Promise<ApprovalAction | null> {
    try {
      const result = action(await this.request(`/actions/${actionId(id)}`, signal))
      if (result.id !== id) throw new Error("Impri action ID mismatch")
      return result
    } catch (error) {
      if (error instanceof ImpriHttpError && error.status === 404) return null
      throw error
    }
  }

  async decide(id: string, verdict: Verdict, signal: AbortSignal): Promise<void> {
    try {
      await this.request(`/actions/${actionId(id)}/decision`, signal, { decision: verdict, channel: "keet" })
    } catch (error) {
      // Impri is the decision authority. The caller re-reads canonical state
      // after success or a concurrent decision; it never synthesizes success.
      if (!(error instanceof ImpriHttpError && error.status === 409)) throw error
    }
  }

  private async request(route: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const response = await this.#fetch(`${this.baseUrl}/v1${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.#apiKey}`, accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestSignal,
      redirect: "error",
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new ImpriHttpError(response.status)
    }
    if (!response.body) throw new Error("Empty Impri response")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > 16 * 1024 * 1024) throw new Error("Impri response exceeded its size bound")
        chunks.push(next.value)
      }
      requestSignal.throwIfAborted()
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}
