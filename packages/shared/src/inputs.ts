// Validation for input specs, shared by the client (brief, agent requests) and
// the host (request files the agent writes). Specs come from models, so be strict.

import type { InputSpec } from "./protocol.js"

export const INPUT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
/** Ref inside a delivery bundle: refs/handoff/<job id>/input/<name>. */
export const INPUT_BUNDLE_REF = /^refs\/handoff\/[0-9A-Z]{26}\/input\/[a-z0-9][a-z0-9-]{0,39}$/
export const MAX_INPUTS = 10

/** A clean spec, or throws with a reason a model can act on. */
export function normalizeInputSpec(raw: unknown): InputSpec {
  if (!raw || typeof raw !== "object") throw new Error("each input must be an object")
  const v = raw as Record<string, unknown>
  const str = (k: string): string | undefined => {
    if (v[k] === undefined || v[k] === null || v[k] === "") return undefined
    if (typeof v[k] !== "string") throw new Error(`"${k}" must be a string`)
    return (v[k] as string).trim() || undefined
  }
  const name = str("name")?.toLowerCase()
  if (!name || !INPUT_NAME.test(name)) throw new Error(`"name" must be 1-40 lowercase letters, digits or hyphens (got ${JSON.stringify(v.name)})`)
  const ref = str("ref")
  if (ref && (ref.startsWith("-") || /[\s~^:?*[\\]|\.\./.test(ref))) throw new Error(`input ${name}: "${ref}" isn't a valid ref`)
  const mode = str("mode") ?? "source"
  if (mode !== "source" && mode !== "history") throw new Error(`input ${name}: "mode" is "source" or "history"`)
  if (mode === "history" && !ref) throw new Error(`input ${name}: "history" needs a "ref"`)
  const paths = v.paths === undefined || v.paths === null ? [] : v.paths
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) throw new Error(`input ${name}: "paths" must be a list of strings`)
  const clean = (paths as string[]).map((p) => p.trim().replace(/^\.\/+/, "").replace(/\/+$/, "")).filter((p) => p && p !== ".")
  for (const p of clean) {
    if (p.startsWith("/") || p.split("/").includes("..") || p.startsWith(":")) throw new Error(`input ${name}: path "${p}" must be relative, without ".."`)
  }
  if (mode === "history" && clean.length) throw new Error(`input ${name}: "paths" only work with "source" mode`)
  const repo = str("repo")
  const reason = str("reason")?.slice(0, 500)
  return { name, ...(repo ? { repo } : {}), ...(ref ? { ref } : {}), ...(clean.length ? { paths: clean.slice(0, 50) } : {}), mode, ...(reason ? { reason } : {}) }
}

/** A list of specs with unique names; accepts `{ inputs: [...] }`, a list, or a single spec. */
export function normalizeInputList(raw: unknown): InputSpec[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { inputs?: unknown }).inputs) ? (raw as { inputs: unknown[] }).inputs : [raw]
  if (!list.length) throw new Error("no inputs listed")
  if (list.length > MAX_INPUTS) throw new Error(`at most ${MAX_INPUTS} inputs per request`)
  const specs = list.map(normalizeInputSpec)
  const names = new Set<string>()
  for (const s of specs) {
    if (names.has(s.name)) throw new Error(`input name "${s.name}" is used twice`)
    names.add(s.name)
  }
  return specs
}

/** One line describing a spec, for people. */
export function describeInputSpec(s: InputSpec): string {
  const what = s.ref ? `\`${s.ref}\`${s.mode === "history" ? " with history" : ""}` : "the current files"
  const where = s.repo ? ` of \`${s.repo}\`` : ""
  const only = s.paths?.length ? ` (only ${s.paths.map((p) => `\`${p}\``).join(", ")})` : ""
  return `**${s.name}**: ${what}${where}${only}${s.reason ? `. Reason: ${s.reason}` : ""}`
}
