// Inputs: material from the client's machine that isn't in the snapshot (another
// branch or commit, files from another repository). They arrive as git bundles,
// up front in the handoff request or later in a delivery job, and are filed
// under the handoff job: a ref in the mirror plus a plain copy of the files.

import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  INPUT_BUNDLE_REF,
  INPUT_NAME,
  normalizeInputList,
  sha256Hex,
  type DeliveredInput,
  type InputSpec,
  type RefusedInput,
} from "@handoff/shared"
import { git, revParse } from "@handoff/shared/git"

const run = promisify(execFile)

/** A delivered input as filed on the host; also one entry of receipts.json. */
export interface ImportedInput extends DeliveredInput {
  localRef: string
  dir: string
  receivedAt: number
}

/** The ref an input lives under in the mirror. */
export const inputRef = (jobId: string, name: string) => `refs/handoff/inputs/${jobId}/${name}`

/**
 * Split a request payload into the leading bundle (the snapshot; empty for a delivery)
 * and one bundle per delivered input, which follow it in order.
 */
export function splitPayload(payload: Uint8Array, delivered: readonly DeliveredInput[]): { lead: Uint8Array; bundles: Uint8Array[] } {
  let total = 0
  for (const d of delivered) {
    if (!Number.isSafeInteger(d.size) || d.size <= 0) throw new Error(`input ${d.name}: invalid size`)
    total += d.size
  }
  if (total > payload.length) throw new Error("request payload is shorter than its inputs")
  let at = payload.length - total
  const lead = payload.subarray(0, at)
  const bundles = delivered.map((d) => payload.subarray(at, (at += d.size)))
  return { lead, bundles }
}

/** What the agent wrote in a request file: `{ inputs, note }`, a list, or a single spec. */
export function parseInputRequest(raw: unknown): { inputs: InputSpec[]; note?: string } {
  const inputs = normalizeInputList(raw)
  const note = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { note?: unknown }).note : undefined
  return { inputs, ...(typeof note === "string" && note.trim() ? { note: note.trim().slice(0, 2000) } : {}) }
}

const MISSING_CAP = 4000

/** The text after the last line starting with `BLOCKED:`, through the end; null if there is none. */
export function parseBlocked(text: string): string | null {
  const matches = [...text.matchAll(/^[ \t>*_]*BLOCKED:[*_]*/gm)]
  const last = matches.at(-1)
  if (!last) return null
  const missing = text.slice(last.index + last[0].length).trim()
  return (missing || "(the agent didn't say what it needs)").slice(0, MISSING_CAP)
}

/**
 * Import inputs into the mirror (`repoDir`) under `jobId`, and extract each one's files to
 * `<jobDir>/inputs/<name>/`. Each input stands alone: one that can't be imported is
 * returned in `failed` with the reason.
 */
export async function importInputs(opts: {
  repoDir: string
  jobDir: string
  jobId: string
  items: Array<{ input: DeliveredInput; bytes: Uint8Array }>
}): Promise<{ imported: ImportedInput[]; failed: RefusedInput[] }> {
  const { repoDir, jobDir, jobId } = opts
  const inputsDir = join(jobDir, "inputs")
  await mkdir(inputsDir, { recursive: true, mode: 0o700 })
  await neutralizeExportAttributes(repoDir)
  const imported: ImportedInput[] = []
  const failed: RefusedInput[] = []
  const seen = new Set<string>()
  for (const { input, bytes } of opts.items) {
    const name = String(input.name)
    try {
      if (!INPUT_NAME.test(name)) throw new Error("invalid name")
      if (seen.has(name)) throw new Error("name is used twice")
      seen.add(name)
      imported.push(await importOne(repoDir, inputsDir, jobId, input, bytes))
    } catch (err) {
      failed.push({ name, reason: `couldn't be imported on the host: ${(err as Error).message}` })
    }
  }
  if (imported.length) await writeReceipts(inputsDir, imported)
  return { imported, failed }
}

