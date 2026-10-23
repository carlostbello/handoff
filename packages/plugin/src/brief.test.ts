import { describe, expect, it } from "vitest"
import { parseBrief } from "./brief.js"

describe("parseBrief", () => {
  it("keeps valid inputs and drops malformed or duplicate ones", () => {
    const brief = parseBrief(
      JSON.stringify({
        title: "Build the recorder",
        slug: "build-recorder",
        projectName: "Note Taker",
        context: "reference",
        files: ["docs/spec.md"],
        inputs: [
          { name: "mac-app", ref: "origin/feature/mac-local-recorder", paths: ["mac-app"], reason: "existing recorder" },
          { name: "mac-app", ref: "main" },
          { name: "Bad Name!" },
          { name: "escape", paths: ["../secrets"] },
        ],
        task: "## Goal\nBuild the native recorder from the spec.",
      }),
    )
    expect(brief?.inputs).toEqual([{ name: "mac-app", ref: "origin/feature/mac-local-recorder", paths: ["mac-app"], mode: "source", reason: "existing recorder" }])
  })

  it("leaves inputs out when there are none", () => {
    expect(parseBrief(JSON.stringify({ title: "t", task: "## Goal\nDo the thing well.", inputs: [] }))?.inputs).toBeUndefined()
  })
})
