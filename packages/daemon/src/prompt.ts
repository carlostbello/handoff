import { formatModelSpec, type RequestManifest } from "@handoff/shared"
import type { ResolvedModels } from "./models.js"

export function buildPrompt(input: {
  manifest: RequestManifest
  branch: string
  snapshot: string
  contextPath: string
  models: ResolvedModels
  /** Extra instructions from the host's config. */
  instructions: string
  transcriptChars: number
}): string {
  const { manifest, branch, snapshot, contextPath, models, instructions, transcriptChars } = input
  const task = manifest.instructions.trim() || "Continue the work in progress from the session below, picking up exactly where it left off."
  const remotes = Object.entries(manifest.repo.remotes)
    .map(([name, url]) => `${name} → ${url}`)
    .join(", ")
  const transcript = manifest.session.transcript
  const tail =
    transcript.length > transcriptChars
      ? `…[earlier context omitted; full transcript at ${contextPath}]\n\n${transcriptChars ? transcript.slice(-transcriptChars) : ""}`
      : transcript

  return `You are continuing work handed off from an opencode session on another machine (handoff job ${manifest.jobId}). The user is away from this machine; work autonomously.

## Task
${task}

## Workspace
- You are in a git worktree on branch \`${branch}\`, based on commit ${snapshot.slice(0, 12)}. That commit is the user's \`${manifest.repo.branch ?? "(detached HEAD)"}\` plus all their uncommitted work at handoff time.
- Repository: ${manifest.repo.name}${remotes ? ` (remotes for reference only: ${remotes})` : ""}. Do NOT push, and do not fetch from remotes; they may be unreachable from here.
- The full prior conversation is at ${contextPath}. Read it if the excerpt below is not enough.

## Rules
- Make reasonable assumptions instead of asking questions; record them in your final message. Only ask if you are truly blocked.
- Commit your work to \`${branch}\` in logical commits with clear messages. Never amend, rebase, or drop existing commits, and do not switch branches.
- Verify your work (build, tests, lint) where the project supports it.
- End with a final message for the user: what changed, how you verified it, assumptions, and follow-ups. It is sent back into their opencode session verbatim.${
    instructions.trim() ? `\n\n## Additional instructions\n${instructions.trim()}` : ""
  }

${modelSection(models)}## Prior session (most recent part)
${tail}
`
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
