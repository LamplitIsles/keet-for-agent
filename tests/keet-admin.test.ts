import { describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { adminOrigin, runAdmin, type AdminDependencies } from "../packages/keet-mcp/src/admin.js"
import { deviceLinkHttp } from "../packages/keet-mcp/src/device-link-http.js"
import { DeviceLinkError, type KeetCore } from "@lamplitisles/keet-integration-core"

const token = "FIXTURE_TOKEN_".repeat(3)
const env = { KEET_MCP_ADMIN_URL: "http://127.0.0.1:12345", KEET_MCP_ADMIN_TOKEN: token }
async function run(argv: string[], overrides: AdminDependencies = {}) {
  let stdout = ""; let stderr = ""
  const code = await runAdmin(argv, { env, stdout: { write: (chunk) => { stdout += String(chunk); return true } }, stderr: { write: (chunk) => { stderr += String(chunk); return true } }, ...overrides })
  return { code, stdout, stderr }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

describe("scriptable admin thin client", () => {
  it("retains received HTTP failure when cancelling its body rejects", async () => {
    let reads = 0; let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new TextEncoder().encode("FIXTURE_PRIVATE_BODY")) },
      cancel() { cancelled = true; return Promise.reject(new Error("FIXTURE_PRIVATE_CANCEL")) },
    }, { highWaterMark: 0 })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { status: 502 }))
    const result = await run(["devices", "invite"], { fetch })
    expect(result).toEqual({ code: 1, stdout: "", stderr: '{"error":"operation_failed","httpStatus":502}\n' })
    expect(reads).toBe(0); expect(cancelled).toBe(true); expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST")
  })

  it("preserves safe HTTP failure categories and status without reading bodies or retrying", async () => {
    for (const [status, category] of [[401, "unauthorized"], [409, "request_conflict"], [502, "operation_failed"], [503, "http_failure"], [504, "pairing_state_unavailable"]] as const) {
      let reads = 0; let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { reads++; controller.enqueue(new TextEncoder().encode("FIXTURE_PRIVATE_BODY")) },
        cancel() { cancelled = true },
      }, { highWaterMark: 0 })
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { status }))
      const result = await run(["devices", "invite"], { fetch })
      expect(result.code).toBe(1); expect(result.stdout).toBe("")
      expect(JSON.parse(result.stderr)).toEqual({ error: category, httpStatus: status, ...(status === 504 ? { guidance: "Start the request on the phone, then check pending again; state could not be confirmed." } : {}) })
      expect(reads).toBe(0); expect(cancelled).toBe(true); expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it("reports the owned HTTP adapter's invitation failure without claiming a native cause", async () => {
    const createDeviceLinkInvitation = vi.fn().mockRejectedValue(new DeviceLinkError("unavailable"))
    const core = { createDeviceLinkInvitation } as unknown as KeetCore
    const shutdown = new AbortController()
    const server = createServer((request, response) => { void deviceLinkHttp(request, response, core, shutdown.signal) })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    try {
      const { port } = server.address() as { port: number }
      const result = await run(["devices", "invite"], { env: { ...env, KEET_MCP_ADMIN_URL: `http://127.0.0.1:${port}` } })
      expect(result).toEqual({ code: 1, stdout: "", stderr: '{"error":"operation_failed","httpStatus":502}\n' })
      expect(createDeviceLinkInvitation).toHaveBeenCalledTimes(1)
    } finally { shutdown.abort(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it("emits only standard integer HTTP statuses from responses", async () => {
    for (const status of [100, 599, 99, 600, 502.5, NaN, Infinity, undefined, "FIXTURE_PRIVATE_STATUS"]) {
      const response = new Response(null, { status: 500 })
      Object.defineProperty(response, "status", { value: status })
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
      const result = await run(["devices", "invite"], { fetch })
      expect(result.code).toBe(1); expect(result.stdout).toBe("")
      expect(JSON.parse(result.stderr)).toEqual({ error: "http_failure", ...([100, 599].includes(status as number) ? { httpStatus: status } : {}) })
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it("shows help without configuration or network and validates literal loopback origins", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const help = await run(["--help"], { env: {}, fetch })
    expect(help.code).toBe(0); expect(help.stdout).toContain("KEET_MCP_ADMIN_TOKEN"); expect(fetch).not.toHaveBeenCalled()
    expect(adminOrigin("http://127.0.0.1:80")).toBe("http://127.0.0.1")
    expect(adminOrigin("http://[::1]:1234/")).toBe("http://[::1]:1234")
    for (const url of ["http://localhost:1", "http://127.1:1", "http://2130706433:1", "http://127.0.0.1", "https://127.0.0.1:1", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:1/mcp", "http://127.0.0.1:1/../", "http://127.0.0.1:1?", "http://127.0.0.1:1#", "http://secret@127.0.0.1:1", "http://[::ffff:127.0.0.1]:1"]) expect(() => adminOrigin(url)).toThrow()
    expect((await run(["devices", "pending"], { env: {} })).stderr).toBe('{"error":"invalid_configuration"}\n')
  })

  it("requires an opaque target and explicit confirmation and accepts no token/link arguments", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    for (const argv of [["devices", "approve", "a".repeat(64)], ["devices", "reject", "Phone", "--yes"], ["devices", "invite", "--token", token], ["devices", "invite", "keet://link/SECRET"], ["devices", "pending", "extra"]]) {
      const result = await run(argv, { fetch })
      expect(result).toEqual({ code: 1, stdout: "", stderr: '{"error":"invalid_arguments"}\n' })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it("emits only validated success JSON and allows invitation material only in invite", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ invitationUrl: `keet://link/${"a".repeat(64)}`, expiresAt: 7_200_000 }))
    const result = await run(["devices", "invite"], { fetch })
    expect(result.code).toBe(0); expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout).invitationUrl).toContain("keet://link/")
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error", method: "POST", body: "{}", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } })
    for (const value of [{ request: null }, { request: { requestId: "a".repeat(64), deviceName: "Phone", invitationUrl: "keet://link/SECRET" } }, { request: { requestId: "bad", deviceName: "Phone" } }]) {
      fetch.mockResolvedValueOnce(json(value)); const malformed = await run(["devices", "pending"], { fetch }); expect(malformed).toEqual({ code: 1, stdout: "", stderr: '{"error":"invalid_response"}\n' })
    }
    fetch.mockResolvedValueOnce(json({ decisionSubmitted: "reject" }))
    expect((await run(["devices", "approve", "a".repeat(64), "--yes"], { fetch })).code).toBe(1)
    fetch.mockResolvedValueOnce(new Response("RAW_SECRET ".repeat(2000), { headers: { "content-type": "application/json" } }))
    expect((await run(["devices", "pending"], { fetch })).stderr).toBe('{"error":"invalid_response"}\n')
  })

  it("redacts raw errors/bodies, never retries mutations and times out response work", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    for (const status of [401, 409, 500, 504]) {
      fetch.mockResolvedValueOnce(json({ error: `${token} keet://link/RAW_SECRET` }, status))
      const result = await run(["devices", "approve", "a".repeat(64), "--yes"], { fetch })
      expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).not.toMatch(/FIXTURE_TOKEN|keet:\/\/link|RAW_SECRET/)
    }
    fetch.mockRejectedValueOnce(new Error(`${token} keet://link/RAW_SECRET`))
    expect((await run(["devices", "invite"], { fetch })).stderr).toBe('{"error":"transport_failure"}\n')
    expect(fetch).toHaveBeenCalledTimes(5)
    fetch.mockImplementationOnce(async (_url, options) => new Promise((_, reject) => { options!.signal!.addEventListener("abort", () => reject(new Error("RAW_SECRET")), { once: true }) }))
    expect((await run(["devices", "invite"], { fetch, timeoutMs: 5 })).stderr).toBe('{"error":"transport_failure"}\n')
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it("refuses actual HTTP redirects without forwarding auth or retrying", async () => {
    let mutations = 0; let forwarded = 0
    const server = createServer((request, response) => {
      if (request.url === "/admin/device-link/invitation") { mutations++; response.writeHead(307, { location: "/capture" }).end(token) }
      else { forwarded++; response.end("keet://link/RAW_SECRET") }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address() as { port: number }
      const result = await run(["devices", "invite"], { env: { ...env, KEET_MCP_ADMIN_URL: `http://127.0.0.1:${address.port}` } })
      expect(result).toEqual({ code: 1, stdout: "", stderr: '{"error":"transport_failure"}\n' })
      expect(mutations).toBe(1); expect(forwarded).toBe(0)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})