async function importOne(repoDir: string, inputsDir: string, jobId: string, input: DeliveredInput, bytes: Uint8Array): Promise<ImportedInput> {
  if (!INPUT_BUNDLE_REF.test(input.bundleRef)) throw new Error("invalid bundle ref")
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(input.commit)) throw new Error("invalid commit")
  if ((await sha256Hex(bytes)) !== input.sha256) throw new Error("SHA-256 mismatch")
  const localRef = inputRef(jobId, input.name)
  const dir = join(inputsDir, input.name)
  const bundle = join(inputsDir, `.${input.name}.bundle`)
  const tar = join(inputsDir, `.${input.name}.tar`)
  try {
    await writeFile(bundle, bytes, { mode: 0o600 })
    // Forced, so a later delivery under the same name replaces the earlier one.
    await git(["fetch", "--no-tags", bundle, `+${input.bundleRef}:${localRef}`], { cwd: repoDir })
    if ((await revParse(repoDir, localRef)) !== input.commit) throw new Error("bundle doesn't hold the commit it describes")
    // revParse peels to a commit, so ask git for the tree directly.
    const tree = await git(["rev-parse", "--verify", "--quiet", `${localRef}^{tree}`], { cwd: repoDir }).catch(() => null)
    if (tree !== input.tree) throw new Error("tree mismatch")
    // A plain copy of the files, without touching the mirror's index or checkout.
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await git(["archive", "--format=tar", "-o", tar, localRef], { cwd: repoDir })
    await run("tar", ["-xf", tar, "-C", dir])
  } finally {
    await rm(bundle, { force: true })
    await rm(tar, { force: true })
  }
  return { ...input, localRef, dir, receivedAt: Date.now() }
}

/** The agent's record of what it received: newest entry per name. */
async function writeReceipts(inputsDir: string, imported: ImportedInput[]): Promise<void> {
  const path = join(inputsDir, "receipts.json")
  const prior = await readFile(path, "utf8")
    .then((t) => JSON.parse(t) as ImportedInput[])
    .catch(() => [] as ImportedInput[])
  const names = new Set(imported.map((i) => i.name))
  const all = [...(Array.isArray(prior) ? prior : []).filter((r) => !names.has(r.name)), ...imported]
  await writeFile(path, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 })
}

const EXPORT_LINE = "* -export-ignore -export-subst"

/**
 * git archive honours export-ignore/export-subst from the archived tree's .gitattributes,
 * which would drop or rewrite delivered files; $GIT_DIR/info/attributes overrides them.
 */
async function neutralizeExportAttributes(repoDir: string): Promise<void> {
  const gitDir = await git(["rev-parse", "--absolute-git-dir"], { cwd: repoDir })
  const path = join(gitDir, "info", "attributes")
  const current = await readFile(path, "utf8").catch(() => "")
  if (current.split("\n").includes(EXPORT_LINE)) return
  await mkdir(join(gitDir, "info"), { recursive: true })
  await appendFile(path, `${current && !current.endsWith("\n") ? "\n" : ""}${EXPORT_LINE}\n`)
}

/** How an input is described to the agent: what it is, and where it is. */
export function describeImported(i: ImportedInput | (DeliveredInput & { dir: string; localRef: string })): string {
  const what = i.ref ? `\`${i.ref}\`${i.sourceCommit ? ` (commit ${i.sourceCommit.slice(0, 12)})` : ""}` : "the current files"
  const only = i.paths.length ? `, only ${i.paths.map((p) => `\`${p}\``).join(", ")}` : ""
  const mode = i.mode === "history" ? ", with history" : ""
  const skipped = i.skipped.length ? ` Left out as secret-looking: ${capList(i.skipped, 10)}.` : ""
  const approved = i.approvedBy === "user" ? "approved by the user" : "allowed by the user's sharing settings"
  return `- **${i.name}**: ${what} of \`${i.repo}\`${only}${mode} (${approved}). Files: \`${i.dir}/\`. Git ref: \`${i.localRef}\` (commit ${i.commit.slice(0, 12)}, tree ${i.tree.slice(0, 12)}).${skipped}`
}

export function capList(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).map((s) => `\`${s}\``).join(", ")
  return items.length > max ? `${shown} and ${items.length - max} more` : shown
}

/** The message that tells the agent a delivery arrived (or what came of it). */
export function deliveryNote(opts: { inputsDir: string; imported: ImportedInput[]; refused: RefusedInput[]; message?: string }): string {
  const { inputsDir, imported, refused, message } = opts
  const lines: string[] = []
  if (imported.length) {
    lines.push("Inputs arrived from the user's machine. They were approved there and are inputs for this task:")
    lines.push(...imported.map(describeImported))
  } else {
    lines.push("The user's machine answered your request for inputs, but sent nothing.")
  }
  if (refused.length) lines.push("", "Not sent:", ...refused.map((r) => `- **${r.name}**: ${r.reason}`))
  if (message?.trim()) lines.push("", `Note from the user's machine: ${message.trim().slice(0, 4000)}`)
  if (imported.length) lines.push("", `Source commits, trees, SHA-256s and approvals are in \`${join(inputsDir, "receipts.json")}\`.`)
  lines.push("", imported.length ? "Continue the task." : "Continue with what you have, or ask differently; if you can't proceed, end with a `BLOCKED:` line.")
  return lines.join("\n")
}

/** Every message handoff sends into a thread on its own starts with this. */
export const NOTE_PREFIX = "Handoff update:"

export function combineNotes(notes: readonly string[]): string {
  return `${NOTE_PREFIX}\n\n${notes.join("\n\n---\n\n")}`
}
