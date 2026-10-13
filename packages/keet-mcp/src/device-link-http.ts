import type { IncomingMessage, ServerResponse } from "node:http"
import { DeviceLinkError, type KeetCore } from "@lamplitisles/keet-integration-core"
import * as z from "zod/v4"

const decisionSchema = z.strictObject({ requestId: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["approve", "reject"]) })
const emptySchema = z.strictObject({})

export function adminJson(response: ServerResponse, status: number, value: object): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(value))
}

/** Authentication is performed by the gateway before entering this handler. */
export async function deviceLinkHttp(request: IncomingMessage, response: ServerResponse, core: KeetCore, shutdown: AbortSignal): Promise<void> {
  const url = new URL(request.url!, "http://localhost")
  const route = url.pathname.slice("/admin/device-link/".length)
  const method = route === "request" ? "GET" : "POST"
  if (!["request", "invitation", "decision"].includes(route) || request.url !== url.pathname) { adminJson(response, 404, { error: "not_found" }); return }
  if (request.method !== method) { adminJson(response, 405, { error: "method_not_allowed" }); return }
  const disconnected = new AbortController()
  const deadline = new AbortController()
  const signal = AbortSignal.any([shutdown, disconnected.signal, deadline.signal])
  const abort = () => disconnected.abort()
  request.once("aborted", abort)
  response.once("close", abort)
  const timer = setTimeout(() => deadline.abort(), 10_000)
  try {
    const body = await readBody(request, signal)
    if (signal.aborted) throw new DeviceLinkError("cancelled")
    if (route === "request") {
      if (body.length) { adminJson(response, 400, { error: "invalid_request" }); return }
      adminJson(response, 200, { request: await core.getDeviceLinkRequest(signal) })
    } else {
      if (request.headers["content-type"]?.toLowerCase() !== "application/json") { adminJson(response, 400, { error: "invalid_request" }); return }
      let parsed: unknown
      try { parsed = JSON.parse(body.toString("utf8")) } catch { adminJson(response, 400, { error: "invalid_request" }); return }
      if (route === "invitation") {
        if (!emptySchema.safeParse(parsed).success) { adminJson(response, 400, { error: "invalid_request" }); return }
        adminJson(response, 200, await core.createDeviceLinkInvitation(signal))
      } else {
        const checked = decisionSchema.safeParse(parsed)
        if (!checked.success) { adminJson(response, 400, { error: "invalid_request" }); return }
        await core.decideDeviceLink(checked.data.requestId, checked.data.decision, signal)
        adminJson(response, 200, { decisionSubmitted: checked.data.decision })
      }
    }
  } catch (error) {
    if (response.destroyed) return
    if (error instanceof BodyError) adminJson(response, error.status, { error: "invalid_request" })
    else if (error instanceof DeviceLinkError && error.code === "conflict") adminJson(response, 409, { error: "request_conflict" })
    else if (deadline.signal.aborted || (error instanceof DeviceLinkError && ["timeout", "unavailable"].includes(error.code) && route !== "invitation")) adminJson(response, 504, { error: "pairing_state_unavailable" })
    else adminJson(response, 502, { error: "operation_failed" })
  } finally {
    clearTimeout(timer); request.off("aborted", abort); response.off("close", abort)
  }
}

class BodyError extends Error { constructor(readonly status: number) { super("invalid_request") } }
function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0
    const finish = (error?: Error) => {
      request.off("data", data); request.off("end", end); request.off("error", failed); signal.removeEventListener("abort", abort)
      if (error) { request.resume(); reject(error) } else resolve(Buffer.concat(chunks))
    }
    const data = (chunk: Buffer) => { size += chunk.length; if (size > 4096) finish(new BodyError(413)); else chunks.push(chunk) }
    const end = () => finish()
    const failed = () => finish(new BodyError(400))
    const abort = () => finish(new DeviceLinkError("cancelled"))
    request.on("data", data); request.once("end", end); request.once("error", failed); signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}
