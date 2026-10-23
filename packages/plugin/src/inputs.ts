// Inputs: material beyond the handoff's snapshot that the host agent needs, such as
// another branch or commit, or files from another repository or folder. Each input
// becomes one commit in its own git bundle. Anything from the handed-off repository
// (including its other worktrees) goes automatically; anything else needs the user's OK.
// Secret-looking files never go.

import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { sha256Hex, type DeliveredInput, type InputSpec, type RefusedInput } from "@handoff/shared"
import { git, gitOk, revParse } from "@handoff/shared/git"
import { identityEnv, workingTreeWithSkips } from "./repo.js"
import { isSecretPath, summarizeSkipped } from "./secrets.js"

/** Inputs are held in memory and uploaded with the request; keep them reasonable. */
export const MAX_INPUT_BYTES = 256 * 1024 * 1024

export interface ReviewedInput {
  spec: InputSpec
  /** "send": allowed by policy. "ask": needs the user's approval. "refuse": can't be sent as asked. */
  decision: "send" | "ask" | "refuse"
  reason?: string
  /** Resolved folder on this machine. */
  src?: string
  /** For git folders: the repository's top level, the folder's path inside it, and the resolved ref. */
  top?: string
  prefix?: string
  commit?: string | null
}

const display = (path: string) => (path.startsWith(homedir() + "/") ? `~/${path.slice(homedir().length + 1)}` : path)

async function commonDir(cwd: string): Promise<string | null> {
  const dir = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }).catch(() => null)
  return dir ? realpath(dir).catch(() => dir) : null
}

/** A branch, tag, commit, or a branch that only exists as a remote-tracking ref (origin first). */
export async function resolveRef(cwd: string, ref: string): Promise<string | null> {
  const direct = await revParse(cwd, ref)
  if (direct) return direct
  const refs = (await git(["for-each-ref", "--format=%(refname)", "refs/remotes"], { cwd }).catch(() => "")).split("\n").filter(Boolean)
  const matches = refs.filter((r) => r.split("/").slice(3).join("/") === ref).sort((a, b) => Number(b.startsWith("refs/remotes/origin/")) - Number(a.startsWith("refs/remotes/origin/")))
  return matches.length ? revParse(cwd, matches[0]!) : null
}

/** Where each input would come from and whether it may go without asking. */
export async function reviewInputs(specs: InputSpec[], repoTop: string): Promise<ReviewedInput[]> {
  const home = await commonDir(repoTop)
  const out: ReviewedInput[] = []
  for (const spec of specs) {
    const raw = spec.repo?.trim()
    const path = !raw ? repoTop : raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : resolve(repoTop, raw)
    let src = await realpath(path).catch(() => null)
    if (!src) {
      out.push({ spec, decision: "refuse", reason: `\`${raw}\` doesn't exist on the user's machine` })
      continue
    }
    let reviewed: InputSpec = spec
    if (!(await stat(src)).isDirectory()) {
      // A single file: send it from its folder.
      if (spec.paths?.length) {
        out.push({ spec, decision: "refuse", reason: `\`${raw}\` is a file; "paths" only apply to folders` })
        continue
      }
      reviewed = { ...spec, paths: [basename(src)] }
      src = dirname(src)
    }
    if (!(await gitOk(["rev-parse", "--git-dir"], { cwd: src }))) {
      if (reviewed.ref) out.push({ spec: reviewed, src, decision: "refuse", reason: `\`${display(src)}\` isn't a git repository, so it has no ref \`${reviewed.ref}\`` })
      else out.push({ spec: reviewed, src, decision: "ask", reason: "a folder outside the handed-off repository" })
      continue
    }
    const top = await git(["rev-parse", "--show-toplevel"], { cwd: src })
    const prefix = relative(await realpath(top), src)
    const commit = reviewed.ref ? await resolveRef(top, reviewed.ref) : null
    if (reviewed.ref && !commit) {
      out.push({ spec: reviewed, src, top, prefix, decision: "refuse", reason: `\`${reviewed.ref}\` isn't in \`${display(top)}\` on the user's machine; a \`git fetch\` there may bring it` })
      continue
    }
    const base = { spec: reviewed, src, top, prefix, commit }
    if (reviewed.mode === "history" && commit) {
      const secrets = (await git(["ls-tree", "-r", "-z", "--name-only", commit], { cwd: top })).split("\0").filter((p) => p && isSecretPath(p))
      if (secrets.length) {
        out.push({ ...base, decision: "refuse", reason: `its history includes secret-looking files (${summarizeSkipped(secrets, 5)}); ask for "source" mode instead` })
        continue
      }
    }
    // Same repository (also another worktree of it): same git common dir.
    const same = home !== null && (await commonDir(top)) === home
    out.push(same ? { ...base, decision: "send" } : { ...base, decision: "ask", reason: "another repository on the user's machine" })
  }
  return out
}

