import { describe, expect, it } from "vitest"
import type { HandoffBrief, RequestManifest } from "@handoff/shared"
import { MAX_PROMPT_CHARS, buildPrompt } from "./prompt.js"
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

const build = (m: RequestManifest) =>
  buildPrompt({ manifest: m, branch: "handoff/x", snapshot: "a".repeat(40), files, models: resolveModels(policy, m.instructions), instructions: "", excerptChars: 4000 })

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
})
