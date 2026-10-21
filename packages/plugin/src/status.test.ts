import { describe, expect, it } from "vitest"
import type { DeviceJob } from "./store.js"
import { allViews, duration, footerLine, sessionViews, view } from "./status.js"

const NOW = 1_800_000_000_000
const job = (over: Partial<DeviceJob>): DeviceJob => ({
  id: "01M5DVA2ZDGSPP7W47H0MAWVXY",
  phase: "submitted",
  sessionID: "ses_a",
  directory: "/r",
  repoTop: "/r",
  repoId: "r",
  branch: "main",
  head: null,
  instructions: "plan the roadmap",
  createdAt: NOW - 12 * 60_000,
  ...over,
})

describe("handoff status display", () => {
  it("formats durations", () => {
    expect(duration(42_000)).toBe("42s")
    expect(duration(12 * 60_000)).toBe("12m")
    expect(duration(150 * 60_000)).toBe("2h 30m")
    expect(duration(3 * 24 * 3600_000)).toBe("3d")
  })

  it("describes a running handoff with the host's latest status", () => {
    const v = view(job({ lastStatus: "Waiting on subagents: Astra review", brief: { title: "Roadmap", slug: "r", projectName: "", context: "reference", files: [], task: "t" } }), NOW)
    expect(v).toMatchObject({ short: "mawvxy", title: "Roadmap", state: "running", tone: "active", age: "12m", live: true, detail: "Waiting on subagents: Astra review" })
  })

  it("puts a question from the host first", () => {
    const asked = job({ id: "01M5DVA2ZDGSPP7W47H0QUESTN", question: { requestId: "q", question: {} } })
    const line = footerLine([job({}), asked], "ses_a", NOW)
    expect(line).toEqual({ text: "handoff questn needs answer 12m +1", tone: "attention" })
  })

  it("shows T3 still working after delivery, on the session's newest job only", () => {
    const old = job({ id: "01OLD000000000000000000000", phase: "applied", createdAt: NOW - 3600_000, remote: { active: true, note: "stale", since: NOW } })
    const newest = job({ phase: "applied", updatedAt: NOW - 60_000, remote: { active: true, note: "T3 is still working: Astra", since: NOW - 180_000 } })
    const views = sessionViews([old, newest], "ses_a", NOW)
    expect(views[0]).toMatchObject({ state: "T3 working", age: "3m", live: true, detail: "T3 is still working: Astra" })
    expect(views[1]).toMatchObject({ state: "done", live: false })
    expect(footerLine([old, newest], "ses_a", NOW)?.text).toBe("handoff mawvxy T3 working 3m")
  })

  it("shows nothing in the footer when nothing is in progress", () => {
    expect(footerLine([job({ phase: "applied" }), job({ sessionID: "ses_b" })], "ses_a", NOW)).toBeUndefined()
  })

  it("lists live handoffs first across sessions", () => {
    const done = job({ id: "01DONE00000000000000000000", phase: "applied", createdAt: NOW - 60_000, sessionID: "ses_b" })
    const failed = job({ id: "01FAIL00000000000000000000", phase: "failed", createdAt: NOW - 30_000, sessionID: "ses_c", lastStatus: "boom" })
    expect(allViews([done, job({ createdAt: NOW - 3600_000 }), failed], NOW).map((v) => v.state)).toEqual(["running", "failed", "done"])
  })
})
