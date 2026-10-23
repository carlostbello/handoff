import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { packInputs, reviewInputs } from "./inputs.js"

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const ID = "01M5JZJ0M487ET5BPFNVFX3AAY"

describe("inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-inputs-"))
  const repo = join(root, "repo")
  const other = join(root, "other")
  const folder = join(root, "notes")
  let feature = ""

  beforeAll(() => {
    for (const dir of [repo, other]) {
      mkdirSync(dir)
      sh(dir, "init", "-q", "--initial-branch=main")
      sh(dir, "config", "user.name", "Dev")
      sh(dir, "config", "user.email", "dev@example.com")
      writeFileSync(join(dir, "README.md"), "hi\n")
      sh(dir, "add", ".")
      sh(dir, "commit", "-q", "-m", "init")
    }
    sh(repo, "checkout", "-q", "-b", "feature/recorder")
    mkdirSync(join(repo, "mac-app"))
    writeFileSync(join(repo, "mac-app", "App.swift"), "struct App {}\n")
    writeFileSync(join(repo, "mac-app", ".env"), "TOKEN=1\n")
    writeFileSync(join(repo, "mac-app", ".env.example"), "TOKEN=\n")
    writeFileSync(join(repo, "private.txt"), "local orchestration notes\n")
    sh(repo, "add", ".")
    sh(repo, "commit", "-q", "-m", "recorder")
    feature = sh(repo, "rev-parse", "HEAD")
    sh(repo, "checkout", "-q", "main")
    sh(repo, "worktree", "add", "-q", join(root, "repo-wt"), "feature/recorder")
    mkdirSync(folder)
    writeFileSync(join(folder, "findings.md"), "# research\n")
    writeFileSync(join(folder, "server.pem"), "key\n")
  })

  it("sends a branch's files from the same repository without history or secrets", async () => {
    const [r] = await reviewInputs([{ name: "mac-app", ref: "feature/recorder", paths: ["mac-app"] }], repo)
    expect(r!.decision).toBe("send")
    const { delivered, refused, bundles } = await packInputs([r!], ID, { approvedByUser: false })
    expect(refused).toEqual([])
    const d = delivered[0]!
    expect(d).toMatchObject({ name: "mac-app", sourceCommit: feature, mode: "source", approvedBy: "policy", skipped: ["mac-app/.env"] })
    const host = join(root, "host")
    sh(root, "init", "-q", host)
    writeFileSync(join(root, "in.bundle"), bundles[0]!)
    sh(host, "fetch", "-q", join(root, "in.bundle"), `${d.bundleRef}:refs/x`)
    expect(sh(host, "ls-tree", "-r", "--name-only", "refs/x").split("\n").sort()).toEqual(["mac-app/.env.example", "mac-app/App.swift"])
    expect(sh(host, "rev-list", "--count", "refs/x")).toBe("1")
    expect(sh(repo, "for-each-ref", "refs/handoff")).toBe("")
  })

  it("treats another worktree of the repository as the same repository", async () => {
    const [r] = await reviewInputs([{ name: "wt", repo: join(root, "repo-wt") }], repo)
    expect(r!.decision).toBe("send")
  })

  it("asks before sending other repositories or folders, and refuses missing refs with a hint", async () => {
    const reviewed = await reviewInputs(
      [
        { name: "other", repo: other },
        { name: "notes", repo: folder },
        { name: "gone", ref: "feature/nowhere" },
        { name: "missing", repo: join(root, "nope") },
      ],
      repo,
    )
    expect(reviewed.map((r) => r.decision)).toEqual(["ask", "ask", "refuse", "refuse"])
    expect(reviewed[2]!.reason).toMatch(/git fetch/)
    const auto = await packInputs(reviewed, ID, { approvedByUser: false })
    expect(auto.delivered).toEqual([])
    expect(auto.refused.map((r) => r.reason)[0]).toMatch(/approval/)
    const approved = await packInputs(reviewed.slice(0, 2), ID, { approvedByUser: true })
    expect(approved.delivered.map((d) => [d.name, d.approvedBy])).toEqual([["other", "user"], ["notes", "user"]])
    expect(approved.delivered[1]!.skipped).toEqual(["server.pem"])
  })
})
