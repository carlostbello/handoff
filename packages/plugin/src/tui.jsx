// opencode v2 TUI plugin.
// - Toasts for handoff notices. Ephemeral notices (status, help, pairing) are removed from the
//   session inbox so they never reach the model; lifecycle messages stay and also raise an OS notification.
// - Live status: a prompt-footer line and a sidebar section for the open session, and a
//   "Handoff: status" palette dialog listing every recent handoff.
// Status comes from the client state file the server plugin keeps, so showing it costs no relay requests.
//
// This file stays JSX in the published plugin: opencode compiles plugin .jsx with Solid and
// supplies its own solid-js and @opentui/solid.

import { createSignal, For, Show } from "solid-js"
import { stat } from "node:fs/promises"
import { DEVICE_STATE, loadState } from "./store.js"
import { allViews, footerLine, ICON, sessionViews } from "./status.js"

const NOTICE = "handoff-notice"
const REFRESH_MS = 2000

function firstLine(text) {
  return text.replace(/^#+\s*/gm, "").replace(/`/g, "").split("\n").find((l) => l.trim()) ?? text
}

function toneColor(theme, tone) {
  const feedback = theme.text.feedback ?? {}
  if (tone === "error") return feedback.error?.base ?? theme.text.base
  if (tone === "success") return feedback.success?.base ?? theme.text.base
  if (tone === "attention") return feedback.warning?.base ?? feedback.info?.base ?? theme.text.base
  if (tone === "active") return feedback.info?.base ?? theme.text.base
  return theme.text.muted
}

/** Jobs from the state file and the current time, refreshed every couple of seconds. */
function watchState() {
  const [jobs, setJobs] = createSignal([])
  const [now, setNow] = createSignal(Date.now())
  let mtime = 0
  const refresh = async () => {
    setNow(Date.now())
    try {
      const m = (await stat(DEVICE_STATE)).mtimeMs
      if (m === mtime) return
      mtime = m
      setJobs(Object.values((await loadState()).jobs))
    } catch {
      // No state yet (not paired, or nothing handed off).
    }
  }
  void refresh()
  const timer = setInterval(() => void refresh(), REFRESH_MS)
  return { jobs, now, stop: () => clearInterval(timer) }
}

function Footer(props) {
  const line = () => footerLine(props.state.jobs(), props.sessionID, props.state.now())
  return (
    <Show when={props.sessionID && line()}>
      {(l) => (
        <text wrapMode="none" flexShrink={1} fg={props.theme.text.muted}>
          <span style={{ fg: toneColor(props.theme, l().tone) }}>{"⇄ "}</span>
          {l().text}
        </text>
      )}
    </Show>
  )
}

function Sidebar(props) {
  const items = () => sessionViews(props.state.jobs(), props.sessionID, props.state.now(), 4)
  return (
    <Show when={items().length > 0}>
      <box>
        <text fg={props.theme.text.base}>
          <b>Handoff</b>
        </text>
        <For each={items()}>
          {(v) => (
            <box>
              <text wrapMode="none" fg={props.theme.text.base}>
                <span style={{ fg: toneColor(props.theme, v.tone) }}>{`${ICON[v.tone]} `}</span>
                {`${v.short} ${v.state} · ${v.age}`}
              </text>
              <box paddingLeft={2}>
                <text wrapMode="none" fg={props.theme.text.muted}>{v.title}</text>
                <Show when={v.live && v.detail}>
                  <text fg={props.theme.text.muted}>{v.detail}</text>
                </Show>
              </box>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

async function showDialog(context, state) {
  const views = allViews(state.jobs(), Date.now())
  if (!views.length) {
    context.ui.toast.show({ title: "handoff", message: "No handoffs yet. Run /handoff <instructions> in a session.", variant: "info" })
    return
  }
  const route = context.ui.router.current()
  const current = route.type === "session" ? route.sessionID : undefined
  const sessionTitle = (id) => (id === current ? "This session" : context.data.session.get(id)?.title || `Session ${id.slice(-6)}`)
  const choice = context.ui.dialog.select({
    title: "Handoffs",
    placeholder: "Filter",
    options: views.map((v) => ({
      title: `${ICON[v.tone]} ${v.short}  ${v.title}`,
      value: v,
      description: v.detail,
      footer: `${v.state} · ${v.age}`,
      category: sessionTitle(v.sessionID),
    })),
  })
  context.ui.dialog.set({ size: "large" })
  const picked = await choice
  if (picked && picked.sessionID !== current && context.data.session.get(picked.sessionID)) {
    context.ui.router.navigate({ type: "session", sessionID: picked.sessionID })
  }
}

export default {
  id: "handoff-tui",
  setup(context) {
    const state = watchState()
    const cleanups = [state.stop]

    cleanups.push(
      context.ui.slot({
        append: "prompt.footer.status",
        render: (input) => <Footer state={state} theme={context.theme} sessionID={input.sessionID} />,
      }),
      context.ui.slot({
        append: "sidebar.content",
        render: (input) => <Sidebar state={state} theme={context.theme} sessionID={input.sessionID} />,
      }),
    )

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "handoff.status",
          title: "Handoff: status",
          description: "Show running and recent handoffs",
          group: "Handoff",
          bind: false,
          palette: true,
          slash: { name: "handoffs" },
          run: () => void showDialog(context, state),
        },
      ],
    }))

    cleanups.push(
      context.data.on("session.inbox.enqueued", (event) => {
        const { sessionID, inboxID, item } = event.data
        const payload = item?.payload ?? item
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
        const finished = text.startsWith("## Handoff") || text.startsWith("## Update from T3")
        const failed = /failed|ended without success|is blocked|: blocked/i.test(firstLine(text))
        context.ui.toast.show({
          title: "handoff",
          message: firstLine(text).slice(0, 300),
          variant: failed ? "error" : finished ? "success" : "info",
          duration: 10000,
          sessionID,
        })
        if (finished || /has a question|wants material from outside|asked for:/.test(text)) {
          void context.attention.notify({ title: "handoff", message: firstLine(text).slice(0, 200), notification: true, sound: { name: finished ? "done" : "question" } })
        }
      }),
    )

    return () => {
      for (const stop of cleanups) stop()
    }
  },
}
