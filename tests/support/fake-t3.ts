// A stand-in for T3 Code that behaves like an agent: creates the worktree,
// commits one change, and leaves another uncommitted.
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

export interface FakeLaunch {
  message: string
  branch: string
  baseRef: string
  title: string
  args: Record<string, any>
}

export interface FakeHooks {
  onLaunch?: () => void
  /**
   * Simulate an async subagent: the lead's run ends while the subagent is still
   * working for this many polls, then the subagent commits and finishes.
   */
  subagentPolls?: number
  /**
   * Simulate a subagent's wake-up that T3 cancelled before it started because the
   * lead was still busy: t3_thread_wait reports that cancelled run while the lead's
   * own run keeps going for this many status checks, then commits and finishes.
   */
  leadStillRunningPolls?: number
}

export function createFakeT3(worktreesDir: string, hooks: FakeHooks = {}) {
  const projects = new Map<string, string>()
  const threads = new Map<string, { worktree: string; branch: string; title: string; projectId: string; run: number; text: string; asked?: string }>()
  const sends: Array<{ threadId: string; message: string }> = []
  const commitIn = (worktree: string, file: string, line: string, subject: string) => {
    const prev = existsSync(join(worktree, file)) ? readFileSync(join(worktree, file), "utf8") : ""
    writeFileSync(join(worktree, file), prev + line + "\n")
    sh(worktree, "add", "-A")
    sh(worktree, "-c", "user.name=Agent", "-c", "user.email=a@x", "commit", "-q", "-m", subject)
  }
  const launches: FakeLaunch[] = []
  const subagents = new Map<string, number>()
  const leadRunning = new Map<string, number>()
  const t3 = {
    launches,
    sends,
    hooks,
    projects,
    /** Simulate the user replying to the agent in T3 itself: a new run, optionally with a commit. */
    simulateReply(threadId: string, opts: { commit?: string; text?: string; asked?: string } = {}) {
      const t = threads.get(threadId)!
      if (opts.commit) commitIn(t.worktree, "t3.txt", opts.commit, `Agent: ${opts.commit}`)
      if (opts.asked) t.asked = opts.asked
      t.run++
      if (opts.text) t.text = opts.text
    },
    async ensureProject(root: string, title: string) {
      const id = `proj-${title}-${root.length}`
      projects.set(id, root)
      return { id, title, workspaceRoot: root }
    },
    async findThreadByTitle(projectId: string, titleContains: string) {
      for (const [threadId, t] of threads) if (t.projectId === projectId && t.title.includes(titleContains)) return { threadId } as never
      return undefined
    },
    async launch(args: Record<string, any>) {
      const ws = args.workspaceStrategy
      const repo = projects.get(args.projectId)!
      const worktree = join(worktreesDir, ws.branch.replace(/\//g, "_"))
      sh(repo, "worktree", "add", "-q", "-b", ws.branch, worktree, ws.baseRef)
      const file = existsSync(join(worktree, "app.txt")) ? "app.txt" : "CHANGELOG.md"
      const prev = existsSync(join(worktree, file)) ? readFileSync(join(worktree, file), "utf8") : ""
      writeFileSync(join(worktree, file), prev + "agent change\n")
      sh(worktree, "add", "-A")
      sh(worktree, "-c", "user.name=Agent", "-c", "user.email=a@x", "commit", "-q", "-m", `Agent: update ${file}`)
      writeFileSync(join(worktree, "NOTES.md"), "left uncommitted\n")
      const threadId = `thread-${threads.size + 1}`
      threads.set(threadId, { worktree, branch: ws.branch, title: args.title, projectId: args.projectId, run: 1, text: "Made the requested change and left notes. Verified by reading the file." })
      launches.push({ message: args.message, branch: ws.branch, baseRef: ws.baseRef, title: args.title, args })
      if (hooks.subagentPolls) subagents.set(threadId, hooks.subagentPolls)
      if (hooks.leadStillRunningPolls) leadRunning.set(threadId, hooks.leadStillRunningPolls)
      hooks.onLaunch?.()
      return threadId
    },
    async wait(threadId: string) {
      const status = leadRunning.has(threadId) ? "cancelled" : "completed"
      return { threadId, runId: `r${threads.get(threadId)?.run ?? 1}`, status, timedOut: false }
    },
    configures: [] as Array<{ threadId: string; modelSelection: Record<string, unknown> }>,
    async configure(threadId: string, modelSelection: Record<string, unknown>) {
      t3.configures.push({ threadId, modelSelection })
    },
    async send(threadId: string, message: string) {
      const t = threads.get(threadId)!
      sends.push({ threadId, message })
      commitIn(t.worktree, "followup.txt", `follow-up ${sends.length}`, `Agent: follow-up ${sends.length}`)
      t.run++
      t.text = `Handled follow-up ${sends.length}.`
    },
    async activeSubagents(_projectId: string, threadId: string) {
      const left = subagents.get(threadId)
      if (left === undefined) return []
      if (left > 0) {
        subagents.set(threadId, left - 1)
        return [{ threadId: `${threadId}-sub`, title: "Sol: implement", status: "running" }]
      }
      subagents.delete(threadId)
      const { worktree } = threads.get(threadId)!
      writeFileSync(join(worktree, "subagent.txt"), "from the subagent\n")
      sh(worktree, "add", "subagent.txt")
      sh(worktree, "-c", "user.name=Agent", "-c", "user.email=a@x", "commit", "-q", "-m", "Subagent: add subagent.txt")
      return []
    },
    async thread(threadId: string) {
      const t = threads.get(threadId)!
      return { threadId, projectId: t.projectId, title: t.title, status: "completed", branch: t.branch, worktreePath: t.worktree, pendingRequestCount: 0, latestRunId: `r${t.run}` }
    },
    async finalRunStatus(threadId: string) {
      const left = leadRunning.get(threadId)
      if (left === undefined) return "completed"
      if (left > 0) {
        leadRunning.set(threadId, left - 1)
        return "running"
      }
      leadRunning.delete(threadId)
      commitIn(threads.get(threadId)!.worktree, "lead.txt", "finished", "Lead: finish after the subagent reported")
      return "completed"
    },
    async lastUserMessage(threadId: string) {
      return threads.get(threadId)?.asked ?? ""
    },
    async finalAssistantText(threadId: string) {
      return threads.get(threadId)?.text ?? ""
    },
    async pendingRequests() {
      return [] as string[]
    },
    async readPendingRequest() {
      return {}
    },
    async respond() {},
    async interrupt() {},
    async close() {},
  }
  return t3
}
