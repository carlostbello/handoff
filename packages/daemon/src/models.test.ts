import { describe, expect, it } from "vitest"
import { parseModelSpec } from "@handoff/shared"
import { deriveAliases, describeResolution, displayAliases, resolveModels, type ModelPolicy } from "./models.js"

const m = parseModelSpec
const policy: ModelPolicy = {
  model: m("claudeAgent/claude-sonnet-5-5"),
  leadModels: [m("claudeAgent/claude-opus-5-5"), m("codex/gpt-6.1-sol")],
  subagentModels: [m("claudeAgent/claude-fable-5-1"), m("codex/gpt-6-astra:reasoningEffort=high"), m("codex/gpt-6.1-sol"), m("codex/gpt-6-sol")],
  aliases: {},
}

describe("model mentions", () => {
  it("derives short aliases", () => {
    expect(deriveAliases(m("claudeAgent/claude-opus-5-5"))).toEqual(expect.arrayContaining(["opus", "opus 5.5", "claude opus 5.5"]))
    expect(deriveAliases(m("codex/gpt-6.1-sol"))).toEqual(expect.arrayContaining(["sol", "6.1 sol", "gpt 6.1 sol", "gpt-6.1-sol".replace(/-/g, " ")]))
  })

  it("shows natural short names", () => {
    expect(displayAliases(m("claudeAgent/claude-opus-5-5"))).toEqual(["opus", "opus 5.5"])
    expect(displayAliases(m("codex/gpt-6.1-sol"))).toEqual(["sol", "6.1 sol"])
  })

  it("handles the example request", () => {
    const r = resolveModels(policy, "continue this task with opus, spin up fable and astra subagents to review the final plan, then execute with 6.1 sol")
    expect(r.lead).toEqual(m("claudeAgent/claude-opus-5-5"))
    expect(r.leadSource).toBe("request")
    expect(r.mentioned.map((x) => [x.selection.model, x.mentionedAs[0]])).toEqual([
      ["claude-fable-5-1", "fable"],
      ["gpt-6-astra", "astra"],
      ["gpt-6.1-sol", "6.1 sol"],
    ])
    expect(r.mentioned[1]!.selection.options).toEqual({ reasoningEffort: "high" }) // configured options carry over
  })

  it("doesn't pick a model named only for subagents as the lead", () => {
    const r = resolveModels(policy, "spin up 6.1 sol subagents to explore, then finish it with opus")
    expect(r.lead?.model).toBe("claude-opus-5-5")
    expect(r.mentioned.map((x) => x.selection.model)).toEqual(["gpt-6.1-sol"])
  })

  it("falls back to the default and ignores models that aren't allowed", () => {
    const r = resolveModels(policy, "fix the flaky test, use haiku if you like")
    expect(r.lead?.model).toBe("claude-sonnet-5-5")
    expect(r.leadSource).toBe("default")
    expect(r.mentioned).toEqual([])
    expect(r.subagents.map((x) => x.selection.model)).toEqual(["claude-fable-5-1", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"])
  })

  it("prefers the first-listed model for an ambiguous family name, and honours nicknames", () => {
    expect(resolveModels(policy, "have sol subagents check it").mentioned[0]!.selection.model).toBe("gpt-6.1-sol")
    const r = resolveModels({ ...policy, aliases: { "the big one": "claudeAgent/claude-opus-5-5" } }, "do it with the big one")
    expect(r.lead?.model).toBe("claude-opus-5-5")
  })

  it("validates --model against the allowed leads", () => {
    expect(resolveModels(policy, "x", "opus").lead?.model).toBe("claude-opus-5-5")
    expect(resolveModels(policy, "x", "claudeAgent/claude-opus-5-5:effort=high").lead?.options).toEqual({ effort: "high" })
    expect(() => resolveModels(policy, "x", "fable")).toThrow(/isn't allowed as the lead/)
    expect(() => resolveModels(policy, "x", "codex/gpt-9")).toThrow(/isn't allowed/)
  })

  it("reports a model T3 offers but the host doesn't allow, instead of ignoring it", () => {
    const catalog = [m("codex/gpt-6-astra"), m("codex/gpt-6-luna"), m("claudeAgent/claude-opus-5-5")]
    const r = resolveModels(policy, "use Opus to judge it, and use Luna subagents to research it", undefined, catalog)
    expect(r.lead?.model).toBe("claude-opus-5-5")
    expect(r.notAllowed).toEqual([{ selection: m("codex/gpt-6-luna"), mentionedAs: ["luna"] }])
    expect(describeResolution(r)).toMatch(/Not allowed on this host.*luna \(codex\/gpt-6-luna\).*config add subagentModels codex\/gpt-6-luna/)
    // Allowed models and words that aren't models are not reported.
    expect(resolveModels(policy, "have astra review it", undefined, catalog).notAllowed).toBeUndefined()
    expect(resolveModels({ ...policy, subagentModels: [...policy.subagentModels, m("codex/gpt-6-luna")] }, "use luna subagents", undefined, catalog).mentioned[0]?.selection.model).toBe("gpt-6-luna")
  })
})
