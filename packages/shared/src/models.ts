// Model specs: one string format for config files, CLI flags, and /handoff flags.
//   <provider instance>/<model>[:<option>=<value>,<option>=<value>]
// e.g. "claudeAgent/claude-opus-5-5", "codex/gpt-6-sol:reasoningEffort=high",
// "opencode/zai-coding-plan/glm-5.2" (model ids may contain "/").
// Provider instances, models, and options come from T3 (`handoff-daemon models`).

export interface ModelSelection {
  instanceId: string
  model: string
  /** Model options as advertised by T3, e.g. { effort: "high", fastMode: true }. */
  options?: Record<string, string | boolean>
}

export function parseModelSpec(spec: string): ModelSelection {
  const trimmed = spec.trim()
  const colon = trimmed.indexOf(":")
  const head = colon >= 0 ? trimmed.slice(0, colon) : trimmed
  const slash = head.indexOf("/")
  if (slash <= 0 || slash === head.length - 1) {
    throw new Error(`invalid model "${spec}": expected <provider>/<model>[:option=value,...], e.g. claudeAgent/claude-opus-5-5`)
  }
  const selection: ModelSelection = { instanceId: head.slice(0, slash), model: head.slice(slash + 1) }
  if (colon >= 0) {
    const options: Record<string, string | boolean> = {}
    for (const pair of trimmed.slice(colon + 1).split(",").filter(Boolean)) {
      const eq = pair.indexOf("=")
      if (eq <= 0) throw new Error(`invalid model option "${pair}" in "${spec}": expected option=value`)
      const value = pair.slice(eq + 1)
      options[pair.slice(0, eq)] = value === "true" ? true : value === "false" ? false : value
    }
    if (Object.keys(options).length) selection.options = options
  }
  return selection
}

export function formatModelSpec(selection: ModelSelection): string {
  const options = Object.entries(selection.options ?? {}).map(([k, v]) => `${k}=${v}`)
  return `${selection.instanceId}/${selection.model}${options.length ? `:${options.join(",")}` : ""}`
}
