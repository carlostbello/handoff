// Manual helper: one daemon pass using the real daemon config (HANDOFF_CONFIG_DIR)
// with the fake agent. DAEMON_ONCE=1 HANDOFF_CONFIG_DIR=... HANDOFF_STATE_DIR=... npx vitest run tests/daemon-once
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createFakeT3 } from "./support/fake-t3.js"

describe.skipIf(!process.env.DAEMON_ONCE)("daemon pass with fake T3", () => {
  it("processes queued jobs", async () => {
    const { loadConfig, STATE_DIR } = await import("../packages/daemon/src/config.js")
    const { Runner } = await import("../packages/daemon/src/runner.js")
    const config = await loadConfig()
    config.reposDir = join(STATE_DIR, "repos")
    config.jobsDir = join(STATE_DIR, "jobs")
    const t3 = createFakeT3(join(STATE_DIR, "worktrees"))
    await new Runner(config, t3 as never).runOnce()
    expect(t3.launches.length).toBeGreaterThan(0)
    console.log(JSON.stringify(t3.launches.map((l) => ({ title: l.title, branch: l.branch })), null, 2))
  }, 60_000)
})
