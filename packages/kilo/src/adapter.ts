// The engine's view of Kilo, through the v1 SDK client a Kilo plugin receives.
// Kilo's VS Code panel hides synthetic text, so messages from handoff are normal
// text parts tagged the way Kilo tags its own injected prompts; notices are also
// `ignored`, which keeps them on screen but out of the model's context.

import type { KiloClient, TextPartInput } from "@kilocode/sdk/client"
import { condenseTranscript } from "@handoff/shared/transcript"
import { NOTICE, type Opencode } from "@handoff/opencode-plugin/engine"
import { loadState } from "@handoff/opencode-plugin/store"
import { toExport } from "./transcript.js"

/** Transcript the brief-writing model sees; the session's own model writes the brief from it. */
const BRIEF_TRANSCRIPT_CHARS = 60_000

export function injected(title: string): Record<string, unknown> {
  return { kilo: { injected: { title } } }
}

/** "## Handoff `abc123` finished" → "Handoff abc123 finished" */
export function titleOf(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "Handoff"
  return line.replace(/^#+\s*/, "").replace(/`/g, "").trim().slice(0, 80)
}

export function kiloOpencode(client: KiloClient): Opencode {
  const directories = new Map<string, string>()

  /** Requests run in the session's own directory, so tools and files resolve in the right project. */
  async function directoryOf(sessionID: string): Promise<{ directory?: string }> {
    const known = directories.get(sessionID) ?? Object.values((await loadState()).jobs).find((j) => j.sessionID === sessionID)?.directory
    return known ? { directory: known } : {}
  }

  async function session(sessionID: string) {
    const { data } = await client.session.get({ path: { id: sessionID }, query: await directoryOf(sessionID), throwOnError: true })
    directories.set(sessionID, data.directory)
    return data
  }

  async function history(sessionID: string) {
    const { data } = await client.session.messages({ path: { id: sessionID }, query: await directoryOf(sessionID), throwOnError: true })
    return data
  }

  return {
    app: "Kilo",
    async sessionDirectory(sessionID) {
      return (await session(sessionID)).directory
    },
    async sessionTitle(sessionID) {
      return (await session(sessionID)).title || null
    },
    async exportSession(sessionID) {
      const [info, messages] = await Promise.all([session(sessionID), history(sessionID)])
      return toExport(info, messages)
    },
    async generate(sessionID, prompt) {
      // v1 can't ask a session's model without adding a turn, so a throwaway child session gets the
      // transcript and the prompt, with the session's latest model and every tool denied.
      const info = await session(sessionID)
      const messages = await history(sessionID)
      const last = messages.findLast((m) => m.info.role === "user")?.info
      const model = last?.role === "user" ? last.model : undefined
      const transcript = condenseTranscript(toExport(info, messages), BRIEF_TRANSCRIPT_CHARS)
      const query = { directory: info.directory }
      const { data: child } = await client.session.create({ query, body: { parentID: sessionID, title: "Handoff brief" }, throwOnError: true })
      try {
        const { data } = await client.session.prompt({
          path: { id: child.id },
          query,
          body: {
            ...(model ? { model } : {}),
            tools: { "*": false },
            system: "You are writing a handoff brief. You have no tools and can't read files: work only from the transcript below, and reply with exactly what is asked.",
            parts: [{ type: "text", text: `This is the session being handed off:\n\n<transcript>\n${transcript}\n</transcript>\n\n${prompt}` }],
          },
          throwOnError: true,
        })
        if (data.info.error) throw new Error(`the model failed: ${JSON.stringify(data.info.error.data ?? data.info.error.name)}`)
        return data.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")
      } finally {
        await client.session.delete({ path: { id: child.id }, query }).catch(() => {})
      }
    },
    async post(sessionID, text, { resume, description }) {
      try {
        await session(sessionID)
      } catch {
        return false
      }
      const notice = description === NOTICE
      const part: TextPartInput = { type: "text", text, metadata: injected(notice ? "Handoff" : titleOf(text)), ...(notice ? { ignored: true } : {}) }
      // Async so a busy session never holds up the poller; Kilo runs the turn when the session is free.
      await client.session.promptAsync({
        path: { id: sessionID },
        query: await directoryOf(sessionID),
        body: { noReply: notice || !resume, parts: [part] },
        throwOnError: true,
      })
      return true
    },
    async createSession(directory, title) {
      const { data } = await client.session.create({ query: { directory }, body: { title }, throwOnError: true })
      directories.set(data.id, directory)
      return data.id
    },
    log(message) {
      console.error(message)
    },
  }
}
