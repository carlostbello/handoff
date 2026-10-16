// Natural-language model choice: "/handoff continue with opus, have fable and
// astra subagents review the plan, then execute with 6.1 sol".
//
// Only models allowed in the host config are recognised. Each gets short
// aliases derived from its id ("claude-opus-5-5" -> "opus", "opus 5.5", ...)
// plus any configured nicknames. The first mention outside a subagent phrase
// picks the lead model (if allowed as lead); every mention is passed to the
// agent so it can delegate each step to the model the user named.

import { formatModelSpec, parseModelSpec, type ModelSelection } from "@handoff/shared"

const VENDOR_WORDS = new Set(["claude", "gpt", "gemini", "grok"])
const SUBAGENT_CLAUSE = /\b(sub ?agents?|spawn|spin up|delegate|reviewers?)\b/

export const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")

const sameModel = (a: ModelSelection, b: ModelSelection) => a.instanceId === b.instanceId && a.model === b.model

/** Aliases for a model id, most specific first. The last one is the bare family name ("opus"). */
export function deriveAliases(selection: ModelSelection): string[] {
  const id = selection.model.split("/").pop()!.toLowerCase()
  const tokens = id.split(/[-_\s]+/).filter(Boolean)
  const nums = tokens.filter((t) => /^\d+(\.\d+)*$/.test(t))
  const words = tokens.filter((t) => !nums.includes(t))
  const familyWords = words.filter((w) => !VENDOR_WORDS.has(w))
  const family = (familyWords.length ? familyWords : words).join(" ")
  const vendor = words.filter((w) => VENDOR_WORDS.has(w)).join(" ")
  const version = nums.join(".")
  const out = [normalize(selection.model), tokens.join(" ")]
  if (version && family) {
    out.push(`${family} ${version}`, `${version} ${family}`, `${family} ${nums.join(" ")}`)
    if (vendor) out.push(`${vendor} ${family} ${version}`, `${vendor} ${version} ${family}`)
  }
  if (family) out.push(family)
  return [...new Set(out.filter(Boolean))]
}

/** The names worth showing a person: "opus" and "opus 5.5"; "sol" and "6.1 sol". */
export function displayAliases(selection: ModelSelection): string[] {
  const tokens = selection.model.split("/").pop()!.toLowerCase().split(/[-_\s]+/).filter(Boolean)
  const isNum = (t: string) => /^\d+(\.\d+)*$/.test(t)
  const short = tokens.filter((t) => !VENDOR_WORDS.has(t))
  const family = short.filter((t) => !isNum(t)).join(" ")
  const nums = short.filter(isNum)
  // Keep the id's word order: "opus 5.5" for claude-opus-5-5, "6.1 sol" for gpt-6.1-sol.
  const versionFirst = isNum(short[0] ?? "")
  const versioned = nums.length && family ? (versionFirst ? `${nums.join(".")} ${family}` : `${family} ${nums.join(".")}`) : ""
  return [...new Set([family, versioned].filter(Boolean))]
}

export interface ModelChoice {
  selection: ModelSelection
  /** What the user wrote, e.g. "6.1 sol". */
  mentionedAs: string[]
}

export interface ResolvedModels {
  lead: ModelSelection | null
  /** How the lead was chosen. */
  leadSource: "flag" | "request" | "default"
  /** Allowed subagent models, with any the request mentioned listed first. */
  subagents: ModelChoice[]
  /** Models the request mentioned (other than as the lead), in order. */
  mentioned: ModelChoice[]
}

export interface ModelPolicy {
  model: ModelSelection | null
  leadModels: ModelSelection[]
  subagentModels: ModelSelection[]
  aliases: Record<string, string>
}

