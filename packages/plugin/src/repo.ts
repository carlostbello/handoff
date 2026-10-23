// Git operations on the client: capture a snapshot of the working tree
// without touching the user's index or files, bundle it, and apply results.

import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git, gitOk, revParse } from "@handoff/shared/git"
import { isSecretPath } from "./secrets.js"

const FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: "handoff",
  GIT_AUTHOR_EMAIL: "handoff@localhost",
  GIT_COMMITTER_NAME: "handoff",
  GIT_COMMITTER_EMAIL: "handoff@localhost",
}

export async function repoTop(directory: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], { cwd: directory })
}

export async function identityEnv(cwd: string): Promise<Record<string, string>> {
  const name = await git(["config", "user.name"], { cwd }).catch(() => "")
  const email = await git(["config", "user.email"], { cwd }).catch(() => "")
  return name && email ? {} : FALLBACK_IDENTITY
}

/** Tree of the working directory as `git add -A` would stage it, using a throwaway index. */
export async function workingTree(cwd: string): Promise<string> {
  return (await workingTreeWithSkips(cwd)).tree
}

/** Untracked files that look like secrets; they stay out of every snapshot. */
export async function untrackedSecrets(cwd: string): Promise<string[]> {
  const out = await git(["ls-files", "-z", "--others", "--exclude-standard"], { cwd })
  return out.split("\0").filter((p) => p && isSecretPath(p))
}

/** The working tree minus untracked secret-looking files, and which files those were. */
export async function workingTreeWithSkips(cwd: string): Promise<{ tree: string; skipped: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "handoff-idx-"))
  const index = join(dir, "index")
  try {
    const realIndex = await git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd })
    await copyFile(realIndex, index).catch(() => {}) // reuse stat cache when present
    const env = { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" }
    const skipped = await untrackedSecrets(cwd)
    await git(["add", "-A", "--", "."], { cwd, env: { GIT_INDEX_FILE: index } })
    if (skipped.length) await git(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...skipped], { cwd, env })
    return { tree: await git(["write-tree"], { cwd, env }), skipped }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface Snapshot {
  branch: string | null
  head: string | null
  snapshot: string
  snapshotRef: string
  remotes: Record<string, string>
  /** Untracked secret-looking files left out. */
  skipped: string[]
}

export async function takeSnapshot(cwd: string, jobId: string): Promise<Snapshot> {
  const head = await revParse(cwd, "HEAD")
  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd }).catch(() => "")) || null
  const { tree, skipped } = await workingTreeWithSkips(cwd)
  let snapshot = head
  if (!head || (await git(["rev-parse", `${head}^{tree}`], { cwd })) !== tree) {
    const args = ["commit-tree", tree, "-m", `WIP: uncommitted changes at handoff (${jobId})`]
    if (head) args.push("-p", head)
    snapshot = await git(args, { cwd, env: await identityEnv(cwd) })
  }
  const snapshotRef = `refs/handoff/${jobId}/snapshot`
  await git(["update-ref", snapshotRef, snapshot!], { cwd })
  return { branch, head, snapshot: snapshot!, snapshotRef, remotes: await remotes(cwd), skipped }
}

/** Re-point a previous job's snapshot at a new job id (used when resubmitting). */
export async function adoptSnapshot(cwd: string, jobId: string, prev: { branch: string | null; head: string | null; snapshot: string }): Promise<Snapshot> {
  const snapshotRef = `refs/handoff/${jobId}/snapshot`
  await git(["update-ref", snapshotRef, prev.snapshot], { cwd })
  return { branch: prev.branch, head: prev.head, snapshot: prev.snapshot, snapshotRef, remotes: await remotes(cwd), skipped: [] }
}

async function remotes(cwd: string): Promise<Record<string, string>> {
  const out = await git(["remote", "-v"], { cwd }).catch(() => "")
  const result: Record<string, string> = {}
  for (const line of out.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/)
    if (m) result[m[1]!] = m[2]!.replace(/\/\/[^/@]*@/, "//") // strip embedded credentials
  }
  return result
}

/**
 * Bundle the snapshot ref. Incremental against `base` when it is an ancestor.
 * Returns an empty buffer when there is nothing new (the host already has the snapshot).
 */
