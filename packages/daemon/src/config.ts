import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { KeyPair, ModelSelection } from "@handoff/shared"

export const CONFIG_DIR = process.env.HANDOFF_CONFIG_DIR ?? join(homedir(), ".config", "handoff")
export const STATE_DIR = process.env.HANDOFF_STATE_DIR ?? join(homedir(), ".local", "state", "handoff")
export const CONFIG_PATH = join(CONFIG_DIR, "daemon.json")
export const STATE_PATH = join(STATE_DIR, "daemon-state.json")
/** Device keys confirmed at pairing. The relay's copy is never trusted. */
export const DEVICES_PATH = join(CONFIG_DIR, "devices.json")

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access"
export type InteractionMode = "default" | "plan"

export interface DaemonConfig {
  relayUrl: string
  hostToken: string
  /** Extra headers for the relay, e.g. Cloudflare Access service-token headers. */
  relayHeaders?: Record<string, string>
  keys: KeyPair
  /** Parent folder for project folders, one per client repository; each is a T3 project. */
  reposDir: string
  /** Per-job scratch: decrypted bundles, transcripts. */
  jobsDir: string
  t3: {
    /** Path to T3's server-runtime.json; the MCP origin is read from it on every connect. */
    runtimeFile: string
    /** Override the origin instead of reading runtimeFile. */
    origin?: string
    accessToken?: string
    clientId?: string
    tokenExpiresAt?: number
  }
  // ----- agent settings (see settings.ts; `handoff-daemon config`) -----
  /** Default lead model for handoff threads; null uses T3's default for the project. */
  model: ModelSelection | null
  /** Other models a handoff may pick as its lead (by --model or by naming one in the request). */
  leadModels: ModelSelection[]
  /** Models the agent may delegate subtasks to with T3's delegate_task. */
  subagentModels: ModelSelection[]
  /** Extra names for models, e.g. { "big brain": "claudeAgent/claude-opus-5-5" }. Short names are derived automatically. */
  aliases: Record<string, string>
  runtimeMode: RuntimeMode
  interactionMode: InteractionMode
  /** Prefix for the branch each handoff works on. */
  branchPrefix: string
  /** Extra instructions appended to every handoff prompt. */
  instructions: string
  /** Without a brief, how much of the latest exchange goes inline in the prompt; the full transcript is a file. */
  promptTranscriptChars: number
  concurrency: number
  /** Give up on a T3 thread after this long. */
  jobTimeoutMinutes: number
}

export function defaultConfig(): Omit<DaemonConfig, "relayUrl" | "hostToken" | "keys"> {
  return {
    // One folder per client repository, named after the project: ~/handoff/<name>.
    reposDir: join(homedir(), "handoff"),
    jobsDir: join(STATE_DIR, "jobs"),
    t3: { runtimeFile: join(homedir(), ".t3", "userdata", "server-runtime.json") },
    model: null,
    leadModels: [],
    subagentModels: [],
    aliases: {},
    runtimeMode: "full-access",
    interactionMode: "default",
    branchPrefix: "handoff/",
    instructions: "",
    promptTranscriptChars: 4_000,
    concurrency: 2,
    jobTimeoutMinutes: 240,
  }
}

export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode })
  await chmod(tmp, mode)
  await rename(tmp, path)
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

export async function loadConfig(): Promise<DaemonConfig> {
  const config = await readJson<DaemonConfig>(CONFIG_PATH)
  if (!config) throw new Error(`No config at ${CONFIG_PATH}. Run: handoff-daemon init --relay <url> --host-token <token>`)
  return { ...defaultConfig(), ...config, t3: { ...defaultConfig().t3, ...config.t3 } }
}

export async function saveConfig(config: DaemonConfig): Promise<void> {
  await writeJsonAtomic(CONFIG_PATH, config)
}

export interface PinnedDevice {
  name: string
  publicKey: string
  fingerprint: string
  pairedAt: number
}

export async function loadDevices(): Promise<Record<string, PinnedDevice>> {
  return (await readJson<Record<string, PinnedDevice>>(DEVICES_PATH)) ?? {}
}

export async function saveDevices(devices: Record<string, PinnedDevice>): Promise<void> {
  await writeJsonAtomic(DEVICES_PATH, devices)
}
