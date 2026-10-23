import { describe, expect, it } from "vitest"
import type { HandoffBrief, RequestManifest } from "@handoff/shared"
import { MAX_PROMPT_CHARS, buildFollowUpPrompt, buildPrompt, type InputsContext } from "./prompt.js"
import { resolveModels } from "./models.js"

const policy = { model: null, leadModels: [], subagentModels: [], aliases: {} }
const files = { transcript: "/jobs/J/transcript.md", brief: "/jobs/J/brief.md" }

function manifest(transcript: string, brief?: HandoffBrief): RequestManifest {
  return {
    v: 1,
    jobId: "J",
    deviceId: "d",
    createdAt: 0,
    instructions: "start over with only the spec",
    ...(brief ? { brief } : {}),
    repo: { id: "r", name: "demo", branch: "main", head: null, snapshot: "a".repeat(40), snapshotRef: "refs/handoff/J/snapshot", base: null, remotes: {} },
    session: { id: "s", title: null, directory: "/Users/someone/Repos/demo", transcript },
    options: {},
  }
}

const noInputs: InputsContext = { jobId: "J", requestsDir: "/jobs/J/requests", inputsDir: "/jobs/J/inputs", imported: [], refused: [], skipped: [] }

const build = (m: RequestManifest, inputs = noInputs) =>
  buildPrompt({ manifest: m, branch: "handoff/x", snapshot: "a".repeat(40), files, models: resolveModels(policy, m.instructions), instructions: "", excerptChars: 4000, inputs })

const longTranscript = Array.from({ length: 400 }, (_, i) => `### ${i % 2 ? "Assistant" : "User"}\n${"words ".repeat(40)}`).join("\n\n")

describe("prompt", () => {
  it("keeps a big session out of the message: a pointer plus the latest exchange", () => {
    const p = build(manifest(longTranscript))
    expect(longTranscript.length).toBeGreaterThan(90_000)
    expect(p.length).toBeLessThan(8_000)
    expect(p).toContain("/jobs/J/transcript.md")
    expect(p).toContain("## Latest exchange in the prior session")
    expect(p).toContain("Paths under `/Users/someone/Repos/demo` (the user's machine) refer to the same place in this worktree.")
  })

  it("honours the brief's context choice and file list", () => {
    const brief: HandoffBrief = { title: "Rebuild", slug: "rebuild", projectName: "Demo", context: "none", files: ["SPEC.md", "BUILD.md"], task: "## Goal\nRebuild from the spec." }
    const fresh = build(manifest(longTranscript, brief))
    expect(fresh).toContain("fresh start")
    expect(fresh).not.toContain("transcript.md")
    expect(fresh).not.toContain("Latest exchange")
    expect(fresh).toContain("## Read first\n- `SPEC.md`\n- `BUILD.md`")
    const ref = build(manifest(longTranscript, { ...brief, context: "reference" }))
    expect(ref).toContain("source of truth")
    expect(ref).toContain("transcript.md")
  })

  it("never exceeds the size cap, pointing to the full brief instead", () => {
    const brief: HandoffBrief = { title: "Huge", slug: "huge", projectName: "Demo", context: "reference", files: [], task: "x".repeat(40_000) }
    const p = build(manifest("", brief))
    expect(p.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
    expect(p).toContain("the full brief is in `/jobs/J/brief.md`")
  })

  it("tells the agent how to ask the user's machine for more, and how to say it's blocked", () => {
    const p = build(manifest("### User\nhi"))
    expect(p).toContain("## Getting more from the user's machine")
    expect(p).toContain("Write `/jobs/J/requests/<short-name>.json`")
    expect(p).toContain("`/jobs/J/inputs/<name>/`")
    expect(p).toContain("`refs/handoff/inputs/J/<name>`")
    expect(p).toContain("`/jobs/J/inputs/receipts.json`")
    expect(p).toContain("BLOCKED: <exactly what you need, from where, and why>")
    expect(p).toContain('Do NOT push or fetch from remotes; to get another branch or commit, see "Getting more from the user\'s machine" below.')
    expect(p).not.toContain("## Inputs from the user's machine")
    const followUp = buildFollowUpPrompt({ manifest: manifest(""), branch: "handoff/x", snapshot: "a".repeat(40), files, models: resolveModels(policy, ""), inputs: noInputs })
    expect(followUp).toContain("Write `/jobs/J/requests/<short-name>.json`")
  })

  it("lists inputs that came with the request, refused ones and left-out files", () => {
    const inputs: InputsContext = {
      ...noInputs,
      imported: [
        {
          name: "mac-app",
          repo: "/Users/someone/Repos/demo",
          ref: "origin/feature/x",
          sourceCommit: "b".repeat(40),
          paths: ["mac-app"],
          mode: "source",
          commit: "c".repeat(40),
          tree: "d".repeat(40),
          bundleRef: "refs/handoff/01JAAAAAAAAAAAAAAAAAAAAAAA/input/mac-app",
          size: 10,
          sha256: "e".repeat(64),
          skipped: [".env"],
          approvedBy: "user",
          localRef: "refs/handoff/inputs/J/mac-app",
          dir: "/jobs/J/inputs/mac-app",
          receivedAt: 0,
        },
      ],
      refused: [{ name: "keys", reason: "the user declined" }],
      skipped: ["secrets.json"],
    }
    const p = build(manifest(""), inputs)
    expect(p).toContain("## Inputs from the user's machine")
    expect(p).toContain("- **mac-app**: `origin/feature/x` (commit bbbbbbbbbbbb) of `/Users/someone/Repos/demo`, only `mac-app` (approved by the user). Files: `/jobs/J/inputs/mac-app/`. Git ref: `refs/handoff/inputs/J/mac-app`")
    expect(p).toContain("Left out as secret-looking: `.env`.")
    expect(p).toContain("- Not sent: **keys**: the user declined")
    expect(p).toContain("look like secrets: `secrets.json`.")
  })
})
