import { describe, expect, it } from "vitest"
import { condenseTranscript } from "./transcript.js"

describe("transcript", () => {
  it("keeps the conversation and drops tool output and skill dumps", () => {
    const text = condenseTranscript({
      info: { id: "s1", title: "Work" },
      messages: [
        { type: "compaction", summary: "## Objective\nShip it." },
        { type: "user", text: "Please read the README" },
        {
          type: "assistant",
          content: [
            { type: "tool", name: "skill", state: { status: "completed", input: { id: "research" }, content: [{ type: "text", text: "<skill_content>".padEnd(13_000, "x") }] } },
            { type: "tool", name: "read", state: { status: "completed", input: { path: "README.md" }, content: [{ type: "text", text: "file body ".repeat(500) }] } },
            { type: "tool", name: "bash", state: { status: "error", input: { command: "npm test" }, error: "exit 1" } },
            { type: "text", text: "Read it. " + "long ".repeat(1000) },
          ],
        },
      ],
    })
    expect(text).toContain("### Earlier conversation (summary)\n#### Objective")
    expect(text).toContain('- ran `read` {"path":"README.md"}')
    expect(text).toContain('- ran `bash` {"command":"npm test"} → ERROR: "exit 1"')
    expect(text).not.toContain("skill_content")
    expect(text).not.toContain("file body")
    expect(text.length).toBeLessThan(3_000)
  })
})
