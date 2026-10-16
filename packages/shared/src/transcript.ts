// Turns an opencode v2 session export ({info, messages}) into compact markdown
// for the host agent. Written defensively: unknown message shapes are skipped.

type Json = Record<string, unknown>

const str = (v: unknown): string => (typeof v === "string" ? v : "")

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
}

/**
 * A tool call as one line. Outputs are left out: the host agent has the repository
 * and can repeat any read or command itself. Errors are kept, briefly.
 */
function toolLine(part: Json): string | null {
  const name = str(part.name)
  if (SKIPPED_TOOLS.has(name)) return null
  const state = (part.state ?? {}) as Json
  const input = state.input
  const args = clip(typeof input === "string" ? input : JSON.stringify(input ?? {}), 200).replace(/\n/g, " ")
  const error = str(state.status) === "error" ? ` → ERROR: ${clip(JSON.stringify(state.error ?? ""), 200)}` : ""
  return `- ran \`${name}\` ${args}${error}`
}

/** Tools whose calls tell the host agent nothing (loading skills, todo bookkeeping). */
const SKIPPED_TOOLS = new Set(["skill", "todowrite", "todoread"])
const MAX_TEXT_PER_MESSAGE = 2000

export function condenseTranscript(exported: unknown, maxChars = 120_000): string {
  const data = ((exported as Json)?.data ?? exported) as Json
  const info = (data?.info ?? {}) as Json
  const messages = (Array.isArray(data?.messages) ? data.messages : []) as Json[]
  const blocks: string[] = []

  for (const m of messages) {
    switch (m.type) {
      case "user":
        blocks.push(`### User\n${clip(str(m.text), 6000)}`)
        break
      case "synthetic":
        blocks.push(`### Note${m.description ? ` (${str(m.description)})` : ""}\n${clip(str(m.text), 4000)}`)
        break
      case "shell":
        blocks.push(`### Shell \`${str(m.command)}\`\n${clip(str((m.output as Json | undefined)?.output), 1500)}`)
        break
      case "compaction": {
        const summary = str(m.summary) || str((m as Json).text)
        // Demote the summary's own headings so they don't read as transcript entries.
        if (summary) blocks.push(`### Earlier conversation (summary)\n${summary.replace(/^(#{1,3}) /gm, "#### ")}`)
        break
      }
      case "assistant": {
        const parts = (Array.isArray(m.content) ? m.content : []) as Json[]
        const lines: string[] = []
        for (const p of parts) {
          if (p.type === "text" && str(p.text).trim()) lines.push(clip(str(p.text).trim(), MAX_TEXT_PER_MESSAGE).replace(/^(#{1,3}) /gm, "#### "))
          else if (p.type === "tool") {
            const line = toolLine(p)
            if (line) lines.push(line)
          }
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
