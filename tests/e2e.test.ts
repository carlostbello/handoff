// End-to-end: real plugin engine + real relay (wrangler dev) + real daemon runner,
// with a fake T3 that behaves like an agent (worktree, edit, commit).
// RELAY_URL=http://localhost:8787 HOST_TOKEN=... npx vitest run tests/e2e
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { createFakeT3, type FakeLaunch } from "./support/fake-t3.js"

const url = process.env.RELAY_URL
const hostToken = process.env.HOST_TOKEN ?? ""

const root = mkdtempSync(join(tmpdir(), "handoff-e2e-"))
process.env.HANDOFF_CONFIG_DIR = join(root, "config")
process.env.HANDOFF_STATE_DIR = join(root, "state")

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

type Posted = { sessionID: string; text: string; resume: boolean }

describe.skipIf(!url)("handoff end to end", () => {
  let Engine: typeof import("../packages/plugin/src/engine.js").Engine
  let Runner: typeof import("../packages/daemon/src/runner.js").Runner
  let defaultConfig: typeof import("../packages/daemon/src/config.js").defaultConfig
  let shared: typeof import("@handoff/shared")
  const posted: Posted[] = []
  let work: string
  let engine: InstanceType<typeof Engine>
  let runner: InstanceType<typeof Runner>
  let launches: FakeLaunch[] = []
  let userEditsDuringJob: (() => void) | null = null
  let fakeHooks: import("./support/fake-t3.js").FakeHooks
  let fake: ReturnType<typeof createFakeT3>
  /** What the session's model replies when asked for a brief; null makes it fail. */
  let briefReply: string | null = null
  let briefFlaky = false
  const prompts: string[] = []
  let sessionDir = () => join(work, ".")

  beforeAll(async () => {
    ;({ Engine } = await import("../packages/plugin/src/engine.js"))
    ;({ Runner } = await import("../packages/daemon/src/runner.js"))
    ;({ defaultConfig } = await import("../packages/daemon/src/config.js"))
    shared = await import("@handoff/shared")

    // ----- client repo with committed, modified, and untracked files -----
    work = join(root, "work-repo")
    execFileSync("mkdir", ["-p", work])
    sh(work, "init", "-q", "--initial-branch=main")
    sh(work, "config", "user.name", "Dev")
    sh(work, "config", "user.email", "dev@example.com")
    writeFileSync(join(work, "app.txt"), "v1\n")
    sh(work, "add", ".")
    sh(work, "commit", "-q", "-m", "initial")

    // ----- host -----
    const hostKeys = await shared.generateKeyPair()
    const host = new shared.HostClient({ url: url!, token: hostToken })
    await host.setHostKey(hostKeys.publicKey)
    const reposDir = join(root, "host-repos")

    const fakeT3 = createFakeT3(join(root, "host-wt"), {
      onLaunch: () => userEditsDuringJob?.(),
    })
    launches = fakeT3.launches
    fake = fakeT3
    runner = new Runner(
      {
        ...defaultConfig(),
        relayUrl: url!,
        hostToken,
        keys: hostKeys,
        reposDir,
        jobsDir: join(root, "host-jobs"),
        t3: { runtimeFile: "/dev/null" },
        model: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        leadModels: [{ instanceId: "codex", model: "gpt-6-sol" }],
        subagentModels: [{ instanceId: "codex", model: "gpt-6.1-sol" }, { instanceId: "claudeAgent", model: "claude-fable-5-1" }],
        jobTimeoutMinutes: 5,
      },
      fakeT3 as never,
    )
    runner.settleMs = 50
    fakeHooks = fakeT3.hooks

    engine = new Engine({
      async sessionDirectory() {
        return sessionDir()
      },
      async generate(_sessionID: string, prompt: string) {
        prompts.push(prompt)
        if (!briefReply) throw new Error("no model configured")
        // Like real models now and then: the first reply is empty.
        return prompts.length % 2 === 1 && briefFlaky ? "" : briefReply
      },
      async sessionTitle() {
        return "Refactor app"
      },
      async exportSession(sessionID: string) {
        return {
          data: {
            info: { id: sessionID, title: "Refactor app" },
            messages: [
              { type: "user", text: "Please extend app.txt" },
              { type: "assistant", content: [{ type: "text", text: "Working on it" }, { type: "tool", name: "read", state: { status: "completed", input: { path: "app.txt" }, content: [{ type: "text", text: "v1" }] } }] },
            ],
          },
        }
      },
      async post(sessionID, text, { resume }) {
        posted.push({ sessionID, text, resume })
        return true
      },
      async createSession() {
        return "new-session"
      },
      log: () => {},
    })

    // A wrong host fingerprint (e.g. a relay substituting its own key) refuses to pair.
    const hostFingerprint = await shared.fingerprint(hostKeys.publicKey)
    const wrong = await shared.fingerprint((await shared.generateKeyPair()).publicKey)
    await engine.handle("ses_1", `/handoff pair ${url} ${(await host.createPairing()).code} ${wrong} test-mac`)
    expect(posted.at(-1)?.text).toMatch(/Handoff failed: the host key from the relay has fingerprint/)
    expect(existsSync(join(root, "config", "device.json"))).toBe(false)

    const { code } = await host.createPairing()
    await engine.handle("ses_1", `/handoff pair ${url} ${code} ${hostFingerprint.toLowerCase()} test-mac`)
    expect(posted.at(-1)?.text).toMatch(/Paired with the host/)
    // What `handoff-daemon pair` saves once you confirm the client's fingerprint.
    const device = JSON.parse(readFileSync(join(root, "config", "device.json"), "utf8"))
    expect(posted.at(-1)?.text).toContain(await shared.fingerprint(device.keys.publicKey))
    const { saveDevices } = await import("../packages/daemon/src/config.js")
    await saveDevices({ [device.deviceId]: { name: "test-mac", publicKey: device.keys.publicKey, fingerprint: "", pairedAt: Date.now() } })
  }, 30_000)

  it("hands off uncommitted work and fast-forwards the branch with the agent's commits", async () => {
    writeFileSync(join(work, "app.txt"), "v1\nuser wip\n")
    writeFileSync(join(work, "new-file.txt"), "untracked\n")
    const indexBefore = sh(work, "diff", "--cached", "--name-only")

    await engine.handle("ses_ff", "/handoff finish the app change")
    expect(posted.at(-1)?.text).toMatch(/Handed off as job/)
    // user's index and files untouched by snapshotting
    expect(sh(work, "diff", "--cached", "--name-only")).toBe(indexBefore)
    expect(sh(work, "status", "--porcelain")).toContain("new-file.txt")

    await runner.runOnce()
    expect(launches).toHaveLength(1)
    expect(launches[0]!.message).toContain("finish the app change")
    expect(launches[0]!.message).toContain("Please extend app.txt") // transcript included
    expect(launches[0]!.message).toContain("gpt-6.1-sol")
    expect(launches[0]!.args.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" })
    expect(launches[0]!.args.runtimeMode).toBe("full-access")
    expect(launches[0]!.branch).toMatch(/^handoff\/finish-the-app-change-/)

    await engine.pollOnce()
    const result = posted.at(-1)!
    expect(result.resume).toBe(true)
    expect(result.text).toContain("fast-forwarded")
    expect(result.text).toContain("Agent: update app.txt")
    expect(result.text).toContain("handoff: uncommitted changes left by the agent")

    const log = sh(work, "log", "--format=%s", "main")
    expect(log.split("\n").slice(0, 4)).toEqual([
      "handoff: uncommitted changes left by the agent",
      "Agent: update app.txt",
      expect.stringMatching(/^WIP: uncommitted changes at handoff/),
      "initial",
    ])
    expect(sh(work, "status", "--porcelain")).toBe("")
    expect(readFileSync(join(work, "app.txt"), "utf8")).toBe("v1\nuser wip\nagent change\n")
    expect(existsSync(join(work, "new-file.txt"))).toBe(true)
    expect(sh(work, "stash", "list")).toBe("")
    expect(sh(work, "for-each-ref", "refs/handoff")).toBe("")

    const state = JSON.parse(readFileSync(join(root, "state", "device-state.json"), "utf8"))
    const job = Object.values(state.jobs)[0] as { phase: string; id: string }
    expect(job.phase).toBe("applied")
    const device = new shared.DeviceClient({ url: url!, token: JSON.parse(readFileSync(join(root, "config", "device.json"), "utf8")).token })
    expect((await device.getJob(job.id)).status).toBe("delivered")
  }, 60_000)

  it("sends an incremental bundle next time and leaves a moved branch alone", async () => {
    writeFileSync(join(work, "second.txt"), "more\n")
    const before = posted.length
    await engine.handle("ses_incr", "/handoff second task")
    const state = JSON.parse(readFileSync(join(root, "state", "device-state.json"), "utf8"))
    const job = Object.values(state.jobs).find((j: any) => j.instructions === "second task") as { base: string | null }
    expect(job.base).toMatch(/^[0-9a-f]{40}$/) // incremental against what the host acknowledged

    // The user keeps working and commits while the host runs.
    userEditsDuringJob = () => {
      sh(work, "add", "-A")
      sh(work, "commit", "-q", "-m", "user commit meanwhile")
    }
    await runner.runOnce()
    userEditsDuringJob = null
    await engine.pollOnce()

    const msg = posted.slice(before).at(-1)!.text
    expect(msg).toMatch(/commits are on local branch `handoff\/second-task-/)
    expect(sh(work, "log", "-1", "--format=%s")).toBe("user commit meanwhile")
    expect(sh(work, "branch", "--list", "handoff/second-task-*")).toContain("handoff/second-task-")
  }, 60_000)

  it("recovers when the host lacks the base commit (needs_full_bundle)", async () => {
    // Simulate a host that lost its mirror: wipe repos dir.
    execFileSync("rm", ["-rf", join(root, "host-repos")])
    // Integrate the previous result so the host's known commit is an ancestor (incremental bundle).
    const second = sh(work, "branch", "--list", "--format=%(refname:short)", "handoff/second-task-*")
    sh(work, "merge", "-q", "--no-edit", second)
    writeFileSync(join(work, "third.txt"), "x\n")
    const before = posted.length
    await engine.handle("ses_full", "/handoff third task")
    await runner.runOnce() // fails with needs_full_bundle
    await engine.pollOnce() // device resubmits a full bundle
    await runner.runOnce()
    await engine.pollOnce()
    const msgs = posted.slice(before).map((p) => p.text)
    expect(msgs.at(-1)).toMatch(/finished/)
    expect(msgs.at(-1)).toMatch(/fast-forwarded/)
    expect(sh(work, "log", "-1", "--format=%s")).toBe("Agent: update app.txt")
    expect(existsSync(join(work, "third.txt"))).toBe(true)
    expect(sh(work, "status", "--porcelain")).toBe("")
    const state = JSON.parse(readFileSync(join(root, "state", "device-state.json"), "utf8"))
    const third = Object.values(state.jobs).filter((j: any) => j.instructions === "third task") as any[]
    expect(third.map((j) => j.phase).sort()).toEqual(["applied", "failed"])
    expect(third.find((j) => j.phase === "applied").retryOf).toBe(third.find((j) => j.phase === "failed").id)
  }, 60_000)

  it("refuses jobs the relay could forge: wrong sender key or an unconfirmed device", async () => {
    const host = new shared.HostClient({ url: url!, token: hostToken })
    const hostPub = JSON.parse(readFileSync(join(root, "config", "device.json"), "utf8")).hostPublicKey
    const launchesBefore = launches.length
    const submit = async (client: InstanceType<typeof shared.DeviceClient>, deviceId: string, sender: import("@handoff/shared").KeyPair) => {
      const id = shared.ulid()
      const manifest = { v: 1, jobId: id, deviceId, createdAt: Date.now(), instructions: "rm -rf ~", repo: { id: "x", name: "x", branch: null, head: null, snapshot: "0".repeat(40), snapshotRef: `refs/handoff/${id}/snapshot`, base: null, remotes: {} }, session: { id: "s", title: null, directory: "/", transcript: "" }, options: {} }
      await client.createJob(id)
      await client.uploadRequest(id, await shared.seal(shared.packContainer(manifest), hostPub, sender, shared.sealContext.request(id)))
      return id
    }

    // 1. Someone with relay access but not the device's private key (e.g. a compromised Cloudflare account).
    const device = JSON.parse(readFileSync(join(root, "config", "device.json"), "utf8"))
    const asDevice = new shared.DeviceClient({ url: url!, token: device.token })
    const forged = await submit(asDevice, device.deviceId, await shared.generateKeyPair())

    // 2. A device the relay paired but you never confirmed on the host.
    const rogueKeys = await shared.generateKeyPair()
    const rogue = await shared.DeviceClient.pair({ url: url!, headers: { "cf-connecting-ip": `10.9.${Math.floor(Math.random() * 250)}.1` } }, { code: (await host.createPairing()).code, name: "rogue", publicKey: rogueKeys.publicKey })
    const unconfirmed = await submit(new shared.DeviceClient({ url: url!, token: rogue.token }), rogue.deviceId, rogueKeys)

    await runner.runOnce()
    expect(launches.length).toBe(launchesBefore)
    expect((await asDevice.getJob(forged)).status).toBe("failed")
    const rogueJob = await new shared.DeviceClient({ url: url!, token: rogue.token }).getJob(unconfirmed)
    expect(rogueJob.status).toBe("failed")
    expect(rogueJob.errorCode).toBe("unpaired_device")
    await host.revokeDevice(rogue.deviceId)
  }, 60_000)

  it("picks models from the request, passes flags and settings through, and honours apply=branch", async () => {
    await engine.handle("ses_1", "/handoff config apply branch")
    expect(posted.at(-1)?.text).toMatch(/`apply` is now \*\*branch\*\*/)
    await engine.handle("ses_1", "/handoff config model a/b:oops")
    expect(posted.at(-1)?.text).toMatch(/Handoff failed: invalid model option/)

    // Natural language: lead named in the request, a subagent named for a step.
    const before = sh(work, "rev-parse", "HEAD")
    writeFileSync(join(work, "flags.txt"), "x\n")
    await engine.handle("ses_models", "/handoff finish this with sol 6, and have fable subagents review it")
    await runner.runOnce()
    let launch = launches.at(-1)!
    expect(launch.args.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6-sol" })
    expect(launch.message).toContain('providerInstanceId "claudeAgent", model "claude-fable-5-1"')
    expect(launch.message).toContain('the user called it "fable"')
    await engine.pollOnce()
    expect(posted.some((p) => /Lead model: codex\/gpt-6-sol \(named in your request\)/.test(p.text))).toBe(true)
    expect(posted.at(-1)!.text).toMatch(/`apply` is set to `branch`/)
    expect(sh(work, "rev-parse", "HEAD")).toBe(before)

    // --model with options.
    writeFileSync(join(work, "flags2.txt"), "x\n")
    await engine.handle("ses_flags", "/handoff --model codex/gpt-6-sol:reasoningEffort=high try flags")
    await runner.runOnce()
    launch = launches.at(-1)!
    expect(launch.args.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6-sol", options: [{ id: "reasoningEffort", value: "high" }] })
    await engine.pollOnce()
    await engine.handle("ses_1", "/handoff config apply reset")
    expect(posted.at(-1)?.text).toMatch(/`apply` is now \*\*auto\*\*/)
  }, 60_000)

  it("refuses models the host doesn't allow, and applies host settings without a restart", async () => {
    const launchesBefore = launches.length
    writeFileSync(join(work, "deny.txt"), "x\n")
    await engine.handle("ses_deny", "/handoff --model codex/gpt-9 nope")
    await runner.runOnce()
    await engine.pollOnce()
    expect(launches.length).toBe(launchesBefore)
    expect(posted.at(-1)!.text).toMatch(/failed on the host: model "codex\/gpt-9" isn't allowed as the lead model/)

    const { saveConfig } = await import("../packages/daemon/src/config.js")
    const current = (runner as unknown as { config: import("../packages/daemon/src/config.js").DaemonConfig }).config
    // The runner re-reads settings from its config file before claiming jobs.
    await saveConfig({ ...current, branchPrefix: "ai/", runtimeMode: "auto", instructions: "Always write tests." })
    await engine.handle("ses_settings", "/handoff host decides")
    await runner.runOnce()
    const launch = launches.at(-1)!
    expect(launch.args.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" })
    expect(launch.args.runtimeMode).toBe("auto")
    expect(launch.branch).toMatch(/^ai\/host-decides-/)
    expect(launch.message).toContain("## Additional instructions\nAlways write tests.")
    await engine.pollOnce()
  }, 60_000)

  it("waits for subagents that are still working after the lead's run ends", async () => {
    // Back to the host's normal settings (the previous test changed them on disk).
    const { saveConfig } = await import("../packages/daemon/src/config.js")
    const current = (runner as unknown as { config: import("../packages/daemon/src/config.js").DaemonConfig }).config
    await saveConfig({ ...current, branchPrefix: "handoff/", runtimeMode: "full-access", instructions: "" })
    fakeHooks.subagentPolls = 2
    writeFileSync(join(work, "async.txt"), "x\n")
    await engine.handle("ses_async", "/handoff delegate the work")
    await runner.runOnce()
    fakeHooks.subagentPolls = undefined
    await engine.pollOnce()
    const msg = posted.at(-1)!.text
    expect(msg).toContain("Subagent: add subagent.txt")
    expect(existsSync(join(work, "subagent.txt"))).toBe(true)
  }, 60_000)

  it("has the session's model write the brief, and names the host's project folder after it", async () => {
    const other = join(root, "other-repo")
    execFileSync("mkdir", ["-p", other])
    sh(other, "init", "-q", "--initial-branch=main")
    sh(other, "config", "user.name", "Dev")
    sh(other, "config", "user.email", "dev@example.com")
    writeFileSync(join(other, "hello.txt"), "hi\n")
    sh(other, "add", ".")
    sh(other, "commit", "-q", "-m", "initial")
    writeFileSync(join(other, "hello.txt"), "hi\nwip\n")
    sessionDir = () => other
    prompts.length = 0
    briefFlaky = true
    briefReply = JSON.stringify({
      title: "Add a greeting",
      slug: "add-greeting",
      projectName: "Shiny Demo",
      task: "## Goal\nAdd a greeting.\n## Remaining work\n- write it",
    })
    try {
      await engine.handle("ses_brief", "/handoff add hello please")
      expect(prompts.at(-1)).toContain('"""add hello please"""')
      expect(prompts.length).toBe(2) // retried after an empty reply
      await runner.runOnce()
      const launch = launches.at(-1)!
      expect(launch.title).toMatch(/^Handoff: Add a greeting \[/)
      expect(launch.branch).toMatch(/^handoff\/add-greeting-/)
      expect(launch.message).toContain("## Goal\nAdd a greeting.")
      expect(launch.message).toContain('The user\'s request, in their words: "add hello please"')
      expect([...fake.projects.values()]).toContain(join(root, "host-repos", "shiny-demo"))
      await engine.pollOnce()
      expect(posted.at(-1)!.text).toMatch(/Handoff `[a-z0-9]{6}` finished/)
    } finally {
      sessionDir = () => join(work, ".")
      briefReply = null
      briefFlaky = false
    }
  }, 60_000)

  it("continues the same T3 thread for follow-ups from the session", async () => {
    writeFileSync(join(work, "conv.txt"), "start\n")
    await engine.handle("ses_conv", "/handoff start the conversation")
    await runner.runOnce()
    await engine.pollOnce()
    expect(posted.at(-1)!.text).toMatch(/fast-forwarded/)
    const launchesBefore = launches.length

    writeFileSync(join(work, "conv.txt"), "start\nmore from the user\n")
    await engine.handle("ses_conv", "/handoff now polish it with sol 6")
    await runner.runOnce()
    expect(launches.length).toBe(launchesBefore) // no new thread
    // Naming a lead model in a follow-up switches the thread to it.
    expect(fake.configures.at(-1)?.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6-sol" })
    expect(fake.sends.at(-1)!.message).toContain("Follow-up from the user's opencode session")
    expect(fake.sends.at(-1)!.message).toContain("now polish it")
    await engine.pollOnce()
    expect(posted.some((p) => /Lead model: codex\/gpt-6-sol \(switched from/.test(p.text))).toBe(true)
    expect(posted.at(-1)!.text).toMatch(/fast-forwarded/)
    expect(sh(work, "log", "-1", "--format=%s")).toMatch(/^Agent: follow-up/)
    expect(readFileSync(join(work, "conv.txt"), "utf8")).toContain("more from the user")
    expect(sh(work, "status", "--porcelain")).toBe("")
  }, 60_000)

  it("sends work done directly in T3 back to the session", async () => {
    const deviceId = JSON.parse(readFileSync(join(root, "config", "device.json"), "utf8")).deviceId
    const state = (runner as unknown as { state: { conversations: Record<string, { threadId: string }> } }).state
    const threadId = state.conversations[`${deviceId}:ses_conv`]!.threadId
    const settle = async () => {
      await runner.pollConversations()
      await new Promise((r) => setTimeout(r, 80))
      await runner.pollConversations()
      await engine.pollOnce()
    }

    fake.simulateReply(threadId, { commit: "tweak from T3", text: "Tweaked it as you asked in T3.", asked: "please tweak the wording" })
    await settle()
    const msg = posted.at(-1)!
    expect(msg.sessionID).toBe("ses_conv")
    expect(msg.text).toContain("## Update from T3")
    expect(msg.text).toContain("Tweaked it as you asked in T3.")
    expect(msg.text).toContain("> please tweak the wording")
    expect(msg.text).not.toContain("WIP: uncommitted changes at handoff")
    expect(msg.text).toMatch(/fast-forwarded/)
    expect(sh(work, "log", "-1", "--format=%s")).toBe("Agent: tweak from T3")

    // A new run with nothing new in it (e.g. a wake-up T3 cancelled before it started) sends nothing.
    const count = posted.length
    fake.simulateReply(threadId)
    await settle()
    expect(posted.length).toBe(count)
  }, 60_000)
})