/**
 * Bundle one input. `id` names the bundle ref; `exclude` lists commits the host already
 * has (the handoff's snapshot), so history from the same repository stays incremental.
 */
export async function packInput(
  input: ReviewedInput,
  id: string,
  approvedBy: DeliveredInput["approvedBy"],
  exclude: string[] = [],
): Promise<{ input: DeliveredInput; bundle: Uint8Array }> {
  const { spec, src } = input
  if (!src) throw new Error("nothing to send")
  const mode = spec.mode ?? "source"
  const tmp = await mkdtemp(join(tmpdir(), "handoff-input-"))
  const bundleRef = `refs/handoff/${id}/input/${spec.name}`
  try {
    let cwd: string
    let env: Record<string, string> = {}
    let tree: string
    let commit: string
    let skipped: string[] = []
    const paths = input.top ? (input.prefix ? (spec.paths?.length ? spec.paths.map((p) => join(input.prefix!, p)) : [input.prefix]) : (spec.paths ?? [])) : (spec.paths ?? [])

    if (input.top) {
      cwd = input.top
      if (mode === "history") {
        commit = input.commit!
        tree = await git(["rev-parse", `${commit}^{tree}`], { cwd })
      } else {
        let base: string
        if (input.commit) base = await git(["rev-parse", `${input.commit}^{tree}`], { cwd })
        else ({ tree: base, skipped } = await workingTreeWithSkips(cwd))
        const picked = await pickTree(cwd, base, paths, join(tmp, "index"))
        tree = picked.tree
        skipped = [...skipped, ...picked.skipped]
        commit = await git(["commit-tree", tree, "-m", commitMessage(spec, input.commit ?? null, src)], { cwd, env: await identityEnv(cwd) })
      }
    } else {
      // A plain folder: stage it into a scratch repository.
      cwd = src
      env = { GIT_DIR: join(tmp, "repo.git"), GIT_WORK_TREE: src, GIT_INDEX_FILE: join(tmp, "index") }
      await git(["init", "-q", "--bare", env.GIT_DIR!], { cwd: tmp })
      await git(["add", "-A", "--", ...(paths.length ? paths : ["."])], { cwd, env })
      skipped = (await git(["ls-files", "-z"], { cwd, env })).split("\0").filter((p) => p && isSecretPath(p))
      if (skipped.length) await git(["rm", "-q", "--cached", "--", ...skipped], { cwd, env: { ...env, GIT_LITERAL_PATHSPECS: "1" } })
      tree = await git(["write-tree"], { cwd, env })
      if (tree === EMPTY_TREE) throw new Error("nothing to send at those paths")
      commit = await git(["commit-tree", tree, "-m", commitMessage(spec, null, src)], { cwd, env: { ...env, ...(await identityEnv(cwd)) } })
    }

    await git(["update-ref", bundleRef, commit], { cwd, env })
    try {
      const path = join(tmp, "input.bundle")
      const negatives = []
      if (mode === "history") for (const c of exclude) if (await revParse(cwd, c)) negatives.push(`^${c}`)
      // A commit the host already has makes an empty bundle, which git refuses; send it whole then.
      const created = await gitOk(["bundle", "create", "-q", path, bundleRef, ...negatives], { cwd, env })
      if (!created) await git(["bundle", "create", "-q", path, bundleRef], { cwd, env })
      const bundle = await readFile(path)
      if (bundle.length > MAX_INPUT_BYTES) throw new Error(`too large (${Math.round(bundle.length / 1048576)} MB; the limit is ${MAX_INPUT_BYTES / 1048576} MB). Ask for fewer paths`)
      return {
        input: {
          name: spec.name,
          repo: display(input.top ?? src),
          ref: spec.ref ?? null,
          sourceCommit: input.commit ?? null,
          paths,
          mode,
          commit,
          tree,
          bundleRef,
          size: bundle.length,
          sha256: await sha256Hex(bundle),
          approvedBy,
          skipped,
        },
        bundle,
      }
    } finally {
      await git(["update-ref", "-d", bundleRef], { cwd, env }).catch(() => {})
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/** `base` narrowed to `paths`, without secret-looking files. */
async function pickTree(cwd: string, base: string, paths: string[], index: string): Promise<{ tree: string; skipped: string[] }> {
  const listing = await git(["ls-tree", "-r", "-z", "--full-tree", base, "--", ...paths], { cwd, env: { GIT_LITERAL_PATHSPECS: "1" } })
  const entries = listing.split("\0").filter(Boolean)
  const skipped: string[] = []
  const kept = entries.filter((e) => {
    const path = e.slice(e.indexOf("\t") + 1)
    if (!isSecretPath(path)) return true
    skipped.push(path)
    return false
  })
  if (!kept.length) throw new Error(entries.length ? "only secret-looking files at those paths" : `nothing at ${paths.length ? paths.map((p) => `\`${p}\``).join(", ") : "that ref"}`)
  if (!paths.length && !skipped.length) return { tree: base, skipped }
  const env = { GIT_INDEX_FILE: index }
  await git(["update-index", "-z", "--index-info"], { cwd, env, input: kept.join("\0") + "\0" })
  return { tree: await git(["write-tree"], { cwd, env }), skipped }
}

function commitMessage(spec: InputSpec, commit: string | null, src: string): string {
  const what = spec.ref ? `${spec.ref}${commit ? ` (${commit})` : ""}` : "current files"
  return `handoff input ${spec.name}: ${what}${spec.paths?.length ? ` [${spec.paths.join(", ")}]` : ""}\n\nFrom ${display(src)} on the user's machine.`
}

/**
 * Pack every reviewed input that may go. Inputs needing approval go only when
 * `approvedByUser`; the rest, and any that fail to pack, are reported as refused.
 */
export async function packInputs(
  reviewed: ReviewedInput[],
  id: string,
  opts: { approvedByUser: boolean; exclude?: string[]; refuseReason?: string },
): Promise<{ delivered: DeliveredInput[]; refused: RefusedInput[]; bundles: Uint8Array[] }> {
  const delivered: DeliveredInput[] = []
  const refused: RefusedInput[] = []
  const bundles: Uint8Array[] = []
  let total = 0
  for (const r of reviewed) {
    if (opts.refuseReason) {
      refused.push({ name: r.spec.name, reason: opts.refuseReason })
      continue
    }
    if (r.decision === "refuse" || (r.decision === "ask" && !opts.approvedByUser)) {
      refused.push({ name: r.spec.name, reason: r.decision === "ask" ? `needs the user's approval (${r.reason})` : r.reason ?? "refused" })
      continue
    }
    try {
      const packed = await packInput(r, id, r.decision === "ask" ? "user" : "policy", opts.exclude)
      if (total + packed.bundle.length > MAX_INPUT_BYTES) throw new Error(`the inputs together exceed ${MAX_INPUT_BYTES / 1048576} MB; ask for fewer at a time`)
      total += packed.bundle.length
      delivered.push(packed.input)
      bundles.push(packed.bundle)
    } catch (err) {
      refused.push({ name: r.spec.name, reason: (err as Error).message })
    }
  }
  return { delivered, refused, bundles }
}
