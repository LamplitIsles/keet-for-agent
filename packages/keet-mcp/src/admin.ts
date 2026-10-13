#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as z from "zod/v4"

const HELP = `Usage: keet-mcp-admin devices <command>

  invite                     Create a 2h invitation (private terminal JSON)
  pending                    Observe one current request (waits up to 5s)
  approve REQUEST_ID --yes   Submit approval of that exact request
  reject REQUEST_ID --yes    Submit rejection of that exact request

Environment: KEET_MCP_ADMIN_URL (http://127.0.0.1:PORT or http://[::1]:PORT),
KEET_MCP_ADMIN_TOKEN (separate human management credential, at least 32 chars).
No runtime/identity access or service restart. Start Link device / Use account
link on the phone, then query pending. A silent/ended subscription cannot prove
there is no request: pending exits nonzero if state cannot be confirmed.
Decision success means submitted, not phone synchronization completed.
Failures can leave mutation results unknown; check the phone and pending.
No automatic retries. Never pass tokens or invitations as command arguments.`

const requestIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
const invitationSchema = z.strictObject({ invitationUrl: z.string().regex(/^keet:\/\/link\/[a-z0-9]{1,8192}$/), expiresAt: z.number().int().positive() })
const pendingSchema = z.strictObject({ request: z.strictObject({ requestId: requestIdSchema, deviceName: z.string().min(1).max(512) }) })
const decisionSchema = z.strictObject({ decisionSubmitted: z.enum(["approve", "reject"]) })

export interface AdminDependencies {
  env?: NodeJS.ProcessEnv
  stdout?: Pick<NodeJS.WritableStream, "write">
  stderr?: Pick<NodeJS.WritableStream, "write">
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export function adminOrigin(value: string): string {
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(value)
  if (!match || Number(match[2]) > 65535) throw new Error("invalid_configuration")
  return new URL(value).origin
}

class AdminFailure extends Error {
  constructor(readonly category: string) { super(category) }
}

export async function runAdmin(argv: readonly string[], dependencies: AdminDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) { stdout.write(`${HELP}\n`); return 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [scope, command, requestId, yes] = argv
    if (scope !== "devices" || !["invite", "pending", "approve", "reject"].includes(command ?? "")) throw new AdminFailure("invalid_arguments")
    const deciding = command === "approve" || command === "reject"
    if (deciding ? argv.length !== 4 || yes !== "--yes" || !requestIdSchema.safeParse(requestId).success : argv.length !== 2) throw new AdminFailure("invalid_arguments")
    const env = dependencies.env ?? process.env
    let origin: string
    const token = env.KEET_MCP_ADMIN_TOKEN?.trim()
    try { origin = adminOrigin(env.KEET_MCP_ADMIN_URL ?? ""); if (!token || token.length < 32) throw new Error() } catch { throw new AdminFailure("invalid_configuration") }
    const abort = new AbortController()
    timer = setTimeout(() => abort.abort(), dependencies.timeoutMs ?? 12_000)
    const route = deciding ? "decision" : command === "invite" ? "invitation" : "request"
    const response = await (dependencies.fetch ?? globalThis.fetch)(`${origin}/admin/device-link/${route}`, {
      method: command === "pending" ? "GET" : "POST", redirect: "error", signal: abort.signal,
      headers: { authorization: `Bearer ${token}`, ...(command !== "pending" ? { "content-type": "application/json" } : {}) },
      ...(command !== "pending" ? { body: JSON.stringify(deciding ? { requestId, decision: command } : {}) } : {}),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new AdminFailure(response.status === 409 ? "request_conflict" : response.status === 504 ? "pairing_state_unavailable" : response.status === 401 ? "unauthorized" : "http_failure")
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") { await response.body?.cancel(); throw new AdminFailure("invalid_response") }
    const reader = response.body?.getReader()
    if (!reader) throw new AdminFailure("invalid_response")
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 16_384) throw new AdminFailure("invalid_response")
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    let value: unknown
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw new AdminFailure("invalid_response") }
    const result = command === "invite" ? invitationSchema.safeParse(value) : command === "pending" ? pendingSchema.safeParse(value) : decisionSchema.safeParse(value)
    if (!result.success || (deciding && "decisionSubmitted" in result.data && result.data.decisionSubmitted !== command)) throw new AdminFailure("invalid_response")
    stdout.write(`${JSON.stringify(result.data)}\n`)
    return 0
  } catch (error) {
    const category = error instanceof AdminFailure ? error.category : "transport_failure"
    stderr.write(`${JSON.stringify({ error: category, ...(category === "pairing_state_unavailable" ? { guidance: "Start the request on the phone, then check pending again; state could not be confirmed." } : {}) })}\n`)
    return 1
  } finally { if (timer) clearTimeout(timer) }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) process.exitCode = await runAdmin(process.argv.slice(2))
