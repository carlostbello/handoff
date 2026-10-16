// Live probe of the daemon's T3 client against a running T3 Code server.
// T3_PROBE_TOKEN=<mcp-client bearer> npx vitest run tests/t3-probe
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const token = process.env.T3_PROBE_TOKEN

describe.skipIf(!token)("T3 MCP probe", () => {
  it("creates a project, launches a worktree thread, waits, and reads the result", async () => {
    const { T3 } = await import("../packages/daemon/src/t3.js")
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "handoff-probe-")))
    const sh = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim()
    sh("init", "-q", "-b", "handoff-mirror")
    writeFileSync(join(repo, "README.md"), "probe\n")
    sh("add", ".")
    sh("-c", "user.name=p", "-c", "user.email=p@x", "commit", "-qm", "init")
    sh("branch", "handoff-base/PROBE")

    const t3 = new T3({ t3: { runtimeFile: join(homedir(), ".t3/userdata/server-runtime.json"), accessToken: token } } as never)
    const project = await t3.ensureProject(repo, "handoff-probe")
    console.log("project", project.id)
    expect((await t3.ensureProject(repo, "handoff-probe")).id).toBe(project.id) // idempotent

    const threadId = await t3.launch({
      projectId: project.id,
      title: "Handoff probe [PROBE1]",
      message: "Reply with exactly the text HANDOFF-OK and nothing else. Do not use any tools.",
      runtimeMode: "approval-required",
      modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-4-5" },
      workspaceStrategy: { type: "worktree", baseRef: "handoff-base/PROBE", branch: "handoff/probe-1", startFromOrigin: false },
    })
    console.log("thread", threadId)
    expect((await t3.findThreadByTitle(project.id, "[PROBE1]"))?.threadId).toBe(threadId)

    let res
    for (let i = 0; i < 6; i++) {
      res = await t3.wait(threadId, 30_000)
      console.log("wait", JSON.stringify(res))
      if (!res.timedOut && !["running", "starting", "queued", "preparing", "waiting"].includes(res.status)) break
    }
    const thread = await t3.thread(threadId)
    console.log("thread state", JSON.stringify({ status: thread.status, branch: thread.branch, worktreePath: thread.worktreePath }))
    const text = await t3.finalAssistantText(threadId)
    console.log("final text:", JSON.stringify(text))
    expect(text).toContain("HANDOFF-OK")
    expect(thread.branch).toBe("handoff/probe-1")
    expect(thread.worktreePath).toBeTruthy()
    expect(await t3.pendingRequests(threadId)).toEqual([])

    const del = await t3.call("t3_project_delete", { projectId: project.id }).catch((e: Error) => e.message)
    console.log("delete:", JSON.stringify(del).slice(0, 300))
    await t3.close()
  }, 240_000)
})
