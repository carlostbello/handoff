// Device config and job state live in plain files (not ctx.storage) so every
// opencode location/plugin instance on this machine shares one view, and state
// survives reinstalling the plugin.

import { mkdir, readFile, rename, writeFile, rm, open as openFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { HandoffBrief, KeyPair } from "@handoff/shared"

const CONFIG_DIR = process.env.HANDOFF_CONFIG_DIR ?? join(homedir(), ".config", "handoff")
const STATE_DIR = process.env.HANDOFF_STATE_DIR ?? join(homedir(), ".local", "state", "handoff")
export const DEVICE_CONFIG = join(CONFIG_DIR, "device.json")
export const CLIENT_SETTINGS = join(CONFIG_DIR, "client.json")
export const DEVICE_STATE = join(STATE_DIR, "device-state.json")
export const WORK_DIR = join(STATE_DIR, "work")
const LOCK = join(STATE_DIR, "poller.lock")

export interface DeviceConfig {
  relayUrl: string
  token: string
  deviceId: string
  keys: KeyPair
  hostPublicKey: string
  /** Extra relay headers, e.g. Cloudflare Access service token. */
  headers?: Record<string, string>
}

/** Client preferences (`/handoff config`). Kept apart from device.json so re-pairing keeps them. */
export interface ClientSettings {
  /** Lead model (short name or spec) sent with every handoff; unset lets the host decide. */
  model?: string
  /** auto: fast-forward your branch when it hasn't moved. branch: always leave results on their own branch. */
  apply: "auto" | "branch"
  /** Let the local agent take a turn when a result arrives. */
  resume: boolean
  /** Maximum characters of session transcript sent with a handoff. */
  transcriptChars: number
  /** Have this session's model write a task brief for the host agent before handing off. */
  brief: boolean
}

export const DEFAULT_SETTINGS: ClientSettings = { apply: "auto", resume: true, transcriptChars: 120_000, brief: true }

export type DeviceJobPhase =
  | "packing"
  | "uploading"
  | "submitted"
  | "applying"
  | "applied"
  | "failed"
  | "cancelled"

export interface DeviceJob {
  id: string
  phase: DeviceJobPhase
  sessionID: string
  directory: string
  repoTop: string
  repoId: string
  branch: string | null
  head: string | null
  snapshot?: string
  snapshotRef?: string
  base?: string | null
  instructions: string
  model?: string
  apply?: ClientSettings["apply"]
  /** The brief this session's model wrote for the handoff. */
  brief?: HandoffBrief
  /** "host": an update the host sent from the conversation's T3 thread, not a handoff from here. */
  origin?: "handoff" | "host"
  createdAt: number
  /** When anything about this job last changed (for status displays). */
  updatedAt?: number
  lastStatus?: string
  /** After delivery: the host reported the T3 thread working again, or stopping. */
  remote?: { active: boolean; note: string; since: number }
  threadId?: string
  resultBranch?: string
  /** Set when this job replaced one that failed with needs_full_bundle. */
  retryOf?: string
  /** Open question from the host agent. */
  question?: { requestId: string; question: unknown }
}

export interface DeviceState {
  eventCursor: number
  jobs: Record<string, DeviceJob>
  repos: Record<string, { id: string; knownCommit: string | null }>
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(tmp, path)
}

export const loadConfig = () => readJson<DeviceConfig>(DEVICE_CONFIG)
export const saveConfig = (c: DeviceConfig) => writeJson(DEVICE_CONFIG, c)
export const loadSettings = async (): Promise<ClientSettings> => ({ ...DEFAULT_SETTINGS, ...(await readJson<Partial<ClientSettings>>(CLIENT_SETTINGS)) })
export const saveSettings = (s: ClientSettings) => writeJson(CLIENT_SETTINGS, s)

// All state mutations go through this queue so concurrent writers in one process don't clobber each other.
let chain: Promise<unknown> = Promise.resolve()

export async function loadState(): Promise<DeviceState> {
  return (await readJson<DeviceState>(DEVICE_STATE)) ?? { eventCursor: 0, jobs: {}, repos: {} }
}

export function mutateState<T>(fn: (s: DeviceState) => T | Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const state = await loadState()
    const out = await fn(state)
    await writeJson(DEVICE_STATE, state)
    return out
  })
  chain = next.catch(() => {})
  return next
}

export async function updateJob(id: string, patch: Partial<DeviceJob>): Promise<DeviceJob | undefined> {
  return mutateState((s) => {
    const job = s.jobs[id]
    if (!job) return undefined
    Object.assign(job, patch, { updatedAt: Date.now() })
    return { ...job }
  })
}

/**
 * Cross-process lease so only one opencode process on this machine polls the relay.
 * Returns true if this owner holds the lease after the call.
 */
export async function acquireLease(owner: string, ttlMs: number): Promise<boolean> {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
  const now = Date.now()
  const current = await readJson<{ owner: string; expires: number }>(LOCK)
  if (current && current.owner !== owner && current.expires > now) return false
  if (!current) {
    // Create exclusively to avoid two processes racing on first acquisition.
    try {
      const fh = await openFile(LOCK, "wx", 0o600)
      await fh.writeFile(JSON.stringify({ owner, expires: now + ttlMs }))
      await fh.close()
      return true
    } catch {
      return false
    }
  }
  await writeJson(LOCK, { owner, expires: now + ttlMs })
  const check = await readJson<{ owner: string }>(LOCK)
  return check?.owner === owner
}

export async function releaseLease(owner: string): Promise<void> {
  const current = await readJson<{ owner: string }>(LOCK)
  if (current?.owner === owner) await rm(LOCK, { force: true })
}
