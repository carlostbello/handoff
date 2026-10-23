// Agent-driven handoffs with a real T3 agent: the client engine and daemon runner against a
// real relay and the T3 Code on this machine, using the daemon's T3 login (read-only).
// Checks that a real model asks for a branch it doesn't have, gets it, and finishes; and that
// it ends BLOCKED when what it needs can't be sent.
// RELAY_URL=http://localhost:8787 HOST_TOKEN=... LIVE_T3=1 npx vitest run tests/inputs-live
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"

const url = process.env.RELAY_URL
const hostToken = process.env.HOST_TOKEN ?? ""
const live = process.env.LIVE_T3 === "1"

const root = realpathSync(mkdtempSync(join(tmpdir(), "handoff-inputs-live-")))
process.env.HANDOFF_CONFIG_DIR = join(root, "config")
process.env.HANDOFF_STATE_DIR = join(root, "state")

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
type Posted = { sessionID: string; text: string; resume: boolean }

describe.skipIf(!url || !live)("agent-driven handoff with a real T3 agent", () => {
  const posted: Posted[] = []
  const work = join(root, "work")
  let engine: InstanceType<typeof import("../packages/plugin/src/engine.js").Engine>
  let runner: InstanceType<typeof import("../packages/daemon/src/runner.js").Runner>
  const jobsDir = join(root, "host-jobs")

  beforeAll(async () => {
    const { Engine } = await import("../packages/plugin/src/engine.js")
    const { Runner } = await import("../packages/daemon/src/runner.js")
    const { defaultConfig, saveDevices } = await import("../packages/daemon/src/config.js")
    const shared = await import("@handoff/shared")
    const real = JSON.parse(readFileSync(join(homedir(), ".config", "handoff", "daemon.json"), "utf8"))

    // The client's repository: the material lives on a branch the handoff doesn't carry.
    mkdirSync(work)
    sh(work, "init", "-q", "--initial-branch=main")
    sh(work, "config", "user.name", "Dev")
    sh(work, "config", "user.email", "dev@example.com")
    writeFileSync(join(work, "README.md"), "# Widgets\n\nWidget specs live on their own branches.\n")
    sh(work, "add", ".")
    sh(work, "commit", "-q", "-m", "init")
    sh(work, "checkout", "-q", "-b", "feature/widget")
    mkdirSync(join(work, "widget"))
    writeFileSync(join(work, "widget", "spec.md"), "# Widget spec\n\nThe widget color is teal-42.\n")
    writeFileSync(join(work, "widget", ".env"), "WIDGET_API_KEY=do-not-send\n")
    sh(work, "add", ".")
    sh(work, "commit", "-q", "-m", "widget spec")
    sh(work, "checkout", "-q", "main")

    const hostKeys = await shared.generateKeyPair()
    const host = new shared.HostClient({ url: url!, token: hostToken })
    await host.setHostKey(hostKeys.publicKey)
    runner = new Runner({
      ...defaultConfig(),
      relayUrl: url!,
      hostToken,
      keys: hostKeys,
      reposDir: join(root, "host-repos"),
      jobsDir,
      t3: real.t3,
      model: real.model,
      leadModels: [],
      subagentModels: [],
      jobTimeoutMinutes: 15,
    })

    engine = new Engine({
      async sessionDirectory() {
        return work
      },
      async generate() {
        throw new Error("no brief in this test")
      },
      async sessionTitle() {
        return "Widgets"
      },
      async exportSession(sessionID: string) {
        return { data: { info: { id: sessionID, title: "Widgets" }, messages: [] } }
      },
      async post(sessionID, text, { resume }) {
        posted.push({ sessionID, text, resume })
        appendFileSync(process.env.LIVE_LOG ?? join(root, "posted.md"), `\n\n===== ${sessionID} (resume: ${resume})\n${text}`)
        return true
      },
      async createSession() {
        return "new-session"
      },
      log: () => {},
    })
    const { code } = await host.createPairing()
    await engine.handle("ses_live", `/handoff pair ${url} ${code} ${await shared.fingerprint(hostKeys.publicKey)} live-test`)
    const device = JSON.parse(readFileSync(join(root, "config", "device.json"), "utf8"))
    await saveDevices({ [device.deviceId]: { name: "live-test", publicKey: device.keys.publicKey, fingerprint: "", pairedAt: Date.now() } })
    await engine.configure(["brief", "false"])
  }, 60_000)

  async function runTogether(): Promise<void> {
    let done = false
    const run = runner.runOnce().finally(() => (done = true))
    while (!done) {
      await engine.pollOnce()
      await (runner as unknown as { syncRelay(): Promise<number> }).syncRelay()
      await new Promise((r) => setTimeout(r, 2000))
    }
    await run
    await engine.pollOnce()
  }

  it("asks for a branch it doesn't have, gets it without secrets, and finishes", async () => {
    await engine.handle(
      "ses_live",
      "/handoff Create COLOR.txt at the repository root containing only the widget color given in widget/spec.md on the feature/widget branch of this repository, then commit it.",
    )
    await runTogether()
    const texts = posted.map((p) => p.text)
    console.log(texts.join("\n\n-----\n\n"))
    expect(texts.some((t) => /asked for material; sent/.test(t))).toBe(true)
    expect(texts.at(-1)).toMatch(/## Handoff `\w+` finished/)
    expect(readFileSync(join(work, "COLOR.txt"), "utf8")).toMatch(/teal-42/)
    // The relay may still hold jobs from other runs; find the one that received inputs.
    const job = readdirSync(jobsDir).find((j) => existsSync(join(jobsDir, j, "inputs", "receipts.json")))!
    const inputs = join(jobsDir, job, "inputs")
    const receipts = JSON.parse(readFileSync(join(inputs, "receipts.json"), "utf8"))
    // However much the agent asked for, the secret never reaches the host.
    expect(receipts[0]).toMatchObject({ ref: "feature/widget", approvedBy: "policy" })
    expect(readdirSync(inputs, { recursive: true }).some((f) => String(f).endsWith(".env"))).toBe(false)
  }, 15 * 60_000)

  it("ends BLOCKED when what it needs can't be sent, and the client hears exactly what's missing", async () => {
    await engine.handle(
      "ses_blocked",
      "/handoff Copy the LICENSE file from the release/2019 branch of this repository into LICENSE at the root, unchanged. Don't write a license yourself.",
    )
    await runTogether()
    const last = posted.filter((p) => p.sessionID === "ses_blocked").at(-1)!
    console.log(posted.filter((p) => p.sessionID === "ses_blocked").map((p) => p.text).join("\n\n-----\n\n"))
    expect(last.text).toMatch(/is blocked/)
    expect(last.text).toMatch(/### What the host agent needs/)
    expect(last.resume).toBe(true)
    expect(existsSync(join(work, "LICENSE"))).toBe(false)
  }, 15 * 60_000)
})
