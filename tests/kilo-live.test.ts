// The Kilo client in a real `kilo serve` (the server Kilo's VS Code extension runs), against a
// real relay and daemon runner with the fake T3. Kilo runs with a throwaway HOME and no sign-in.
// Without KILO_MODEL each /handoff's model turn fails, which doesn't affect the handoff itself.
// With a model that needs no sign-in (KILO_MODEL=kilo/kilo-auto/free), the session's model also
// writes the brief, acknowledges the command and takes a turn on the result.
// RELAY_URL=http://localhost:8787 HOST_TOKEN=... KILO_BIN=$(which kilo) [KILO_MODEL=...] npx vitest run tests/kilo-live
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createFakeT3 } from "./support/fake-t3.js"

const url = process.env.RELAY_URL
const hostToken = process.env.HOST_TOKEN ?? ""
const kiloBin = process.env.KILO_BIN
const model = process.env.KILO_MODEL

const root = mkdtempSync(join(tmpdir(), "handoff-kilo-live-"))
process.env.HANDOFF_CONFIG_DIR = join(root, "config")
process.env.HANDOFF_STATE_DIR = join(root, "state")

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

type Part = { type: string; text?: string; ignored?: boolean; synthetic?: boolean; metadata?: { kilo?: { injected?: { title?: string } } } }
type Message = { info: { role: string; error?: unknown }; parts: Part[] }

