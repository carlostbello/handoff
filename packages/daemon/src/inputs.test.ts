import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { sha256Hex, type DeliveredInput } from "@handoff/shared"
import { git, revParse } from "@handoff/shared/git"
import { combineNotes, deliveryNote, importInputs, parseBlocked, parseInputRequest, splitPayload, type ImportedInput } from "./inputs.js"

const input = (name: string, size: number, extra: Partial<DeliveredInput> = {}): DeliveredInput => ({
  name,
  repo: "/Users/someone/Repos/demo",
  ref: "main",
  sourceCommit: null,
  paths: [],
  mode: "source",
  commit: "c".repeat(40),
  tree: "d".repeat(40),
  bundleRef: `refs/handoff/01JAAAAAAAAAAAAAAAAAAAAAAA/input/${name}`,
  size,
  sha256: "",
  skipped: [],
  approvedBy: "policy",
  ...extra,
})

describe("splitPayload", () => {
  it("takes input bundles from the end, in order, leaving the snapshot bundle in front", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6])
    const { lead, bundles } = splitPayload(payload, [input("a", 2), input("b", 1)])
    expect([...lead]).toEqual([1, 2, 3])
    expect(bundles.map((b) => [...b])).toEqual([[4, 5], [6]])
    expect(splitPayload(payload, []).lead.length).toBe(6)
    expect(splitPayload(new Uint8Array([7]), [input("a", 1)]).lead.length).toBe(0)
  })

  it("rejects sizes that don't fit", () => {
    expect(() => splitPayload(new Uint8Array(2), [input("a", 3)])).toThrow(/shorter/)
    expect(() => splitPayload(new Uint8Array(2), [input("a", -1)])).toThrow(/size/)
  })
})

describe("parseBlocked", () => {
  it("returns what follows the last BLOCKED: line, through the end", () => {
    expect(parseBlocked("Done.\n\nBLOCKED: the `mac-app` folder from branch feature/x\nbecause the build needs it")).toBe(
      "the `mac-app` folder from branch feature/x\nbecause the build needs it",
    )
    expect(parseBlocked("**BLOCKED:** commit abc123")).toBe("commit abc123")
    expect(parseBlocked("I was not BLOCKED: fine")).toBeNull()
    expect(parseBlocked("All good.")).toBeNull()
    expect(parseBlocked("x\nBLOCKED: " + "y".repeat(5000))!.length).toBe(4000)
  })
})

describe("parseInputRequest", () => {
  it("accepts { inputs, note }, a list, or a single spec", () => {
    expect(parseInputRequest({ inputs: [{ name: "Mac-App", ref: "origin/x" }], note: " hi " })).toEqual({
      inputs: [{ name: "mac-app", ref: "origin/x", mode: "source" }],
      note: "hi",
    })
    expect(parseInputRequest([{ name: "a" }]).inputs).toHaveLength(1)
    expect(parseInputRequest({ name: "a" }).inputs[0]!.name).toBe("a")
    expect(() => parseInputRequest({ inputs: [{ name: "bad name" }] })).toThrow(/name/)
  })
})

describe("notes", () => {
  it("describes a delivery for the agent", () => {
    const imported: ImportedInput = { ...input("lib", 1, { approvedBy: "user", skipped: [".env"] }), localRef: "refs/handoff/inputs/J/lib", dir: "/jobs/J/inputs/lib", receivedAt: 0 }
    const note = deliveryNote({ inputsDir: "/jobs/J/inputs", imported: [imported], refused: [{ name: "keys", reason: "declined" }], message: "use v2" })
    expect(note).toContain("Inputs arrived from the user's machine")
    expect(note).toContain("**lib**: `main` of `/Users/someone/Repos/demo` (approved by the user). Files: `/jobs/J/inputs/lib/`. Git ref: `refs/handoff/inputs/J/lib`")
    expect(note).toContain("Left out as secret-looking: `.env`.")
    expect(note).toContain("- **keys**: declined")
    expect(note).toContain("Note from the user's machine: use v2")
    expect(note).toContain("/jobs/J/inputs/receipts.json")
    expect(note.endsWith("Continue the task.")).toBe(true)
    expect(deliveryNote({ inputsDir: "/x", imported: [], refused: [] })).toContain("sent nothing")
    expect(combineNotes(["a", "b"])).toBe("Handoff update:\n\na\n\n---\n\nb")
  })
})

describe("importInputs", () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true })
  })
  const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }

  it("fetches each bundle under the job, extracts its files and writes receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-inputs-"))
    dirs.push(root)
    const src = join(root, "src")
    const mirror = join(root, "mirror")
    const jobDir = join(root, "job")
    for (const d of [src, mirror]) await git(["init", "-q", d], { cwd: root })
    await writeFile(join(src, "a.txt"), "hello\n")
    // Would be dropped by git archive without the host's attribute override.
    await writeFile(join(src, ".gitattributes"), "a.txt export-ignore\n")
    await git(["add", "-A"], { cwd: src })
    await git(["commit", "-q", "-m", "x"], { cwd: src, env })
    const bundleRef = "refs/handoff/01JAAAAAAAAAAAAAAAAAAAAAAA/input/lib"
    await git(["update-ref", bundleRef, "HEAD"], { cwd: src })
    await git(["bundle", "create", "-q", join(root, "b.bundle"), bundleRef], { cwd: src })
    const bytes = await readFile(join(root, "b.bundle"))
    const commit = (await revParse(src, "HEAD"))!
    const tree = await git(["rev-parse", "HEAD^{tree}"], { cwd: src })
    const good = input("lib", bytes.length, { commit, tree, bundleRef, sha256: await sha256Hex(bytes) })
    const bad = { ...good, name: "bad", sha256: "0".repeat(64) }

    const { imported, failed } = await importInputs({ repoDir: mirror, jobDir, jobId: "J", items: [{ input: good, bytes }, { input: bad, bytes }] })
    expect(imported.map((i) => i.name)).toEqual(["lib"])
    expect(failed).toEqual([{ name: "bad", reason: "couldn't be imported on the host: SHA-256 mismatch" }])
    expect(await revParse(mirror, "refs/handoff/inputs/J/lib")).toBe(commit)
    expect(await readFile(join(jobDir, "inputs", "lib", "a.txt"), "utf8")).toBe("hello\n")
    const receipts = JSON.parse(await readFile(join(jobDir, "inputs", "receipts.json"), "utf8")) as ImportedInput[]
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ name: "lib", commit, sha256: good.sha256, localRef: "refs/handoff/inputs/J/lib", approvedBy: "policy" })

    // The same name again replaces the earlier delivery.
    await importInputs({ repoDir: mirror, jobDir, jobId: "J", items: [{ input: good, bytes }] })
    expect(JSON.parse(await readFile(join(jobDir, "inputs", "receipts.json"), "utf8"))).toHaveLength(1)
  })
})
