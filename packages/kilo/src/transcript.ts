// Kilo sessions are opencode v1 sessions: a list of {info, parts} messages. The shared
// transcript condenser reads the opencode v2 export shape, so convert to that, starting
// at the last compaction the way v2's session context does.

import type { Message, Part, Session } from "@kilocode/sdk/client"

export type KiloMessage = { info: Message; parts: Part[] }

/** Title Kilo's panel shows for a message that wasn't typed by the user ("Sent by Kilo · <title>"). */
export function injectedTitle(part: Part): string | undefined {
  if (part.type !== "text") return undefined
  const kilo = (part.metadata as { kilo?: { injected?: { title?: unknown } } } | undefined)?.kilo
  const title = kilo?.injected?.title
  return typeof title === "string" && title.trim() ? title.trim() : undefined
}

export function toExport(info: Pick<Session, "id" | "title">, history: KiloMessage[]) {
  const start = history.findLastIndex((m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"))
  const messages: Record<string, unknown>[] = []
  for (const { info: msg, parts } of start < 0 ? history : history.slice(start)) {
    if (msg.role === "user") {
      const typed: string[] = []
      for (const p of parts) {
        if (p.type !== "text" || p.ignored || !p.text.trim()) continue
        const title = injectedTitle(p)
        if (p.synthetic || title) messages.push({ type: "synthetic", text: p.text, ...(title ? { description: title } : {}) })
        else typed.push(p.text)
      }
      if (typed.length) messages.push({ type: "user", text: typed.join("\n\n") })
      continue
    }
    const text = parts.flatMap((p) => (p.type === "text" && !p.ignored ? [p.text] : [])).join("\n\n")
    if (msg.summary) {
      if (text.trim()) messages.push({ type: "compaction", summary: text })
      continue
    }
    const content = parts.flatMap((p): Record<string, unknown>[] => {
      if (p.type === "text" && !p.ignored) return [{ type: "text", text: p.text }]
      if (p.type === "tool") return [{ type: "tool", name: p.tool, state: p.state }]
      return []
    })
    if (content.length) messages.push({ type: "assistant", content })
  }
  return { info: { id: info.id, title: info.title }, messages }
}
