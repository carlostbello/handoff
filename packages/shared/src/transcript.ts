// Turns an opencode v2 session export ({info, messages}) into compact markdown
// for the host agent. Written defensively: unknown message shapes are skipped.

type Json = Record<string, unknown>

const str = (v: unknown): string => (typeof v === "string" ? v : "")

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
}

function toolLine(part: Json): string {
  const state = (part.state ?? {}) as Json
  const input = state.input
  let args = typeof input === "string" ? input : JSON.stringify(input ?? {})
  args = clip(args, 300)
  const status = str(state.status)
  let out = ""
  if (status === "completed" && Array.isArray(state.content)) {
    out = (state.content as Json[])
      .map((c) => str(c.text))
      .filter(Boolean)
      .join("\n")
  } else if (status === "error") {
    out = `ERROR: ${JSON.stringify(state.error ?? "")}`
  }
  return `- tool \`${str(part.name)}\` ${args}${out ? `\n  → ${clip(out.replace(/\n/g, "\n    "), 600)}` : ""}`
}

export function condenseTranscript(exported: unknown, maxChars = 80_000): string {
  const data = ((exported as Json)?.data ?? exported) as Json
  const info = (data?.info ?? {}) as Json
  const messages = (Array.isArray(data?.messages) ? data.messages : []) as Json[]
  const blocks: string[] = []

  for (const m of messages) {
    switch (m.type) {
      case "user":
        blocks.push(`### User\n${str(m.text)}`)
        break
      case "synthetic":
        blocks.push(`### Note${m.description ? ` (${str(m.description)})` : ""}\n${clip(str(m.text), 4000)}`)
        break
      case "shell":
        blocks.push(`### Shell \`${str(m.command)}\`\n${clip(str((m.output as Json | undefined)?.output), 1500)}`)
        break
      case "compaction": {
        const summary = str(m.summary) || str((m as Json).text)
        if (summary) blocks.push(`### Earlier conversation (compacted)\n${summary}`)
        break
      }
      case "assistant": {
        const parts = (Array.isArray(m.content) ? m.content : []) as Json[]
        const lines: string[] = []
        for (const p of parts) {
          if (p.type === "text" && str(p.text).trim()) lines.push(str(p.text).trim())
          else if (p.type === "tool") lines.push(toolLine(p))
        }
        if (lines.length) blocks.push(`### Assistant\n${lines.join("\n")}`)
        break
      }
    }
  }

  const header = `Session: ${str(info.title) || "(untitled)"} (${str(info.id)})`
  // Keep the most recent context when over budget.
  let body = ""
  for (let i = blocks.length - 1; i >= 0; i--) {
    const next = blocks[i]! + "\n\n" + body
    if (next.length > maxChars) {
      body = `…[${i + 1} earlier entries omitted]\n\n` + body
      break
    }
    body = next
  }
  return `${header}\n\n${body}`.trim()
}
