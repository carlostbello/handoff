// `/handoff` in Kilo. A v1 plugin can't run a command without a model turn: the
// `command.execute.before` hook only gets to rewrite the prompt. So the hook does the
// work, shows its output in the command's own message (an `ignored` part, which stays
// out of the model's context), and leaves the model a short synthetic note to acknowledge.

import { Engine, NOTICE, type Opencode } from "@handoff/opencode-plugin/engine"

export const COMMAND = {
  // Never empty, so there is always a text part to rewrite.
  template: "/handoff $ARGUMENTS",
  description: "Send this session's work to the host (T3 Code); results come back here",
}

/** Prompt parts as the hook receives them; Kilo passes this same array on to the prompt. */
type Parts = Array<Record<string, unknown>>

export async function runHandoffCommand(opencode: Opencode, sessionID: string, args: string, parts: Parts): Promise<void> {
  const shown: string[] = []
  const capture: Opencode = {
    ...opencode,
    // Replies to the command go into the command's message instead of separate notices.
    post: (id, text, opts) => (id === sessionID && opts.description === NOTICE ? (shown.push(text), Promise.resolve(true)) : opencode.post(id, text, opts)),
  }
  await new Engine(capture).handle(sessionID, args)
  rewriteParts(parts, args, shown.join("\n\n"))
}

export function rewriteParts(parts: Parts, args: string, output: string): void {
  const text = output.trim() || "Done."
  // Keep the first text part's metadata: Kilo labels it "Sent by Kilo · /handoff …" in the panel.
  const first = parts.find((p) => p.type === "text") ?? { type: "text" }
  const command = `/handoff${args.trim() ? ` ${args.trim()}` : ""}`
  // Mutate in place: Kilo prompts with this array, not with whatever the hook assigns.
  parts.splice(
    0,
    parts.length,
    { ...first, text, ignored: true },
    {
      type: "text",
      synthetic: true,
      text:
        `The user ran \`${command}\`. The handoff plugin handled it and has already shown the user this output:\n\n${text}\n\n` +
        "Acknowledge in one short sentence at most. Don't repeat the output, call tools or start other work.",
    },
  )
}
