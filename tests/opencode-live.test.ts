// The opencode plugin in a real `opencode serve`, against a real relay and daemon runner with
// the fake T3. opencode runs with a throwaway HOME. The session's own agent (a model that needs
// no sign-in) calls the plugin's `handoff` tool with an input from another branch; the result
// comes back into the session and is applied.
// RELAY_URL=http://localhost:8787 HOST_TOKEN=... OPENCODE_BIN=$(which opencode) OPENCODE_MODEL=opencode/big-pickle npx vitest run tests/opencode-live
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createFakeT3 } from "./support/fake-t3.js"

const url = process.env.RELAY_URL
const hostToken = process.env.HOST_TOKEN ?? ""
const bin = process.env.OPENCODE_BIN
const model = process.env.OPENCODE_MODEL ?? "opencode/big-pickle"

const root = realpathSync(mkdtempSync(join(tmpdir(), "handoff-opencode-live-")))
process.env.HANDOFF_CONFIG_DIR = join(root, "host-config")
process.env.HANDOFF_STATE_DIR = join(root, "host-state")

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

describe.skipIf(!url || !bin)("agent-driven handoff from a real opencode", () => {
  let opencode: ChildProcess
  let base = ""
  let auth = ""
  let sessionID = ""
  let launches: import("./support/fake-t3.js").FakeLaunch[]
  let runner: InstanceType<typeof import("../packages/daemon/src/runner.js").Runner>
  const work = join(root, "work")
  const jobsDir = join(root, "host-jobs")

  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json", "x-opencode-directory": work },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }
  const transcript = async () => JSON.stringify((await api<{ data: unknown[] }>("GET", `/api/session/${sessionID}/message?limit=200`)).data)

  beforeAll(async () => {
    const shared = await import("@handoff/shared")
    const { Runner } = await import("../packages/daemon/src/runner.js")
    const { defaultConfig, saveDevices } = await import("../packages/daemon/src/config.js")

    mkdirSync(work)
    sh(work, "init", "-q", "--initial-branch=main")
    sh(work, "config", "user.name", "Dev")
    sh(work, "config", "user.email", "dev@example.com")
    writeFileSync(join(work, "app.txt"), "v1\n")
    sh(work, "add", ".")
    sh(work, "commit", "-q", "-m", "init")
    sh(work, "checkout", "-q", "-b", "feature/widget")
    mkdirSync(join(work, "widget"))
    writeFileSync(join(work, "widget", "spec.md"), "The widget color is teal-42.\n")
    writeFileSync(join(work, "widget", ".env"), "WIDGET_API_KEY=do-not-send\n")
    sh(work, "add", ".")
    sh(work, "commit", "-q", "-m", "widget spec")
    sh(work, "checkout", "-q", "main")

    const hostKeys = await shared.generateKeyPair()
    const host = new shared.HostClient({ url: url!, token: hostToken })
    await host.setHostKey(hostKeys.publicKey)
    const fake = createFakeT3(join(root, "host-wt"))
    launches = fake.launches
    runner = new Runner(
      {
        ...defaultConfig(),
        relayUrl: url!,
        hostToken,
        keys: hostKeys,
        reposDir: join(root, "host-repos"),
        jobsDir,
        t3: { runtimeFile: "/dev/null" },
        model: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        jobTimeoutMinutes: 5,
      },
      fake as never,
    )
    runner.settleMs = 50

    // The plugin, installed the way the README says.
    execFileSync("npm", ["run", "build", "-w", "@handoff/opencode-plugin"], { stdio: "ignore" })
    const home = join(root, "home")
    cpSync(join(import.meta.dirname, "../packages/plugin/dist/handoff"), join(home, ".config", "opencode", "plugins", "handoff"), { recursive: true })
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "HANDOFF_CONFIG_DIR", "HANDOFF_STATE_DIR", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"]) delete env[key]
    const port = 4300 + Math.floor(Math.random() * 500)
    opencode = spawn(bin!, ["serve", "--port", String(port)], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] })
    const log = createWriteStream(join(root, "opencode.log"))
    opencode.stderr!.pipe(log)
    let out = ""
    ;({ base, auth } = await new Promise<{ base: string; auth: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`opencode serve did not start: ${out}`)), 60_000)
      opencode.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString()
        const listening = out.match(/listening on (http:\/\/\S+)/)
        const password = out.match(/server password (\S+)/)
        if (listening && password) (clearTimeout(timer), resolve({ base: listening[1]!, auth: `Basic ${Buffer.from(`opencode:${password[1]}`).toString("base64")}` }))
      })
    }))

    const [providerID, ...rest] = model.split("/")
    sessionID = (await api<{ data: { id: string } }>("POST", "/api/session", { title: "Widgets", location: { directory: work }, model: { providerID, id: rest.join("/") } })).data.id
    const hostFingerprint = await shared.fingerprint(hostKeys.publicKey)
    await api("POST", `/api/session/${sessionID}/command`, { name: "handoff", text: `pair ${url} ${(await host.createPairing()).code} ${hostFingerprint} opencode-test` })
    let device: { deviceId: string; keys: { publicKey: string } } | undefined
    for (let i = 0; i < 60 && !device; i++) {
      const path = join(home, ".config", "handoff", "device.json")
      if (existsSync(path)) device = JSON.parse(readFileSync(path, "utf8"))
      else await new Promise((r) => setTimeout(r, 500))
    }
    expect(device).toBeDefined()
    await saveDevices({ [device!.deviceId]: { name: "opencode-test", publicKey: device!.keys.publicKey, fingerprint: "", pairedAt: Date.now() } })
  }, 300_000)

  afterAll(() => {
    opencode?.kill()
  })

  it("lets the session's agent hand off with an input from another branch, and applies the result", async () => {
    await api("POST", `/api/session/${sessionID}/prompt`, {
      text:
        "Use the handoff tool now; don't do the work yourself. Task for the host agent: create COLOR.txt at the repository root containing the widget color from widget/spec.md. " +
        'widget/spec.md is only on the feature/widget branch, not on main, so pass it in `inputs` as {"name": "widget", "ref": "feature/widget", "paths": ["widget"]}. ' +
        "Write a short brief in `task`. After the tool returns, reply with one sentence.",
    })

    // The agent's tool call queues a handoff; the host picks it up.
    for (let i = 0; i < 180 && !launches.length; i++) {
      await runner.runOnce()
      if (!launches.length) await new Promise((r) => setTimeout(r, 1000))
    }
    expect(launches.length).toBe(1)
    expect(await transcript()).toMatch(/"handoff"/)
    expect(launches[0]!.message).toMatch(/Inputs from the user's machine/)
    const job = readdirSync(jobsDir).find((j) => existsSync(join(jobsDir, j, "inputs", "receipts.json")))!
    const receipts = JSON.parse(readFileSync(join(jobsDir, job, "inputs", "receipts.json"), "utf8"))
    expect(receipts[0]).toMatchObject({ name: "widget", approvedBy: "policy", skipped: ["widget/.env"] })
    expect(readFileSync(join(jobsDir, job, "inputs", "widget", "widget", "spec.md"), "utf8")).toContain("teal-42")

    // The plugin's poller inside opencode brings the result back and applies it.
    let text = ""
    for (let i = 0; i < 120 && !/## Handoff `\w+` finished/.test(text); i++) {
      await new Promise((r) => setTimeout(r, 1000))
      text = await transcript()
    }
    expect(text).toMatch(/## Handoff `\w+` finished/)
    expect(sh(work, "log", "--format=%s", "main")).toContain("Agent: update app.txt")
  }, 600_000)
})
