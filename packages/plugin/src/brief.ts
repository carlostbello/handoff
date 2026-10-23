// Before handing off, the session's own model writes a brief for the host
// agent: what the user wants, what's been done, what's left. The user's words
// still travel verbatim alongside it.

import { normalizeInputSpec, type HandoffBrief, type InputSpec } from "@handoff/shared"

export function briefPrompt(instructions: string, repoName: string): string {
  const request = instructions.trim() || "(no instructions: continue the work in progress)"
  return `The user is handing this session's work off to another coding agent on another machine. That agent gets the repository (including uncommitted changes) and a raw transcript, but not your understanding of it. Write the brief it should work from.

The user's handoff request: """${request}"""
Repository: ${repoName}

Reply with ONLY a JSON object, no prose and no code fence:
{
  "title": "short imperative title, at most 60 characters",
  "slug": "two to five lowercase words joined by hyphens, for a branch name",
  "projectName": "a short, human-friendly name for this repository's project, e.g. \\"Recipe Planner\\"",
  "context": "full | reference | none",
  "files": ["repository-relative paths the agent should read first"],
  "inputs": [{ "name": "short-name", "ref": "branch, tag or commit", "repo": "absolute path, only for another repository or folder", "paths": ["only these paths"], "reason": "why it's needed" }],
  "task": "the brief, in markdown"
}

"inputs" lists what the work depends on that is NOT in the current checkout's history: another branch or commit (even one on a remote, since the other machine can't fetch), or files from another repository or folder on this machine. Each is packaged and sent with the handoff; naming a branch in the brief alone does not send its contents. Omit "ref" for the current files and "repo" for this repository. Files that look like secrets (.env, keys, credentials) are never sent. Use [] when the checkout has everything.

"context" says how much of this session the other agent should see:
- "full": it needs the conversation itself (e.g. subtle decisions, back-and-forth it must not repeat).
- "reference": the brief covers it; the transcript is only there to look things up. Prefer this.
- "none": the user wants a fresh start or asked to pass only specific things. Then put everything the agent needs into the brief, and nothing else.
Follow the user's request about what to pass on: if they ask to start over or to include only certain things, do exactly that.

The brief ("task") must stand on its own and use these sections:
## Goal: what the user wants, in one or two sentences.
## Context: what has been done in this session so far, key decisions and why, the files that matter.
## Remaining work: concrete steps, in order.
## Constraints: anything the user asked for or ruled out; conventions to follow.
## Done when: how the agent can tell it has finished, including how to verify.

Write file paths relative to the repository root, not as absolute paths on this machine. Keep the brief focused: well under 8,000 characters. Leave out tool output, file contents and anything the agent can read from the repository itself.

Keep any model names, tools and per-step instructions from the user's request exactly as written. Don't invent requirements; if something is unclear, say so in the brief.`
}

/** Keeps the thread's first message small enough for every T3 client to render. */
const MAX_TASK_CHARS = 12_000

/** Parse the model's reply; null if it isn't a usable brief. */
export function parseBrief(text: string): HandoffBrief | null {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let value: Record<string, unknown>
  try {
    value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const str = (k: string) => (typeof value[k] === "string" ? (value[k] as string).trim() : "")
  const task = str("task")
  if (task.length < 20) return null
  const title = str("title").split("\n")[0]!.slice(0, 80)
  const slug = str("slug")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  const projectName = str("projectName").split("\n")[0]!.slice(0, 60)
  const context = (["full", "reference", "none"] as const).find((c) => c === str("context")) ?? "reference"
  const files = (Array.isArray(value.files) ? value.files : [])
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0 && !f.includes(".."))
    .map((f) => f.trim().replace(/^\/+/, ""))
    .slice(0, 20)
  const inputs: InputSpec[] = []
  for (const raw of Array.isArray(value.inputs) ? value.inputs.slice(0, 10) : []) {
    try {
      const spec = normalizeInputSpec(raw)
      if (!inputs.some((i) => i.name === spec.name)) inputs.push(spec)
    } catch {
      // A malformed entry from the model; the host agent can still ask for it.
    }
  }
  return { title: title || "Handoff", slug: slug || "handoff", projectName, context, files, task: task.slice(0, MAX_TASK_CHARS), ...(inputs.length ? { inputs } : {}) }
}
