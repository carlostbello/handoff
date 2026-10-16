// opencode v2 TUI plugin: shows handoff notices as toasts. Ephemeral notices
// (status, help, pairing) are removed from the session inbox so they never
// reach the model; lifecycle messages stay and also raise an OS notification.

import type { Plugin } from "@opencode/plugin/tui"

type Context = Plugin.Context

const NOTICE = "handoff-notice"

function firstLine(text: string): string {
  return text.replace(/^#+\s*/gm, "").replace(/`/g, "").split("\n").find((l) => l.trim()) ?? text
}

export default {
  id: "handoff-tui",
  setup(context: Context) {
    const stop = context.data.on("session.inbox.enqueued", (event) => {
      const { sessionID, inboxID, item } = event.data as { sessionID: string; inboxID: string; item: Record<string, any> }
      const payload = (item?.payload ?? item) as { text?: string; description?: string }
      const description = payload?.description ?? ""
      const text = payload?.text ?? ""
      if (description === NOTICE) {
        // Pairing shows a fingerprint to compare with the host, so keep it up longer.
        const duration = /fingerprint/i.test(text) ? 120_000 : 8000
        context.ui.toast.show({ title: "handoff", message: text.slice(0, 600), variant: /failed/i.test(text) ? "error" : "info", duration })
        void context.client.session.inbox.cancel({ sessionID, inboxID }).catch(() => {})
        return
      }
      if (description !== "handoff" && !description.startsWith("handoff ")) return
      const finished = text.startsWith("## Handoff")
      const failed = /failed|ended without success/i.test(firstLine(text))
      context.ui.toast.show({
        title: "handoff",
        message: firstLine(text).slice(0, 300),
        variant: failed ? "error" : finished ? "success" : "info",
        duration: 10000,
        sessionID,
      })
      if (finished || /has a question/.test(text)) {
        void context.attention.notify({ title: "handoff", message: firstLine(text).slice(0, 200), notification: true, sound: { name: finished ? "done" : "question" } })
      }
    })
    return () => stop()
  },
}