export function resolveModels(policy: ModelPolicy, instructions: string, flag?: string): ResolvedModels {
  const leadSet = dedupe([...(policy.model ? [policy.model] : []), ...policy.leadModels])
  const all = dedupe([...leadSet, ...policy.subagentModels])
  const isLead = (s: ModelSelection) => leadSet.some((l) => sameModel(l, s))

  // alias -> model. Configured nicknames win; otherwise the first allowed model to claim an alias keeps it,
  // so "sol" means whichever sol model is listed first (default, then lead models, then subagent models).
  const table = new Map<string, ModelSelection>()
  for (const [name, spec] of Object.entries(policy.aliases)) table.set(normalize(name), parseModelSpec(spec))
  for (const s of all) for (const alias of deriveAliases(s)) if (!table.has(alias)) table.set(alias, s)

  const lookup = (text: string): ModelSelection | undefined => {
    // A full spec must name an allowed model; its options (e.g. :effort=high) are kept.
    const exact = text.includes("/") ? safeParse(text) : undefined
    if (exact) return all.some((s) => sameModel(s, exact)) ? exact : undefined
    return table.get(normalize(text))
  }

  let lead = policy.model
  let leadSource: ResolvedModels["leadSource"] = "default"
  if (flag) {
    const chosen = lookup(flag)
    if (!chosen || !isLead(chosen)) {
      throw Object.assign(new Error(`model "${flag}" isn't allowed as the lead model on this host. Allowed: ${leadSet.map(formatModelSpec).join(", ") || "(host default only)"}`), {
        code: "model_not_allowed",
      })
    }
    lead = chosen
    leadSource = "flag"
  }

  // Find mentions: longest aliases first, without overlaps.
  const text = normalize(instructions)
  const taken: Array<[number, number]> = []
  const hits: Array<{ start: number; alias: string; selection: ModelSelection }> = []
  for (const [alias, selection] of [...table].sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`(?<![a-z0-9.])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "g")
    for (const m of text.matchAll(re)) {
      const start = m.index!
      const end = start + alias.length
      if (taken.some(([s, e]) => start < e && end > s)) continue
      taken.push([start, end])
      hits.push({ start, alias, selection })
    }
  }
  hits.sort((a, b) => a.start - b.start)

  if (!flag) {
    const leadHit = hits.find((h) => isLead(h.selection) && !SUBAGENT_CLAUSE.test(clauseAt(text, h.start)))
    if (leadHit) {
      lead = leadHit.selection
      leadSource = "request"
      hits.splice(hits.indexOf(leadHit), 1)
    }
  }

  const mentioned: ModelChoice[] = []
  for (const h of hits) {
    const existing = mentioned.find((m) => sameModel(m.selection, h.selection))
    if (existing) existing.mentionedAs.includes(h.alias) || existing.mentionedAs.push(h.alias)
    else mentioned.push({ selection: h.selection, mentionedAs: [h.alias] })
  }
  // Mentioned models are usable as subagents even if only allowed as leads; the rest of the subagent list follows.
  const subagents = [...mentioned, ...policy.subagentModels.filter((s) => !mentioned.some((m) => sameModel(m.selection, s))).map((s) => ({ selection: s, mentionedAs: [] }))]
  return { lead, leadSource, subagents, mentioned }
}

function clauseAt(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf(",", index), text.lastIndexOf(";", index), text.lastIndexOf(".", index - 1) , text.lastIndexOf(" then ", index)) + 1
  const ends = [",", ";", ". ", " then "].map((d) => text.indexOf(d, index)).filter((i) => i >= 0)
  return text.slice(start, ends.length ? Math.min(...ends) : text.length)
}

function dedupe(list: ModelSelection[]): ModelSelection[] {
  return list.filter((s, i) => list.findIndex((t) => sameModel(s, t)) === i)
}

function safeParse(spec: string): ModelSelection | undefined {
  try {
    return parseModelSpec(spec)
  } catch {
    return undefined
  }
}

/** Human summary for the client, e.g. "lead claude-opus-5-5 (from "opus"); subagents: ...". */
export function describeResolution(r: ResolvedModels): string {
  const lead = r.lead ? formatModelSpec(r.lead) : "T3's project default"
  const how = r.leadSource === "request" ? " (named in your request)" : r.leadSource === "flag" ? " (--model)" : " (host default)"
  const mentioned = r.mentioned.map((m) => `${m.mentionedAs[0]} → ${formatModelSpec(m.selection)}`)
  return `Lead model: ${lead}${how}.${mentioned.length ? ` Models named for steps: ${mentioned.join(", ")}.` : ""}`
}
