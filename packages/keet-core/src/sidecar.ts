import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, open, readFile, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { tryLock, unlock } from 'fs-native-extensions'
import TinyBufferRPC from 'tiny-buffer-rpc'
import any from 'tiny-buffer-rpc/any.js'
import {
  RPC_METHODS,
  type RpcMethodName,
  type RpcStreamMethodName,
} from './rpc-methods.js'
import {
  KEET_COMPATIBILITY,
  KEET_NATIVE_ADDON_COUNT,
  validateKeetCompatibility,
} from './types.js'

export interface KeetSidecarLog {
  event:
    | 'sidecar.starting'
    | 'sidecar.ready'
    | 'sidecar.worker-output-discarded'
    | 'sidecar.stopping'
    | 'sidecar.stopped'
  level: 'info' | 'warn'
}

export interface KeetSidecarOptions {
  executablePath: string
  bundlePath: string
  dataPath: string
  appVersion?: string
  expectedCoreVersion?: string
  expectedAbi?: number
  swarming?: boolean
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
  pairingTimeoutMs?: number
  logger?: (entry: KeetSidecarLog) => void
  /** Test/runtime admission overrides; production callers should leave these unset. */
  platform?: string
  arch?: string
  nativeAddonPaths?: readonly string[]
}

export interface KeetSidecarStatus {
  state: 'ready'
  appVersion: string
  coreVersion: string
  abi: number
  swarming: boolean
}

export type KeetSidecarTerminalReason = 'error' | 'exit'
export type KeetSidecarTerminalListener = (reason: KeetSidecarTerminalReason) => void

type RpcMethod = ReturnType<TinyBufferRPC['register']>

const LOCK_NAME = '.keet-sidecar.lock'

export class KeetSidecar {
  readonly #options: Required<
    Pick<
      KeetSidecarOptions,
      | 'appVersion'
      | 'expectedCoreVersion'
      | 'expectedAbi'
      | 'swarming'
      | 'startupTimeoutMs'
      | 'shutdownTimeoutMs'
      | 'pairingTimeoutMs'
    >
  > &
    Omit<KeetSidecarOptions, 'appVersion' | 'expectedCoreVersion' | 'expectedAbi' | 'swarming' | 'startupTimeoutMs' | 'shutdownTimeoutMs' | 'pairingTimeoutMs'>

  #child: ChildProcess | null = null
  #rpc: TinyBufferRPC | null = null
  #methods = new Map<RpcMethodName, RpcMethod>()
  #coreVersion: string | null = null
  #abi: number | null = null
  #lock: FileHandle | null = null
  #closing: Promise<void> | null = null
  #starting: Promise<void> | null = null
  #stopping: Promise<void> | null = null
  #closed = false
  #terminalReason: KeetSidecarTerminalReason | null = null
  readonly #terminalListeners = new Set<KeetSidecarTerminalListener>()
  readonly #streams = new Set<Duplex>()

