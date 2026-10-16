// The thread's first message stays small: the brief, the workspace, the rules,
// and pointers to context files the agent reads when it needs them. Long
// messages are slow and expensive, and some T3 clients can't render them.

import { formatModelSpec, type RequestManifest } from "@handoff/shared"
import type { ResolvedModels } from "./models.js"

/** Hard ceiling for a message sent to T3. */
export const MAX_PROMPT_CHARS = 16_000

export interface ContextFiles {
  /** The condensed transcript of the prior session. */
  transcript: string
  /** The brief, when the client wrote one. */
  brief?: string
}

export function buildPrompt(input: {
  manifest: RequestManifest
  branch: string
  snapshot: string
  files: ContextFiles
  models: ResolvedModels
  /** Extra instructions from the host's config. */
  instructions: string
  /** Without a brief, how much of the latest exchange to include inline. */
  excerptChars: number
}): string {
  const { manifest, branch, snapshot, files, models, instructions, excerptChars } = input
  const remotes = Object.entries(manifest.repo.remotes)
    .map(([name, url]) => `${name} → ${url}`)
    .join(", ")
  const rules = `## Rules
- Make reasonable assumptions instead of asking questions; record them in your final message. Only ask if you are truly blocked.
- Commit your work to \`${branch}\` in logical commits with clear messages. Never amend, rebase, or drop existing commits, and do not switch branches.
- Verify your work (build, tests, lint) where the project supports it.
- End with a final message for the user: what changed, how you verified it, assumptions, and follow-ups. It is sent back into their opencode session verbatim.
- The user may follow up in this thread, from opencode or here in T3. Treat each follow-up as a continuation of this work, on the same branch.${
    instructions.trim() ? `\n\n## Additional instructions\n${instructions.trim()}` : ""
  }`
  const head = `You are continuing work handed off from an opencode session on another machine (handoff job ${manifest.jobId}). The user is away from this machine; work autonomously.

## Task
`
  const tail = `

${readFirst(manifest)}## Workspace
- You are in a git worktree on branch \`${branch}\`, based on commit ${snapshot.slice(0, 12)}. That commit is the user's \`${manifest.repo.branch ?? "(detached HEAD)"}\` plus all their uncommitted work at handoff time.
- Repository: ${manifest.repo.name}${remotes ? ` (remotes for reference only: ${remotes})` : ""}. Do NOT push, and do not fetch from remotes; they may be unreachable from here.
${pathNote(manifest)}${contextNote(manifest, files)}

${rules}

${modelSection(models)}`
  return fit(head, taskSection(manifest), tail, files, excerpt(manifest, excerptChars))
}

/** A follow-up handoff from the same opencode session, sent into the existing thread. */
export function buildFollowUpPrompt(input: {
  manifest: RequestManifest
  branch: string
  snapshot: string
  files: ContextFiles
  models: ResolvedModels
}): string {
  const { manifest, branch, snapshot, files, models } = input
  const head = `Follow-up from the user's opencode session (handoff job ${manifest.jobId}).

## Task
`
  const tail = `

${readFirst(manifest)}## Workspace
- Your branch \`${branch}\` was fast-forwarded to commit ${snapshot.slice(0, 12)}: your earlier commits plus anything the user changed since, including uncommitted work.
${pathNote(manifest)}${contextNote(manifest, files)}
- Same rules as before: commit to \`${branch}\`, never amend or rebase, don't push, verify your work, and end with a final message for the user.

${modelSection(models)}`
  return fit(head, taskSection(manifest), tail, files, "")
}

/** The client's brief when it wrote one, plus the user's own words. */
function taskSection(manifest: RequestManifest): string {
  const words = manifest.instructions.trim()
  if (manifest.brief?.task.trim()) {
    return `${manifest.brief.task.trim()}${words ? `\n\nThe user's request, in their words: "${words}"` : ""}`
  }
  return words || "Continue the work in progress from the prior session, picking up exactly where it left off."
}

function readFirst(manifest: RequestManifest): string {
  const files = manifest.brief?.files ?? []
  return files.length ? `## Read first\n${files.map((f) => `- \`${f}\``).join("\n")}\n\n` : ""
}

/** Client paths in the brief or transcript mean nothing here; say where they point. */
function pathNote(manifest: RequestManifest): string {
  const dir = manifest.session.directory
  return dir ? `- Paths under \`${dir}\` (the user's machine) refer to the same place in this worktree.\n` : ""
}

function contextNote(manifest: RequestManifest, files: ContextFiles): string {
  const transcript = `\`${files.transcript}\``
  switch (manifest.brief?.context) {
    case "none":
      return "- The user asked for a fresh start: work from this brief and the repository only, not the earlier conversation."
    case "full":
      return `- Read the prior session's transcript first: ${transcript}.`
    case "reference":
      return `- The brief above is the source of truth. The prior session's transcript is at ${transcript} if you need to look something up.`
    default:
      return `- The prior session's transcript is at ${transcript}. Read it for context before starting.`
  }
}

/** Without a brief, the latest exchange inline gives the agent its bearings. */
function excerpt(manifest: RequestManifest, max: number): string {
  if (manifest.brief || max <= 0) return ""
  const t = manifest.session.transcript
  const start = t.lastIndexOf("\n### User\n")
  const latest = (start >= 0 ? t.slice(start + 1) : t).trim()
  if (!latest) return ""
  const clipped = latest.length > max ? `${latest.slice(0, max)}\n…[continues in the transcript file]` : latest
  return `## Latest exchange in the prior session\n${clipped}\n\n`
}

/**
 * Assemble within MAX_PROMPT_CHARS: drop the inline excerpt first, then shorten
 * the task and point to the full brief file.
 */
function fit(head: string, task: string, tail: string, files: ContextFiles, inline: string): string {
  const build = (t: string, ex: string) => `${head}${t}${tail}${ex ? `\n${ex}` : ""}`.trimEnd() + "\n"
  let out = build(task, inline)
  if (out.length <= MAX_PROMPT_CHARS) return out
  out = build(task, "")
  if (out.length <= MAX_PROMPT_CHARS) return out
  const room = Math.max(1000, MAX_PROMPT_CHARS - build("", "").length - 200)
  const pointer = files.brief ? `the full brief is in \`${files.brief}\`` : `see the transcript at \`${files.transcript}\``
  return build(`${task.slice(0, room)}\n\n…[shortened; ${pointer}]`, "")
}

function modelSection(models: ResolvedModels): string {
  if (!models.subagents.length) return ""
  const target = (m: ResolvedModels["subagents"][number]) => {
    const opts = Object.entries(m.selection.options ?? {})
    const json = `providerInstanceId "${m.selection.instanceId}", model "${m.selection.model}"${opts.length ? `, options ${JSON.stringify(Object.fromEntries(opts))}` : ""}`
    return `- ${formatModelSpec(m.selection)}: target { ${json} }${m.mentionedAs.length ? ` (the user called it "${m.mentionedAs.join('", "')}")` : ""}`
  }
  return `## Models
You may delegate subtasks to other models with the T3 delegate_task tool, using only these targets:
${models.subagents.map(target).join("\n")}
${
  models.mentioned.length
    ? "- The task names models for particular steps. Run each of those steps with the model named for it, via delegate_task, and wait for the result before moving on.\n"
    : ""
}- Subagents that change code must share your checkout (the default isolation), so their work lands on your branch. Review what they did and commit it.
- If the task asks for a model that isn't listed, don't substitute silently: use the closest listed one and say so in your final message.

`
}
