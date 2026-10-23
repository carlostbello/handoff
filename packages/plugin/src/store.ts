// Device config and job state live in plain files (not ctx.storage) so every
// opencode location/plugin instance on this machine shares one view, and state
// survives reinstalling the plugin.

import { mkdir, readFile, rename, writeFile, rm, open as openFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { HandoffBrief, InputSpec, KeyPair, RefusedInput } from "@handoff/shared"

const BASE_CONFIG_DIR = process.env.HANDOFF_CONFIG_DIR ?? join(homedir(), ".config", "handoff")
const BASE_STATE_DIR = process.env.HANDOFF_STATE_DIR ?? join(homedir(), ".local", "state", "handoff")
let STATE_DIR = BASE_STATE_DIR
export let DEVICE_CONFIG = join(BASE_CONFIG_DIR, "device.json")
export let CLIENT_SETTINGS = join(BASE_CONFIG_DIR, "client.json")
export let DEVICE_STATE = join(BASE_STATE_DIR, "device-state.json")
export let WORK_DIR = join(BASE_STATE_DIR, "work")
let LOCK = join(BASE_STATE_DIR, "poller.lock")

/**
 * Keep a client's pairing, settings and jobs in their own subfolder (e.g. `kilo`), so it is a
 * separate device to the host and never picks up another client's results. Call before any other use.
 */
export function useNamespace(name: string): void {
  const config = join(BASE_CONFIG_DIR, name)
  STATE_DIR = join(BASE_STATE_DIR, name)
  DEVICE_CONFIG = join(config, "device.json")
  CLIENT_SETTINGS = join(config, "client.json")
  DEVICE_STATE = join(STATE_DIR, "device-state.json")
  WORK_DIR = join(STATE_DIR, "work")
  LOCK = join(STATE_DIR, "poller.lock")
}

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
  /** How many times in a row the local agent may follow up a blocked handoff on its own. */
  autoFollowUps: number
}

export const DEFAULT_SETTINGS: ClientSettings = { apply: "auto", resume: true, transcriptChars: 120_000, brief: true, autoFollowUps: 2 }

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
  /** Extra material asked for with the handoff (brief or the agent's `handoff` call). */
  inputs?: InputSpec[]
  /** What went with the handoff beyond the snapshot, for status and the agent. */
  sent?: { inputs: string[]; refused: RefusedInput[]; skipped: string[] }
  /** Material for the host agent: requested by it, or sent from here while it works. */
  inputRequests?: InputRequest[]
  /** Result outcome, once applied. */
  outcome?: "succeeded" | "failed" | "blocked"
}

export interface InputRequest {
  /** Our id for `/handoff approve`. */
  id: string
  /** The host agent's request id, when it asked. */
  requestId?: string
  inputs: InputSpec[]
  /** The agent's note (from the host) or a message for it (from here). */
  note?: string
  message?: string
  /** "failed": couldn't reach the relay (retried). "rejected": the host couldn't use it. */
  state: "awaiting-approval" | "sending" | "sent" | "received" | "failed" | "rejected"
  /** Approved by the user, for retries. */
  approved?: boolean
  refuseReason?: string
  deliveryJobId?: string
  detail?: string
  createdAt: number
}

export interface DeviceState {
  eventCursor: number
  jobs: Record<string, DeviceJob>
  repos: Record<string, { id: string; knownCommit: string | null }>
  /** Delivery jobs (inputs sent to a running handoff) -> the handoff they belong to. */
  deliveries?: Record<string, string>
  /** Per session: blocked results in a row, which bounds automatic follow-ups. */
  blockedRounds?: Record<string, number>
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