  constructor(options: KeetSidecarOptions) {
    this.#options = {
      ...options,
      executablePath: path.resolve(options.executablePath),
      bundlePath: path.resolve(options.bundlePath),
      dataPath: path.resolve(options.dataPath),
      appVersion: options.appVersion ?? KEET_COMPATIBILITY.appVersion,
      expectedCoreVersion: options.expectedCoreVersion ?? KEET_COMPATIBILITY.coreVersion,
      expectedAbi: options.expectedAbi ?? KEET_COMPATIBILITY.abi,
      swarming: options.swarming ?? true,
      startupTimeoutMs: options.startupTimeoutMs ?? 60_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 20_000,
      pairingTimeoutMs: options.pairingTimeoutMs ?? 60_000,
    }
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('Keet sidecar cannot be restarted after close')
    if (this.#child || this.#starting) throw new Error('Keet sidecar is already started')
    this.#starting = this.#start()
    try { await this.#starting } finally { this.#starting = null }
  }

  async #start(): Promise<void> {
    this.#terminalReason = null
    try {
      await this.#validatePaths()
      if (this.#closed) throw new Error('Keet sidecar closed during startup')
      await this.#acquireLock()
      this.#log({ event: 'sidecar.starting', level: 'info' })
      if (this.#closed) throw new Error('Keet sidecar closed during startup')
      await this.#spawnAndBoot()
      this.#log({ event: 'sidecar.ready', level: 'info' })
    } catch (error) {
      await this.#stopProcess()
      await this.#releaseLock()
      throw error
    }
  }

  async status(): Promise<KeetSidecarStatus> {
    await this.call('getVersion', [])
    return {
      state: 'ready',
      appVersion: this.#options.appVersion,
      coreVersion: this.#coreVersion!,
      abi: this.#abi!,
      swarming: this.#options.swarming,
    }
  }

  async call(name: RpcMethodName, args: unknown[]): Promise<unknown> {
    const method = this.#methods.get(name)
    if (!this.#child || !this.#rpc || !method || !this.#coreVersion) {
      throw new Error('Keet sidecar is not ready')
    }
    return method.request(args)
  }

  /** Observe an unexpected post-ready worker connection termination. */
  onTerminal(listener: KeetSidecarTerminalListener): () => void {
    this.#terminalListeners.add(listener)
    return () => { this.#terminalListeners.delete(listener) }
  }

  subscribe(name: RpcStreamMethodName, args: unknown[]): Duplex {
    const method = this.#methods.get(name)
    if (!this.#child || !this.#rpc || !method || !this.#coreVersion) {
      throw new Error('Keet sidecar is not ready')
    }
    const stream = method.createRequestStream() as Duplex
    this.#streams.add(stream)
    stream.once('close', () => { this.#streams.delete(stream) })
    // Tiny-buffer-rpc reports transport teardown through stream errors. Core
    // observes the sidecar terminal event and converts it to a safe reason;
    // this listener prevents an unconsumed raw stream from becoming an
    // unhandled EventEmitter error while that conversion happens.
    stream.on('error', () => undefined)
    try {
      stream.write(args)
    } catch (error) {
      this.#streams.delete(stream)
      try { stream.destroy() } catch { /* already destroyed */ }
      throw error
    }
    return stream
  }

  /**
   * Open a response stream for one request tuple and half-close its request
   * side immediately.  Chat subscriptions intentionally stay open through
   * `subscribe`; file reads use this finite request/response lifecycle so the
   * worker can begin producing bytes after it observes STREAM_END.
   */
  requestStream(name: RpcStreamMethodName, args: unknown[]): Duplex {
    const stream = this.subscribe(name, args)
    try {
      stream.end()
    } catch (error) {
      try { stream.destroy() } catch { /* already destroyed */ }
      throw error
    }
    return stream
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = (async () => {
        this.#closed = true
        this.#log({ event: 'sidecar.stopping', level: 'info' })
        await this.#stopProcess()
        await this.#starting?.catch(() => undefined)
        await this.#releaseLock()
        this.#log({ event: 'sidecar.stopped', level: 'info' })
      })()
    }
    return this.#closing
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  async #validatePaths(): Promise<void> {
    validateKeetCompatibility(this.#options)
    if (this.#options.nativeAddonPaths && this.#options.nativeAddonPaths.length !== KEET_NATIVE_ADDON_COUNT) {
      throw new Error('Keet native-addon closure is incomplete')
    }
    try {
      await access(this.#options.executablePath)
    } catch {
      throw new Error('Keet runtime executable is unavailable')
    }
    try {
      const bundle = await stat(this.#options.bundlePath)
      if (!bundle.isFile()) throw new Error('not-file')
    } catch {
      throw new Error('Keet worker bundle is unavailable')
    }
    await this.#validateNativeClosure()
    try {
      await mkdir(this.#options.dataPath, { recursive: true })
    } catch {
      throw new Error('Keet identity directory is unavailable')
    }
  }

  /**
   * Validate the manifest-selected native closure when the supplied bundle is
   * a real bundled worker. Test fixtures are ordinary scripts and have no
   * bundle header, so they intentionally skip this runtime-only check.
   */
  async #validateNativeClosure(): Promise<void> {
    if (this.#options.nativeAddonPaths && this.#options.nativeAddonPaths.length !== KEET_NATIVE_ADDON_COUNT) {
      throw new Error('Keet native-addon closure is incomplete')
    }
    let contents: Buffer
    try {
      contents = await readFile(this.#options.bundlePath)
    } catch {
      throw new Error('Keet worker bundle is unavailable')
    }
    const newline = contents.indexOf(0x0a)
    if (newline < 1) return
    const header = contents.subarray(0, newline).toString('ascii').trim()
    // Test fixtures are ordinary scripts (usually beginning with a shebang),
    // while an official worker begins with an all-digit manifest span. Once a
    // bundle advertises that header, malformed framing is a hard admission
    // failure rather than an excuse to skip the native-closure check.
    if (!/^\d+$/.test(header)) return
    const span = Number(header)
    if (!Number.isSafeInteger(span) || span <= 1 || newline + span > contents.length) {
      throw new Error('Keet native-addon closure is incomplete')
    }
    let manifest: unknown
    try {
      manifest = JSON.parse(contents.subarray(newline + 1, newline + span).toString('utf8').trimEnd())
    } catch {
      throw new Error('Keet native-addon closure is incomplete')
    }
    const addons = manifest && typeof manifest === 'object' && Array.isArray((manifest as { addons?: unknown }).addons)
      ? (manifest as { addons: unknown[] }).addons
      : undefined
    if (!addons) throw new Error('Keet native-addon closure is incomplete')
    if (addons.length !== KEET_NATIVE_ADDON_COUNT || addons.some((addon) => typeof addon !== 'string' || !addon.startsWith('/node_modules/'))) {
      throw new Error('Keet native-addon closure is incomplete')
    }
    try {
      const bundleDirectory = path.dirname(this.#options.bundlePath)
      const paths = addons.map((addon) => path.resolve(bundleDirectory, `.${addon as string}`))
      if (paths.some((candidate) => {
        const relative = path.relative(bundleDirectory, candidate)
        return !relative || relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith(`node_modules${path.sep}`)
      })) throw new Error('unsafe-addon-path')
      await Promise.all(paths.map((candidate) => access(candidate)))
    } catch {
      throw new Error('Keet native-addon closure is incomplete')
    }
  }

  async #acquireLock(): Promise<void> {
    const lockPath = path.join(this.#options.dataPath, LOCK_NAME)
    let lock: FileHandle | null = null
    try {
      lock = await open(lockPath, 'a+', 0o600)
      if (!tryLock(lock.fd)) {
        await lock.close()
        lock = null
        throw new Error('Keet data directory is already owned by another process')
      }
      await lock.chmod(0o600)
      this.#lock = lock
    } catch (error) {
      // The stable lock file is persistent state. Never remove it when
      // acquisition or startup fails; kernel ownership lives on the open
      // descriptor and is released by unlock/close or process death.
      if (lock && lock !== this.#lock) await lock.close().catch(() => undefined)
      throw error
    }
  }

  async #spawnAndBoot(): Promise<void> {
    const child = spawn(
      this.#options.executablePath,
      [
        this.#options.bundlePath,
        this.#options.dataPath,
        'false',
        'false',
        String(this.#options.swarming),
        'undefined',
        'undefined',
        'info',
        'false',
        'production',
        this.#options.appVersion,
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] },
    )
    this.#child = child
    let postReady = false
    child.on('error', () => { if (postReady) this.#handleTerminal('error') })
    child.on('exit', () => { if (postReady) this.#handleTerminal('exit') })

    const ipc = child.stdio[3] as Duplex | null
    if (!ipc || !child.stdout || !child.stderr) {
      throw new Error('Keet sidecar did not expose required process streams')
    }
    ipc.on('error', () => { if (postReady) this.#handleTerminal('error') })

    const rpc = new TinyBufferRPC((message) => {
      const frame = Buffer.allocUnsafe(message.length + 4)
      frame.writeUInt32LE(message.length, 0)
      message.copy(frame, 4)
      ipc.write(frame)
    })
    this.#rpc = rpc
    for (const [name, opcode] of Object.entries(RPC_METHODS) as [RpcMethodName, number][]) {
      this.#methods.set(name, rpc.register(opcode, { request: any, response: any }))
    }

    let incoming = Buffer.alloc(0)
    ipc.on('data', (chunk: Buffer) => {
      incoming = Buffer.concat([incoming, chunk])
      while (incoming.length >= 4) {
        const length = incoming.readUInt32LE(0)
        if (incoming.length < length + 4) break
        rpc.recv(incoming.subarray(4, length + 4))
        incoming = incoming.subarray(length + 4)
      }
    })

    let workerOutput = ''
    let discardedOutput = false
    const noteDiscardedOutput = () => {
      if (!discardedOutput) {
        discardedOutput = true
        this.#log({ event: 'sidecar.worker-output-discarded', level: 'warn' })
      }
    }
    child.stderr.on('data', noteDiscardedOutput)

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Keet sidecar startup timed out')),
        this.#options.startupTimeoutMs,
      )
      const finish = (fn: () => void) => {
        clearTimeout(timer)
        fn()
      }
      child.once('error', () => finish(() => reject(new Error('Keet sidecar failed to start'))))
      child.once('exit', () => finish(() => reject(new Error('Keet sidecar exited before becoming ready'))))
      child.stdout!.on('data', (chunk: Buffer) => {
        noteDiscardedOutput()
        workerOutput = (workerOutput + chunk.toString('utf8')).slice(-4096)
        if (workerOutput.includes(`Keet core worker started on ${this.#options.dataPath}`)) {
          finish(resolve)
        }
      })
    })

    await ready
    await this.#methods.get('swarmReady')!.request([])
    const version = parseVersion(await this.#methods.get('getVersion')!.request([]))
    try {
      validateKeetCompatibility({
        appVersion: this.#options.appVersion,
        expectedCoreVersion: version.coreVersion,
        expectedAbi: version.abi,
        ...(this.#options.platform !== undefined ? { platform: this.#options.platform } : {}),
        ...(this.#options.arch !== undefined ? { arch: this.#options.arch } : {}),
      })
    } catch {
      throw new Error('Unsupported Keet core compatibility tuple')
    }
    await this.#methods.get('boot')!.request([])
    this.#coreVersion = version.coreVersion
    this.#abi = version.abi
    postReady = true
  }

  #stopProcess(): Promise<void> {
    if (!this.#stopping) {
      this.#stopping = this.#stopChild().finally(() => { this.#stopping = null })
    }
    return this.#stopping
  }

  async #stopChild(): Promise<void> {
    const child = this.#child
    this.#child = null
    this.#coreVersion = null
    this.#abi = null
    this.#methods.clear()
    for (const stream of this.#streams) {
      try { stream.destroy() } catch { /* already destroyed */ }
    }
    this.#streams.clear()
    this.#rpc?.destroy()
    this.#rpc = null
    if (!child) return

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const ipc = child.stdio[3] as Duplex | null
    if (ipc && !ipc.destroyed) ipc.end()
    if (child.exitCode !== null || child.signalCode !== null) return

    if (await settleWithin(exited, this.#options.shutdownTimeoutMs)) return
    child.kill('SIGTERM')
    if (await settleWithin(exited, 2_000)) return
    child.kill('SIGKILL')
    await exited
  }

  async #releaseLock(): Promise<void> {
    const lock = this.#lock
    this.#lock = null
    if (!lock) return
    try {
      unlock(lock.fd)
    } finally {
      await lock.close()
    }
  }

  #log(entry: KeetSidecarLog): void {
    try {
      this.#options.logger?.(entry)
    } catch {
      // Logging is observational and must never prevent lock cleanup.
    }
  }

  #handleTerminal(reason: KeetSidecarTerminalReason): void {
    if (this.#closed || this.#closing || this.#terminalReason) return
    this.#terminalReason = reason
    this.#coreVersion = null
    this.#abi = null
    this.#methods.clear()
    const error = new Error('Keet sidecar connection failed')
    const rpc = this.#rpc
    this.#rpc = null
    // Mark RPC methods destroyed before closing streams so tiny-buffer-rpc
    // does not try to write a close frame onto an already-dead IPC pipe.
    rpc?.destroy()
    for (const stream of this.#streams) {
      try { stream.destroy(error) } catch { /* already destroyed */ }
    }
    this.#streams.clear()
    for (const listener of this.#terminalListeners) {
      try { listener(reason) } catch { /* observers never affect teardown */ }
    }
  }
}

async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const settled = await Promise.race([promise.then(() => true), timedOut])
  if (timer) clearTimeout(timer)
  return settled
}

function parseVersion(value: unknown): { coreVersion: string; abi: number } {
  if (!value || typeof value !== 'object') {
    throw new Error('Keet core returned an invalid compatibility tuple')
  }
  const record = value as {
    modules?: Record<string, unknown>
    abi?: { production?: unknown }
  }
  const coreVersion = record.modules?.['keet-core']
  const abi = record.abi?.production
  if (typeof coreVersion !== 'string' || typeof abi !== 'number') {
    throw new Error('Keet core returned an invalid compatibility tuple')
  }
  return { coreVersion, abi }
}
