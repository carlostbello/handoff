// What the TUI shows about handoffs, derived from the client state file. Pure
// functions so the footer, sidebar and dialog agree, and so they can be tested.

import type { DeviceJob } from "./store.js"

export type Tone = "active" | "attention" | "success" | "error" | "muted"

export interface JobView {
  id: string
  short: string
  sessionID: string
  title: string
  /** One or two words: "running", "needs answer", "done"... */
  state: string
  tone: Tone
  /** Latest detail from the host, if any. */
  detail?: string
  /** "12m" while running, "2h ago" once finished. */
  age: string
  /** Still in progress here or on the host. */
  live: boolean
}

export const short = (id: string) => id.slice(-6).toLowerCase()

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

function title(job: DeviceJob): string {
  if (job.brief?.title) return job.brief.title
  if (job.origin === "host") return "Update from T3"
  const words = job.instructions.trim().replace(/\s+/g, " ")
  return words ? (words.length > 60 ? `${words.slice(0, 57)}…` : words) : "Continue the work"
}

export function view(job: DeviceJob, now: number): JobView {
  const base = { id: job.id, short: short(job.id), sessionID: job.sessionID, title: title(job) }
  const changed = job.updatedAt ?? job.createdAt
  const running = (state: string, tone: Tone = "active", detail = job.lastStatus): JobView => ({ ...base, state, tone, detail, age: duration(now - job.createdAt), live: true })
  const ended = (state: string, tone: Tone, detail = job.lastStatus): JobView => ({ ...base, state, tone, detail, age: `${duration(now - changed)} ago`, live: false })
  if (job.question) return running("needs answer", "attention", `Answer with /handoff reply ${short(job.id)} <answer>`)
  if (job.inputRequests?.some((r) => r.state === "awaiting-approval")) return running("needs approval", "attention", `Send with /handoff approve ${short(job.id)}, or /handoff deny ${short(job.id)}`)
  switch (job.phase) {
    case "packing":
      return running("packing")
    case "uploading":
      return running("uploading")
    case "submitted":
      return running("running")
    case "applying":
      return running("applying")
    case "applied":
      if (job.outcome === "blocked" && !job.remote?.active) return ended("blocked", "attention")
      if (job.remote?.active) return { ...running("T3 working", "active", job.remote.note), age: duration(now - job.remote.since) }
      return ended("done", "success")
    case "failed":
      return ended("failed", "error")
    case "cancelled":
      return ended("cancelled", "muted")
  }
}

/** A session's handoffs, newest first. Only the newest can still have T3 working after delivery. */
export function sessionViews(jobs: DeviceJob[], sessionID: string, now: number, limit = 5): JobView[] {
  const mine = jobs.filter((j) => j.sessionID === sessionID).sort((a, b) => b.createdAt - a.createdAt)
  return mine.slice(0, limit).map((j, i) => view(i === 0 ? j : { ...j, remote: undefined }, now))
}

/** One line for the prompt footer, or nothing when this session has nothing in progress. */
export function footerLine(jobs: DeviceJob[], sessionID: string, now: number): { text: string; tone: Tone } | undefined {
  const live = sessionViews(jobs, sessionID, now, 20).filter((v) => v.live)
  if (!live.length) return undefined
  const first = live.find((v) => v.tone === "attention") ?? live[0]!
  const more = live.length > 1 ? ` +${live.length - 1}` : ""
  // Kept short: it shares the footer row with the path. The sidebar and dialog carry the detail.
  return { text: `handoff ${first.short} ${first.state} ${first.age}${more}`, tone: first.tone }
}

/** Every recent handoff, live ones first, for the status dialog. */
export function allViews(jobs: DeviceJob[], now: number, limit = 40): JobView[] {
  const newestPerSession = new Map<string, string>()
  for (const j of [...jobs].sort((a, b) => b.createdAt - a.createdAt)) if (!newestPerSession.has(j.sessionID)) newestPerSession.set(j.sessionID, j.id)
  const views = [...jobs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((j) => view(newestPerSession.get(j.sessionID) === j.id ? j : { ...j, remote: undefined }, now))
  return [...views.filter((v) => v.live), ...views.filter((v) => !v.live)]
}

export const ICON: Record<Tone, string> = { active: "●", attention: "?", success: "✓", error: "✗", muted: "·" }
