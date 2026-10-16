import { describe, expect, it } from "vitest"
import { formatModelSpec, parseModelSpec } from "./models.js"

describe("model specs", () => {
  it("parses providers, nested model ids, and options", () => {
    expect(parseModelSpec("claudeAgent/claude-opus-5-5")).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" })
    expect(parseModelSpec("opencode/zai-coding-plan/glm-5.2")).toEqual({ instanceId: "opencode", model: "zai-coding-plan/glm-5.2" })
    const s = parseModelSpec("claudeAgent/claude-opus-5-5:effort=high,fastMode=true")
    expect(s.options).toEqual({ effort: "high", fastMode: true })
    expect(formatModelSpec(s)).toBe("claudeAgent/claude-opus-5-5:effort=high,fastMode=true")
    expect(() => parseModelSpec("gpt")).toThrow(/expected <provider>\/<model>/)
    expect(() => parseModelSpec("a/b:oops")).toThrow(/option=value/)
  })
})
