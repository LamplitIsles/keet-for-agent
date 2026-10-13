import { afterEach, describe, expect, it, vi } from "vitest"
import { PassThrough } from "node:stream"
import { KeetSidecar } from "../packages/keet-core/src/sidecar.js"
import { DeviceLinkError, DeviceLinking } from "../packages/keet-core/src/device-link.js"
import type { RpcMethodName } from "../packages/keet-core/src/rpc-methods.js"

const native = (device = "a", identity = "b", deviceName = "Phone") => ({ deviceId: device.repeat(52), identityDeviceId: identity.repeat(52), deviceName })
function fake(timeoutMs = 50) {
  const sidecar = new KeetSidecar({ executablePath: "/inert/bare", bundlePath: "/inert/worker", dataPath: "/inert/identity" })
  let snapshot: unknown = native()
  let emit = true; let eof = false
  const streams: PassThrough[] = []
  const call = vi.fn(async (name: RpcMethodName, _args: unknown[]): Promise<unknown> => {
    if (name === "createIdentityInvitation") return "a".repeat(64)
    if (name === "getLinkInfo") return { isIdentityInvitation: true }
    if (name === "confirmPairingRequest") { emit = false; return undefined }
    throw new Error("RAW_TOKEN_LINK_SECRET")
  })
  sidecar.call = call
  const subscribe = vi.fn(() => {
    const stream = new PassThrough({ objectMode: true }); streams.push(stream)
    queueMicrotask(() => { if (stream.destroyed) return; if (eof) stream.end(); else if (emit) stream.write(snapshot) })
    return stream
  })
  sidecar.subscribe = subscribe
  const linking = new DeviceLinking(sidecar, timeoutMs)
  return { linking, sidecar, call, subscribe, streams, set(value: unknown) { snapshot = value }, silent() { emit = false }, end() { eof = true } }
}
afterEach(() => vi.useRealTimers())

