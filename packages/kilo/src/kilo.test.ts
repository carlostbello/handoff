import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import type { KiloClient } from "@kilocode/sdk/client"

// Keep the store away from this machine's real handoff state.
process.env.HANDOFF_CONFIG_DIR = mkdtempSync(join(tmpdir(), "handoff-kilo-config-"))
process.env.HANDOFF_STATE_DIR = mkdtempSync(join(tmpdir(), "handoff-kilo-state-"))

let adapter: typeof import("./adapter.js")
let command: typeof import("./command.js")
let transcript: typeof import("./transcript.js")
let condense: typeof import("@handoff/shared/transcript").condenseTranscript
let NOTICE: string

beforeAll(async () => {
  adapter = await import("./adapter.js")
  command = await import("./command.js")
  transcript = await import("./transcript.js")
  condense = (await import("@handoff/shared/transcript")).condenseTranscript
  NOTICE = (await import("@handoff/opencode-plugin/engine")).NOTICE
})

const user = (id: string, parts: unknown[]) => ({ info: { id, role: "user", model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: "code" }, parts })
const assistant = (id: string, parts: unknown[], extra: object = {}) => ({ info: { id, role: "assistant", ...extra }, parts })

const HISTORY = [
  user("m1", [{ type: "text", text: "old request" }]),
  assistant("m2", [{ type: "text", text: "old answer" }]),
  user("m3", [{ type: "compaction", auto: true }]),
  assistant("m4", [{ type: "text", text: "## Summary\nWe built the uploader." }], { summary: true }),
  user("m5", [
    { type: "text", text: "add retries" },
    { type: "text", text: "local warning", ignored: true },
  ]),
  assistant("m6", [
    { type: "text", text: "Adding retries." },
    { type: "tool", tool: "edit", state: { status: "error", input: { file: "up.ts" }, error: "boom" } },
  ]),
  user("m7", [{ type: "text", text: "## Handoff `abc123` finished\nall good", metadata: { kilo: { injected: { title: "Handoff abc123 finished" } } } }]),
]

type Call = { method: string; options: any }

function fakeClient(opts: { sessions?: Record<string, { directory: string; title: string }>; reply?: string } = {}) {
  const calls: Call[] = []
  const sessions = opts.sessions ?? { ses_a: { directory: "/repo", title: "Uploader" } }
  const record = (method: string, data: (o: any) => unknown) => async (o: any) => {
    calls.push({ method, options: o })
    return { data: data(o) }
  }
  const client = {
    session: {
      get: record("get", (o) => {
        const s = sessions[o.path.id]
        if (!s) throw new Error("not found")
        return { id: o.path.id, ...s }
      }),
      messages: record("messages", () => HISTORY),
      create: record("create", () => ({ id: "ses_child" })),
      delete: record("delete", () => true),
      prompt: record("prompt", () => ({ info: { role: "assistant" }, parts: [{ type: "text", text: opts.reply ?? "{}" }] })),
      promptAsync: record("promptAsync", () => undefined),
    },
  }
  return { client: client as unknown as KiloClient, calls }
}

describe("kilo transcript", () => {
  it("starts at the last compaction and keeps handoff messages as notes", () => {
    const out = transcript.toExport({ id: "ses_a", title: "Uploader" }, HISTORY as never)
    expect(out.messages).toEqual([
      { type: "compaction", summary: "## Summary\nWe built the uploader." },
      { type: "user", text: "add retries" },
      { type: "assistant", content: [{ type: "text", text: "Adding retries." }, { type: "tool", name: "edit", state: (HISTORY[5]!.parts[1] as { state: unknown }).state }] },
      { type: "synthetic", text: "## Handoff `abc123` finished\nall good", description: "Handoff abc123 finished" },
    ])
    const text = condense(out)
    expect(text).toContain("### Earlier conversation (summary)")
    expect(text).toContain("- ran `edit`")
    expect(text).not.toContain("old request")
    expect(text).not.toContain("local warning")
  })
})

describe("kilo adapter", () => {
  it("posts notices as ignored, tagged text without a turn", async () => {
    const { client, calls } = fakeClient()
    expect(await adapter.kiloOpencode(client).post("ses_a", "Writing the brief…", { resume: true, description: NOTICE })).toBe(true)
    const call = calls.find((c) => c.method === "promptAsync")!
    expect(call.options.path).toEqual({ id: "ses_a" })
    expect(call.options.query).toEqual({ directory: "/repo" })
    expect(call.options.body).toEqual({
      noReply: true,
      parts: [{ type: "text", text: "Writing the brief…", ignored: true, metadata: { kilo: { injected: { title: "Handoff" } } } }],
    })
  })

  it("posts results as visible text titled from their heading, with a turn when resuming", async () => {
    const { client, calls } = fakeClient()
    await adapter.kiloOpencode(client).post("ses_a", "## Handoff `abc123` finished\n\nbody", { resume: true, description: "handoff abc123" })
    const body = calls.find((c) => c.method === "promptAsync")!.options.body
    expect(body.noReply).toBe(false)
    expect(body.parts[0]).toEqual({ type: "text", text: "## Handoff `abc123` finished\n\nbody", metadata: { kilo: { injected: { title: "Handoff abc123 finished" } } } })
  })

  it("reports a missing session so the engine opens a new one", async () => {
    const { client, calls } = fakeClient({ sessions: {} })
    expect(await adapter.kiloOpencode(client).post("ses_gone", "x", { resume: false, description: "handoff x" })).toBe(false)
    expect(calls.some((c) => c.method === "promptAsync")).toBe(false)
  })

  it("writes the brief in a throwaway child session with tools denied", async () => {
    const { client, calls } = fakeClient({ reply: '{"title":"t"}' })
    expect(await adapter.kiloOpencode(client).generate("ses_a", "WRITE THE BRIEF")).toBe('{"title":"t"}')
    expect(calls.find((c) => c.method === "create")!.options.body).toEqual({ parentID: "ses_a", title: "Handoff brief" })
    const prompt = calls.find((c) => c.method === "prompt")!.options
    expect(prompt.path).toEqual({ id: "ses_child" })
    expect(prompt.body.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-5-5" })
    expect(prompt.body.tools).toEqual({ "*": false })
    expect(prompt.body.parts[0].text).toContain("add retries")
    expect(prompt.body.parts[0].text).toMatch(/WRITE THE BRIEF$/)
    expect(calls.find((c) => c.method === "delete")!.options.path).toEqual({ id: "ses_child" })
  })
})

describe("kilo /handoff command", () => {
  it("rewrites the command's prompt in place: output shown, a short note for the model", () => {
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: "/handoff status", metadata: { kilo: { injected: { title: "/handoff status" } } } }]
    const same = parts
    command.rewriteParts(parts, "status", "Recent handoffs: none")
    expect(parts).toBe(same)
    expect(parts[0]).toEqual({ type: "text", text: "Recent handoffs: none", ignored: true, metadata: { kilo: { injected: { title: "/handoff status" } } } })
    expect(parts[1]).toMatchObject({ type: "text", synthetic: true })
    expect(parts[1]!.text).toContain("`/handoff status`")
    expect(parts).toHaveLength(2)
  })

  it("puts the command's replies into its own message instead of posting notices", async () => {
    const { client, calls } = fakeClient()
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: "/handoff help" }]
    await command.runHandoffCommand(adapter.kiloOpencode(client), "ses_a", "help", parts)
    expect(parts[0]!.text).toContain("**/handoff**")
    expect(calls.some((c) => c.method === "promptAsync")).toBe(false)
  })
})