export async function createBundle(cwd: string, snap: Snapshot, base: string | null): Promise<{ bundle: Uint8Array; base: string | null }> {
  let useBase = base && (await revParse(cwd, base)) && (await gitOk(["merge-base", "--is-ancestor", base, snap.snapshot], { cwd })) ? base : null
  if (useBase === snap.snapshot) return { bundle: new Uint8Array(), base: useBase }
  const dir = await mkdtemp(join(tmpdir(), "handoff-bundle-"))
  try {
    const path = join(dir, "request.bundle")
    const args = ["bundle", "create", "-q", path, snap.snapshotRef]
    if (useBase) args.push(`^${useBase}`)
    await git(args, { cwd })
    return { bundle: await readFile(path), base: useBase }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export type ApplyOutcome =
  | { kind: "fast-forwarded"; branch: string; note?: string }
  | { kind: "branch-only"; reason: string }
  | { kind: "no-changes" }

/**
 * Fetch the result branch and, if the user's checkout hasn't moved since the
 * handoff, fast-forward their branch onto the agent's commits.
 */
export async function applyResult(input: {
  cwd: string
  bundle: Uint8Array
  resultBranch: string
  resultHead: string | null
  origBranch: string | null
  origHead: string | null
  snapshot: string
  workDir: string
  /** auto: fast-forward when safe; branch: only create the result branch. */
  mode: "auto" | "branch"
}): Promise<ApplyOutcome> {
  const { cwd, resultBranch, resultHead } = input
  if (!resultHead || input.bundle.length === 0) return { kind: "no-changes" }
  if (!(await gitOk(["check-ref-format", "--branch", resultBranch], { cwd }))) throw new Error(`invalid result branch name ${resultBranch}`)

  const path = join(input.workDir, "result.bundle")
  await writeFile(path, input.bundle, { mode: 0o600 })
  try {
    // No "+": an existing local branch of that name is only ever fast-forwarded, never overwritten.
    await git(["fetch", "--no-tags", "-q", path, `refs/heads/${resultBranch}:refs/heads/${resultBranch}`], { cwd })
  } finally {
    await rm(path, { force: true })
  }

  if (input.mode === "branch") return { kind: "branch-only", reason: "`apply` is set to `branch`" }
  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd }).catch(() => "")) || null
  const head = await revParse(cwd, "HEAD")
  if (!input.origBranch || branch !== input.origBranch) {
    return { kind: "branch-only", reason: input.origBranch ? `you are no longer on \`${input.origBranch}\`` : "you were on a detached HEAD" }
  }
  if (head !== input.origHead) return { kind: "branch-only", reason: `\`${branch}\` has new commits since the handoff` }
  const snapshotTree = await git(["rev-parse", `${input.snapshot}^{tree}`], { cwd })
  if ((await workingTree(cwd)) !== snapshotTree) {
    return { kind: "branch-only", reason: "your working tree changed since the handoff" }
  }

  // Working tree == snapshot, so its uncommitted changes are already inside the
  // snapshot commit. Stash them, fast-forward, and drop the stash on success.
  // Untracked secret files aren't in the snapshot, so they're stashed too and must come back.
  const secrets = await untrackedSecrets(cwd)
  const dirty = secrets.length > 0 || (head ? (await git(["rev-parse", `${head}^{tree}`], { cwd })) !== snapshotTree : true)
  if (dirty) await git(["stash", "push", "--include-untracked", "-q", "-m", `handoff ${resultBranch}`], { cwd })
  try {
    await git(["merge", "--ff-only", "-q", resultBranch], { cwd })
  } catch (err) {
    if (dirty) await git(["stash", "pop", "-q"], { cwd }).catch(() => {})
    return { kind: "branch-only", reason: `fast-forward failed: ${(err as Error).message.split("\n")[0]}` }
  }
  if (secrets.length) {
    // The stash's third parent holds its untracked files. Keep the stash if they can't be restored.
    const restored = await gitOk(["checkout", "stash@{0}^3", "--", ...secrets], { cwd, env: { GIT_LITERAL_PATHSPECS: "1" } })
    if (restored) await git(["reset", "-q", "--", ...secrets], { cwd, env: { GIT_LITERAL_PATHSPECS: "1" } }).catch(() => {})
    else return { kind: "fast-forwarded", branch, note: "Your untracked secret files are in `git stash list` (top entry); restore them with `git checkout stash@{0}^3 -- <file>`." }
  }
  if (dirty) await git(["stash", "drop", "-q"], { cwd }).catch(() => {})
  return { kind: "fast-forwarded", branch }
}

export async function deleteRef(cwd: string, ref: string): Promise<void> {
  await git(["update-ref", "-d", ref], { cwd }).catch(() => {})
}