describe("bounded official device linking", () => {
  it("validates the identity token and conservatively displays the native 2h lifetime", async () => {
    const f = fake(); const before = Date.now(); const invitation = await f.linking.invitation()
    expect(invitation.invitationUrl).toBe(`keet://link/${"a".repeat(64)}`)
    expect(invitation.expiresAt).toBeGreaterThanOrEqual(before + 7_200_000)
    expect(invitation.expiresAt).toBeLessThanOrEqual(Date.now() + 7_200_000)
    expect(f.call.mock.calls).toEqual([["createIdentityInvitation", []], ["getLinkInfo", ["a".repeat(64)]]])
    f.call.mockResolvedValueOnce("bad/token")
    await expect(f.linking.invitation()).rejects.toMatchObject({ code: "unavailable" })
    f.call.mockResolvedValueOnce("a".repeat(64)).mockResolvedValueOnce({ isRoomInvitation: true })
    await expect(f.linking.invitation()).rejects.toMatchObject({ code: "unavailable" })
  })

  it("binds both IDs opaquely and stably, with deviceName only a sanitized hint", async () => {
    const f = fake(); const first = await f.linking.request()
    f.set(native("a", "b", "Renamed\nPhone")); const renamed = await f.linking.request()
    expect(renamed).toEqual({ requestId: first.requestId, deviceName: "Renamed Phone" })
    expect(Object.keys(first).sort()).toEqual(["deviceName", "requestId"])
    expect(first.requestId).toMatch(/^[a-f0-9]{64}$/)
    f.set(native("a", "c")); expect((await f.linking.request()).requestId).not.toBe(first.requestId)
    f.set(native("d", "b")); expect((await f.linking.request()).requestId).not.toBe(first.requestId)
    expect(f.streams.every((stream) => stream.destroyed)).toBe(true)
    expect(f.subscribe.mock.calls).toEqual(Array(4).fill(["subscribeIdentityPairingRequests", []]))
  })

  it("rejects stale/same-name targets and submits the exact current device via native boolean", async () => {
    const f = fake(); const old = await f.linking.request(); f.set(native("a", "c"))
    await expect(f.linking.decide(old.requestId, "approve")).rejects.toMatchObject({ code: "conflict" })
    expect(f.call).not.toHaveBeenCalled()
    const current = await f.linking.request(); await f.linking.decide(current.requestId, "reject")
    expect(f.call.mock.calls).toEqual([["confirmPairingRequest", [{ deviceId: "a".repeat(52) }, false]]])
    await expect(f.linking.decide(current.requestId, "approve")).rejects.toBeInstanceOf(DeviceLinkError)
    expect(f.call).toHaveBeenCalledTimes(1)
  })

  it("serializes concurrent decisions and re-reads the queue rather than approving another phone", async () => {
    const f = fake(); const first = await f.linking.request()
    f.call.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); f.set(native("d", "c")); return undefined })
    const results = await Promise.allSettled([f.linking.decide(first.requestId, "approve"), f.linking.decide(first.requestId, "approve")])
    expect(results[0].status).toBe("fulfilled"); expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "conflict" } })
    expect(f.call.mock.calls).toEqual([["confirmPairingRequest", [{ deviceId: "a".repeat(52) }, true]]])
    const second = await f.linking.request(); await f.linking.decide(second.requestId, "reject")
    expect(f.call.mock.calls[1]).toEqual(["confirmPairingRequest", [{ deviceId: "d".repeat(52) }, false]])
  })

  it.each([[], {}, { ...native(), identityDeviceId: undefined }, { ...native(), deviceId: "bad" }, { ...native(), deviceName: 7 }])("fails closed for malformed snapshot %j", async (snapshot) => {
    const f = fake(); f.set(snapshot)
    await expect(f.linking.request()).rejects.toMatchObject({ code: "unavailable" })
    expect(f.streams[0].destroyed).toBe(true); expect(f.streams[0].listenerCount("data")).toBe(0)
  })

  it("never treats native silence or EOF as an empty snapshot", async () => {
    const silent = fake(10); silent.silent()
    await expect(silent.linking.request()).rejects.toMatchObject({ code: "timeout" })
    expect(silent.streams[0].destroyed).toBe(true)
    const ended = fake(); ended.end()
    await expect(ended.linking.request()).rejects.toMatchObject({ code: "unavailable" })
    expect(ended.streams[0].destroyed).toBe(true)
    await expect(ended.linking.decide("a".repeat(64), "approve")).rejects.toMatchObject({ code: "unavailable" })
    expect(ended.call).not.toHaveBeenCalled()
  })

  it("bounds a native silent first snapshot at exactly five seconds", async () => {
    vi.useFakeTimers()
    const f = fake(); f.silent()
    const linking = new DeviceLinking(f.sidecar)
    let settled = false
    const pending = linking.request().finally(() => { settled = true })
    const checked = expect(pending).rejects.toMatchObject({ code: "timeout" })
    await vi.advanceTimersByTimeAsync(4999); expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await checked
    expect(f.streams[0].destroyed).toBe(true); expect(vi.getTimerCount()).toBe(0)
  })

  it("cleans streams, listeners and timers on abort, transport failure and owner close", async () => {
    vi.useFakeTimers()
    for (const cause of ["abort", "close", "transport"] as const) {
      const f = fake(); f.silent(); const abort = new AbortController(); const pending = f.linking.request(abort.signal)
      const checked = expect(pending).rejects.toBeInstanceOf(DeviceLinkError)
      if (cause === "abort") abort.abort(); else if (cause === "close") f.linking.close(); else f.streams[0].destroy(new Error("RAW_TOKEN_LINK_SECRET"))
      await checked
      expect(f.streams[0].destroyed).toBe(true); expect(f.streams[0].listenerCount("data")).toBe(0); expect(vi.getTimerCount()).toBe(0)
    }
    const f = fake(); f.linking.close(); await expect(f.linking.request()).rejects.toMatchObject({ code: "cancelled" }); expect(f.streams).toHaveLength(0)
  })

  it("keeps timed-out dispatched mutations serialized until RPC settles and cancels queued work", async () => {
    const f = fake(20); const current = await f.linking.request()
    let release!: () => void
    f.call.mockImplementation(() => new Promise((resolve) => { release = () => resolve(undefined) }))
    await expect(f.linking.decide(current.requestId, "approve")).rejects.toMatchObject({ code: "timeout" })
    await expect(f.linking.decide(current.requestId, "reject")).rejects.toMatchObject({ code: "timeout" })
    expect(f.call).toHaveBeenCalledTimes(1)
    release(); await new Promise((resolve) => setTimeout(resolve))
    expect(f.call).toHaveBeenCalledTimes(1)
  })

  it("bounds retained management work when a dispatched RPC is stalled", async () => {
    const f = fake(); const current = await f.linking.request()
    let release!: () => void
    f.call.mockImplementation(() => new Promise((resolve) => { release = () => resolve(undefined) }))
    const results = Array.from({ length: 33 }, () => f.linking.decide(current.requestId, "approve").catch((error: unknown) => error))
    await expect(results[32]).resolves.toMatchObject({ code: "unavailable" })
    expect(f.call).toHaveBeenCalledTimes(1)
    f.linking.close(); release()
    await Promise.all(results)
    expect(f.call).toHaveBeenCalledTimes(1)
  })
})