describe.skipIf(!url || !kiloBin)("handoff from Kilo", () => {
  let kilo: ChildProcess
  let base = ""
  let work: string
  let sessionID: string
  let home: string
  let launches: import("./support/fake-t3.js").FakeLaunch[]
  let runner: InstanceType<typeof import("../packages/daemon/src/runner.js").Runner>

  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(work)}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
    return (await res.json()) as T
  }
  const messages = () => api<Message[]>(`/session/${sessionID}/message`)
  /** Runs `/handoff <args>` the way the VS Code panel does, and returns what the panel shows for it. */
  const handoff = async (args: string) => {
    await api(`/session/${sessionID}/command`, { command: "handoff", arguments: args, ...(model ? { model } : {}) })
    const user = (await messages()).filter((m) => m.info.role === "user").at(-1)!
    return user.parts
  }

  beforeAll(async () => {
    const shared = await import("@handoff/shared")
    const { Runner } = await import("../packages/daemon/src/runner.js")
    const { defaultConfig, saveDevices } = await import("../packages/daemon/src/config.js")

    work = join(root, "work-repo")
    mkdirSync(work)
    sh(work, "init", "-q", "--initial-branch=main")
    sh(work, "config", "user.name", "Dev")
    sh(work, "config", "user.email", "dev@example.com")
    writeFileSync(join(work, "app.txt"), "v1\n")
    sh(work, "add", ".")
    sh(work, "commit", "-q", "-m", "initial")

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
        jobsDir: join(root, "host-jobs"),
        t3: { runtimeFile: "/dev/null" },
        model: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        jobTimeoutMinutes: 5,
      },
      fake as never,
    )
    runner.settleMs = 50

    // The plugin file, installed the way the README says.
    execFileSync("npm", ["run", "build", "-w", "@handoff/kilo-plugin"], { stdio: "ignore" })
    home = join(root, "kilo-home")
    mkdirSync(join(home, ".config", "kilo", "plugins"), { recursive: true })
    copyFileSync(join(import.meta.dirname, "../packages/kilo/dist/handoff.js"), join(home, ".config", "kilo", "plugins", "handoff.js"))
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "HANDOFF_CONFIG_DIR", "HANDOFF_STATE_DIR", "KILO_SERVER_PASSWORD"]) delete env[key]
    kilo = spawn(kiloBin!, ["serve", "--port", "0"], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] })
    // The plugin logs (e.g. why a brief wasn't usable) go to Kilo's stderr.
    const log = createWriteStream(join(root, "kilo.log"))
    kilo.stderr!.pipe(log)
    base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("kilo serve did not start")), 60_000)
      kilo.stdout!.on("data", (chunk: Buffer) => {
        const m = chunk.toString().match(/listening on (http:\/\/\S+)/)
        if (m) (clearTimeout(timer), resolve(m[1]!))
      })
    })

    sessionID = (await api<{ id: string }>("/session", { title: "Kilo handoff" })).id
    if (model) {
      // Something for the brief to work from.
      const [providerID, ...rest] = model.split("/")
      await api(`/session/${sessionID}/message`, {
        model: { providerID, modelID: rest.join("/") },
        tools: { "*": false },
        parts: [{ type: "text", text: "We're updating app.txt: the next step is to append a line saying 'agent change'. Just say OK for now." }],
      })
    } else {
      await handoff("config brief false")
      await handoff("config resume false")
    }
    const hostFingerprint = await shared.fingerprint(hostKeys.publicKey)
    const paired = await handoff(`pair ${url} ${(await host.createPairing()).code} ${hostFingerprint} kilo-test`)
    expect(paired[0]!.text).toMatch(/Paired with the host/)

    // Kilo's pairing is its own device, kept apart from the opencode client's.
    const device = JSON.parse(readFileSync(join(home, ".config", "handoff", "kilo", "device.json"), "utf8"))
    await saveDevices({ [device.deviceId]: { name: "kilo-test", publicKey: device.keys.publicKey, fingerprint: "", pairedAt: Date.now() } })
  }, 300_000)

  afterAll(() => {
    kilo?.kill()
  })

  it("registers /handoff as a command the panel lists", async () => {
    const commands = await api<Array<{ name: string; description?: string }>>("/command")
    expect(commands.find((c) => c.name === "handoff")?.description).toMatch(/Send this session's work/)
  })

  it("shows the command's output in its own message and gives the model only a note", async () => {
    const parts = await handoff("status")
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({ ignored: true, metadata: { kilo: { injected: { title: "/handoff status" } } } })
    expect(parts[0]!.text).toContain("This machine's fingerprint")
    expect(parts[1]).toMatchObject({ synthetic: true })
    expect(parts[1]!.text).toContain("`/handoff status`")
  }, 120_000)

  it("hands off and brings the result back into the session", async () => {
    writeFileSync(join(work, "app.txt"), "v1\nuser wip\n")
    const parts = await handoff("finish the app change")
    expect(parts[0]!.text).toMatch(/Handed off as job/)
    if (model) {
      const reply = (await messages()).at(-1)!
      expect(reply.info.role).toBe("assistant")
      expect(reply.info.error).toBeUndefined()
      expect(reply.parts.some((p) => p.type === "text" && p.text?.trim())).toBe(true)
      // The session's model wrote the brief, in a child session that is gone again.
      const state = JSON.parse(readFileSync(join(home, ".local", "state", "handoff", "kilo", "device-state.json"), "utf8"))
      const job = Object.values(state.jobs as Record<string, { brief?: { title: string; task: string } }>).at(-1)!
      expect(job.brief?.title).toBeTruthy()
      expect(job.brief?.task).toBeTruthy()
      const sessions = await api<Array<{ title: string }>>("/session")
      expect(sessions.some((s) => s.title === "Handoff brief")).toBe(false)
    }

    await runner.runOnce()
    if (model) expect(launches.at(-1)!.message).toContain('The user\'s request, in their words: "finish the app change"')

    let result: Part | undefined
    for (let i = 0; i < 60 && !result; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      result = (await messages()).flatMap((m) => m.parts).find((p) => /^Handoff \w+ finished$/.test(p.metadata?.kilo?.injected?.title ?? ""))
    }
    expect(result).toBeDefined()
    expect(result!.ignored).toBeFalsy()
    expect(result!.synthetic).toBeFalsy()
    expect(result!.text).toContain("fast-forwarded")
    expect(result!.text).toContain("Agent: update app.txt")
    expect(sh(work, "log", "--format=%s", "-3", "main").split("\n")).toEqual([
      "handoff: uncommitted changes left by the agent",
      "Agent: update app.txt",
      expect.stringMatching(/^WIP: uncommitted changes at handoff/),
    ])

    if (model) {
      // With resume on, the agent takes a turn on the result.
      let turn: Message | undefined
      for (let i = 0; i < 120 && !turn; i++) {
        const all = await messages()
        const at = all.findIndex((m) => m.parts.includes(result!) || m.parts.some((p) => p.text === result!.text))
        turn = all.slice(at + 1).find((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text?.trim()))
        if (!turn) await new Promise((r) => setTimeout(r, 1000))
      }
      expect(turn?.info.error).toBeUndefined()
    }
  }, 300_000)
})
