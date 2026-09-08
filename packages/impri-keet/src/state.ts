import { mkdir, open, readFile, rename, stat, type FileHandle } from "node:fs/promises"
import path from "node:path"
import { tryLock, unlock } from "fs-native-extensions"
import type { KeetMessageId } from "@lamplitisles/keet-integration-core"
import { actionId, actionStatus, httpBase, type ActionStatus } from "./impri.js"

export const MAX_ACTIVE_REQUESTS = 512

export interface ApprovalMessage {
  text: string
  messageId: KeetMessageId | null
  notice: ActionStatus | "conflict" | null
}

export interface BotState {
  baseUrl: string
  identityId: string
  dmId: string
  requests: Record<string, ApprovalMessage>
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bot state")
  return value as Record<string, unknown>
}

function nativeId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("Invalid bot destination")
  return value
}

export function validateState(raw: unknown): BotState {
  const state = object(raw)
  const requests = object(state.requests)
  if (Object.keys(requests).length > MAX_ACTIVE_REQUESTS) throw new Error("Bot state exceeds active-request capacity")
  const parsed: BotState = {
    baseUrl: httpBase(state.baseUrl), identityId: nativeId(state.identityId), dmId: nativeId(state.dmId), requests: {},
  }
  for (const [id, value] of Object.entries(requests)) {
    actionId(id)
    const item = object(value)
    if (typeof item.text !== "string" || !item.text || item.text.length > 16_000) throw new Error("Invalid approval message")
    let messageId: KeetMessageId | null = null
    if (item.messageId !== null) {
      const message = object(item.messageId)
      const deviceId = nativeId(message.deviceId)
      if (!Number.isSafeInteger(message.seq) || (message.seq as number) < 0) throw new Error("Invalid approval message ID")
      messageId = { deviceId, seq: message.seq as number }
    }
    const notice = item.notice === null || item.notice === "conflict" ? item.notice : actionStatus(item.notice)
    parsed.requests[id] = { text: item.text, messageId, notice }
  }
  return parsed
}

/** One process owns the state and identity across every sidecar reconnect. */
export class BotStore {
  #state: BotState | null
  #lock: FileHandle | null
  readonly #directory: string

  private constructor(directory: string, lock: FileHandle, state: BotState | null) {
    this.#directory = directory
    this.#lock = lock
    this.#state = state
  }

  static async open(directory: string): Promise<BotStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const lock = await open(path.join(directory, ".impri-keet.lock"), "a+", 0o600)
    try {
      if (!tryLock(lock.fd)) throw new Error("Another Impri Keet process owns this data directory")
      const file = path.join(directory, "state.json")
      let state: BotState | null = null
      try {
        if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error("Bot state is too large")
        state = validateState(JSON.parse(await readFile(file, "utf8")))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      return new BotStore(directory, lock, state)
    } catch (error) {
      await lock.close()
      throw error
    }
  }

  snapshot(): BotState | null { return this.#state ? structuredClone(this.#state) : null }

  async bind(baseUrl: string, identityId: string, dmId: string): Promise<void> {
    if (this.#state) {
      if (this.#state.baseUrl !== baseUrl || this.#state.identityId !== identityId || this.#state.dmId !== dmId) {
        throw new Error("Bot state belongs to a different Impri instance, identity, or DM; use a separate data directory")
      }
      return
    }
    await this.commit(validateState({ baseUrl, identityId, dmId, requests: {} }))
  }

  async put(id: string, message: ApprovalMessage): Promise<void> {
    const state = this.snapshot()
    if (!state) throw new Error("Run Impri Keet setup first")
    state.requests[actionId(id)] = message
    await this.commit(validateState(state))
  }

  async remove(id: string): Promise<void> {
    const state = this.snapshot()
    if (!state) throw new Error("Run Impri Keet setup first")
    delete state.requests[id]
    await this.commit(state)
  }

  async close(): Promise<void> {
    const lock = this.#lock
    this.#lock = null
    if (!lock) return
    try { unlock(lock.fd) } finally { await lock.close() }
  }

  private async commit(state: BotState): Promise<void> {
    if (!this.#lock) throw new Error("Bot store is closed")
    const temporary = path.join(this.#directory, "state.json.tmp")
    const file = await open(temporary, "w", 0o600)
    try {
      await file.chmod(0o600)
      await file.writeFile(JSON.stringify(state) + "\n", "utf8")
      await file.sync()
    } finally { await file.close() }
    await rename(temporary, path.join(this.#directory, "state.json"))
    const directory = await open(this.#directory, "r")
    try { await directory.sync() } finally { await directory.close() }
    this.#state = state
  }
}
