// Host settings that `handoff-daemon config` can show and change. Each one
// knows how to parse a CLI value and format the stored value.

import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import { formatModelSpec, parseModelSpec, type ModelSelection } from "@handoff/shared"
import { defaultConfig, type DaemonConfig } from "./config.js"

type Key =
  | "model"
  | "leadModels"
  | "subagentModels"
  | "runtimeMode"
  | "interactionMode"
  | "branchPrefix"
  | "instructions"
  | "promptTranscriptChars"
  | "concurrency"
  | "jobTimeoutMinutes"
  | "reposDir"
  | "jobsDir"

interface Setting {
  description: string
  parse(value: string): unknown | Promise<unknown>
  format(value: unknown): string
  /** List settings support `config add` / `config remove`. */
  list?: true
}

const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const
const INTERACTION_MODES = ["default", "plan"] as const

const model = (allowNone: string): Setting => ({
  description: "",
  parse: (v) => (v === "none" || v === "default" ? null : parseModelSpec(v)),
  format: (v) => (v ? formatModelSpec(v as ModelSelection) : allowNone),
})
const integer = (min: number): Pick<Setting, "parse" | "format"> => ({
  parse(v) {
    const n = Number(v)
    if (!Number.isInteger(n) || n < min) throw new Error(`expected an integer >= ${min}`)
    return n
  },
  format: String,
})
const oneOf = (values: readonly string[]): Pick<Setting, "parse" | "format"> => ({
  parse(v) {
    if (!values.includes(v)) throw new Error(`expected one of: ${values.join(", ")}`)
    return v
  },
  format: String,
})
const path: Pick<Setting, "parse" | "format"> = { parse: (v) => resolve(v.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")), format: String }

const modelList: Pick<Setting, "parse" | "format" | "list"> = {
  parse: (v) => (v === "none" ? [] : v.split(/[\s,]+/).filter(Boolean).map(parseModelSpec)),
  format: (v) => ((v as ModelSelection[]).length ? (v as ModelSelection[]).map(formatModelSpec).join(", ") : "(none)"),
  list: true,
}

export const SETTINGS: Record<Key, Setting> = {
  model: { ...model("default (T3's default for the project)"), description: "Default lead model: <provider>/<model>[:option=value,...], or 'default'. See `handoff-daemon models`." },
  leadModels: { ...modelList, description: "Other models a handoff may choose as lead, with --model or by naming one in the request." },
  subagentModels: { ...modelList, description: "Models the agent may delegate subtasks to (T3 delegate_task). Named in a request, they're used for the steps they're named for." },
  runtimeMode: { ...oneOf(RUNTIME_MODES), description: "T3 runtime mode. Anything below full-access makes the agent wait for approvals, which reach the client as questions." },
  interactionMode: { ...oneOf(INTERACTION_MODES), description: "T3 interaction mode: default, or plan (the agent plans instead of editing)." },
  branchPrefix: {
    description: "Prefix for the branch each handoff works on, e.g. handoff/ or ai/.",
    parse(v) {
      if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?$/.test(v) || v.includes("..")) throw new Error("not a valid branch prefix")
      return v.endsWith("/") ? v : `${v}/`
    },
    format: String,
  },
  instructions: {
    description: "Extra instructions appended to every handoff prompt. Use @path to read them from a file.",
    parse: async (v) => (v.startsWith("@") ? (await readFile(path.parse(v.slice(1)) as string, "utf8")).trim() : v),
    format: (v) => (v ? JSON.stringify(v) : "(none)"),
  },
  promptTranscriptChars: { ...integer(0), description: "Characters of the session transcript included inline in the prompt; the full transcript is always in a file." },
  concurrency: { ...integer(1), description: "Handoffs run at the same time." },
  jobTimeoutMinutes: { ...integer(1), description: "Interrupt a handoff thread after this many minutes and return what it has." },
  reposDir: { ...path, description: "Where repository mirrors live (each is a T3 project)." },
  jobsDir: { ...path, description: "Per-handoff scratch files." },
}

export function isSettingKey(key: string): key is Key {
  return Object.hasOwn(SETTINGS, key)
}

export function describeSettings(config: DaemonConfig): string {
  const settings = (Object.keys(SETTINGS) as Key[]).map(
    (key) => `${key.padEnd(22)} ${SETTINGS[key].format(config[key])}\n${"".padEnd(23)}${SETTINGS[key].description}`,
  )
  const aliases = Object.entries(config.aliases).map(([name, spec]) => `  ${name} → ${spec}`)
  return [
    ...settings,
    `aliases${"".padEnd(16)}${aliases.length ? "\n" + aliases.join("\n") : "(none)"}`,
    `${"".padEnd(23)}Extra model names (config set alias.<name> <spec>). Short names like "opus" or "6.1 sol" work without this.`,
  ].join("\n")
}

export async function applySetting(config: DaemonConfig, key: Key, value: string | undefined): Promise<DaemonConfig> {
  const next = value === undefined ? defaultConfig()[key] : await SETTINGS[key].parse(value)
  return { ...config, [key]: next }
}

/** `config add|remove <listKey> <spec...>` */
export function editList(config: DaemonConfig, key: Key, action: "add" | "remove", value: string): DaemonConfig {
  const setting = SETTINGS[key]
  if (!setting.list) throw new Error(`${key} isn't a list; use config set`)
  const current = config[key] as ModelSelection[]
  const items = setting.parse(value) as ModelSelection[]
  const same = (a: ModelSelection, b: ModelSelection) => a.instanceId === b.instanceId && a.model === b.model
  const next = action === "add" ? [...current.filter((c) => !items.some((i) => same(c, i))), ...items] : current.filter((c) => !items.some((i) => same(c, i)))
  return { ...config, [key]: next }
}

/** `config set alias.<name> <spec>` / `config unset alias.<name>` */
export function setAlias(config: DaemonConfig, name: string, spec: string | undefined): DaemonConfig {
  const aliases = { ...config.aliases }
  if (spec === undefined) delete aliases[name]
  else aliases[name] = formatModelSpec(parseModelSpec(spec))
  return { ...config, aliases }
}
