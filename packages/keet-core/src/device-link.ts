import { createHmac, randomBytes } from "node:crypto"
import type { KeetSidecar } from "./sidecar.js"
import type { DeviceLinkInvitation, DeviceLinkRequest } from "./types.js"

export class DeviceLinkError extends Error {
  constructor(readonly code: "conflict" | "unavailable" | "cancelled" | "timeout") { super(code) }
}

const DEADLINE_MS = 5_000
const ID = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/
const TOKEN = /^[a-z0-9]{1,8192}$/
type NativeRequest = DeviceLinkRequest & { deviceId: string; identityDeviceId: string }

/** One identity owner; unary mutations retain their serial slot until RPC settles. */
export class DeviceLinking {
  readonly #abort = new AbortController()
  readonly #key = randomBytes(32)
  #tail: Promise<void> = Promise.resolve()
  #mutations = 0
  constructor(readonly sidecar: KeetSidecar, readonly timeoutMs = DEADLINE_MS) {}
  close(): void { this.#abort.abort() }

  async invitation(signal?: AbortSignal): Promise<DeviceLinkInvitation> {
    return this.bounded(async (active) => this.mutate(active, async () => {
      const started = Date.now()
      const token = await this.sidecar.call("createIdentityInvitation", [])
      check(active)
      if (typeof token !== "string" || !TOKEN.test(token)) throw new DeviceLinkError("unavailable")
      const info = await this.sidecar.call("getLinkInfo", [token])
      check(active)
      if (!info || typeof info !== "object" || !("isIdentityInvitation" in info) || info.isIdentityInvitation !== true) throw new DeviceLinkError("unavailable")
      return { invitationUrl: `keet://link/${token}`, expiresAt: started + 2 * 60 * 60 * 1_000 }
    }), signal)
  }

  async request(signal?: AbortSignal): Promise<DeviceLinkRequest> {
    return this.bounded(async (active) => {
      const request = await this.snapshot(active)
      return { requestId: request.requestId, deviceName: request.deviceName }
    }, signal)
  }

  async decide(requestId: string, decision: "approve" | "reject", signal?: AbortSignal): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(requestId) || !["approve", "reject"].includes(decision)) throw new DeviceLinkError("conflict")
    return this.bounded(async (active) => this.mutate(active, async () => {
      const current = await this.snapshot(active)
      if (!current || current.requestId !== requestId) throw new DeviceLinkError("conflict")
      check(active)
      const result = await this.sidecar.call("confirmPairingRequest", [{ deviceId: current.deviceId }, decision === "approve"])
      if (result !== undefined && result !== null && (typeof result !== "object" || Array.isArray(result) || Object.keys(result).length)) throw new DeviceLinkError("unavailable")
    }), signal)
  }

  private mutate<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (this.#mutations >= 32) return Promise.reject(new DeviceLinkError("unavailable"))
    this.#mutations++
    const result = this.#tail.then(() => { check(signal); return operation() })
    this.#tail = result.then(() => { this.#mutations-- }, () => { this.#mutations-- })
    return result
  }

  private snapshot(signal: AbortSignal): Promise<NativeRequest> {
    check(signal)
    const stream = this.sidecar.subscribe("subscribeIdentityPairingRequests", [])
    return new Promise((resolve, reject) => {
      const finish = (error?: DeviceLinkError, value?: NativeRequest) => {
        signal.removeEventListener("abort", abort)
        stream.off("data", data); stream.off("error", failed); stream.off("close", failed); stream.off("end", failed)
        // Transport may deliver a teardown error after destroy.
        stream.on("error", () => undefined)
        stream.destroy()
        if (error) reject(error); else resolve(value!)
      }
      const abort = () => finish(new DeviceLinkError("cancelled"))
      const failed = () => finish(new DeviceLinkError("unavailable"))
      const data = (raw: unknown) => {
        if (raw === null) { failed(); return }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) { failed(); return }
        const value = raw as Record<string, unknown>
        if (typeof value.deviceId !== "string" || !ID.test(value.deviceId) || typeof value.identityDeviceId !== "string" || !ID.test(value.identityDeviceId) || typeof value.deviceName !== "string" || value.deviceName.length > 512) { failed(); return }
        const { deviceId, identityDeviceId } = value
        const requestId = createHmac("sha256", this.#key).update(JSON.stringify([deviceId, identityDeviceId])).digest("hex")
        // eslint-disable-next-line no-control-regex -- remove untrusted native label controls
        finish(undefined, { deviceId, identityDeviceId, requestId, deviceName: value.deviceName.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ").trim() || "Unnamed device" })
      }
      stream.on("data", data); stream.once("error", failed); stream.once("close", failed); stream.once("end", failed)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  private async bounded<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const deadline = new AbortController()
    const active = AbortSignal.any([deadline.signal, this.#abort.signal, ...(signal ? [signal] : [])])
    check(active)
    let abort: () => void = () => undefined
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new DeviceLinkError(deadline.signal.aborted ? "timeout" : "cancelled"))
      active.addEventListener("abort", abort, { once: true })
    })
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs)
    try { return await Promise.race([operation(active), cancelled]) }
    catch (error) { throw error instanceof DeviceLinkError ? error : new DeviceLinkError("unavailable") }
    finally { clearTimeout(timer); active.removeEventListener("abort", abort) }
  }
}

function check(signal: AbortSignal): void { if (signal.aborted) throw new DeviceLinkError("cancelled") }
