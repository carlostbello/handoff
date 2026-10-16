// Thin git wrapper used by both the daemon (Node) and the plugin (Bun inside opencode).
import { execFile } from "node:child_process"

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message)
  }
}

export interface GitOptions {
  cwd: string
  env?: Record<string, string>
  input?: string
  /** Return stdout as a Buffer (for binary output). */
  binary?: boolean
}

export function git(args: string[], opts: GitOptions & { binary: true }): Promise<Buffer>
export function git(args: string[], opts: GitOptions): Promise<string>
export function git(args: string[], opts: GitOptions): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...opts.env },
        maxBuffer: 1024 * 1024 * 1024,
        encoding: opts.binary ? "buffer" : "utf8",
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null
          const msg = String(stderr).trim() || err.message
          reject(new GitError(`git ${args.join(" ")}: ${msg}`, args, String(stderr), code))
        } else {
          resolve(opts.binary ? (stdout as unknown as Buffer) : String(stdout).replace(/\n$/, ""))
        }
      },
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

export async function gitOk(args: string[], opts: GitOptions): Promise<boolean> {
  try {
    await git(args, opts)
    return true
  } catch {
    return false
  }
}

export async function revParse(cwd: string, rev: string): Promise<string | null> {
  try {
    return await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd })
  } catch {
    return null
  }
}

/** Commits in `range` as {sha, subject}, oldest first. */
export async function commitList(cwd: string, range: string): Promise<Array<{ sha: string; subject: string }>> {
  const out = await git(["log", "--reverse", "--format=%H%x00%s", range], { cwd })
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split("\0")
      return { sha: sha!, subject: subject ?? "" }
    })
}

export function slugify(text: string, max = 40): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "task"
  )
}
