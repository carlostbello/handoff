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
}

export function createFakeT3(worktreesDir: string, hooks: FakeHooks = {}) {
  const projects = new Map<string, string>()
  const threads = new Map<string, { worktree: string; branch: string; title: string; projectId: string }>()
  const launches: FakeLaunch[] = []
  const subagents = new Map<string, number>()
  const t3 = {
    launches,
    hooks,
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
      threads.set(threadId, { worktree, branch: ws.branch, title: args.title, projectId: args.projectId })
      launches.push({ message: args.message, branch: ws.branch, baseRef: ws.baseRef, title: args.title, args })
      if (hooks.subagentPolls) subagents.set(threadId, hooks.subagentPolls)
      hooks.onLaunch?.()
      return threadId
    },
    async wait(threadId: string) {
      return { threadId, runId: "r", status: "completed", timedOut: false }
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
      return { threadId, projectId: t.projectId, title: t.title, status: "completed", branch: t.branch, worktreePath: t.worktree, pendingRequestCount: 0, latestRunId: "r" }
    },
    async finalRunStatus() {
      return "completed"
    },
    async finalAssistantText() {
      return "Made the requested change and left notes. Verified by reading the file."
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
