// opencode v2 server plugin: registers /handoff and runs the background poller
// inside opencode's shared service, so results arrive even with no TUI open.

import type { Plugin } from "@opencode/plugin"
import { Engine, type AgentHandoffArgs, type AgentSendArgs, type Opencode } from "./engine.js"

type Context = Plugin.Context

/** One engine per process; every plugin instance shares it. */
const GLOBAL_KEY = Symbol.for("handoff.engine")
type Shared = { engine: Engine; refs: number }

function makeOpencode(ctx: Context): Opencode {
  return {
    tools: true,
    async sessionDirectory(sessionID) {
      const info = await ctx.session.get({ sessionID })
      return info.location?.directory ?? ctx.location.directory
    },
    async sessionTitle(sessionID) {
      return (await ctx.session.get({ sessionID })).title ?? null
    },
    async exportSession(sessionID) {
      // The session's current model context (post-compaction): exactly what the local agent knows.
      const [info, messages] = await Promise.all([ctx.session.get({ sessionID }), ctx.session.context({ sessionID })])
      return { info, messages }
    },
    async generate(sessionID, prompt) {
      return (await ctx.session.generate({ sessionID, prompt })).text
    },
    async post(sessionID, text, { resume, description }) {
      try {
        await ctx.session.get({ sessionID })
      } catch {
        return false
      }
      await ctx.session.synthetic({ sessionID, text, description, resume, delivery: "queue" })
      return true
    },
    async createSession(directory, title) {
      const info = await ctx.session.create({ title, location: { directory } })
      return info.id
    },
    log(message) {
      console.error(message)
    },
  }
}

export default {
  id: "handoff",
  async setup(ctx: Context) {
    const g = globalThis as unknown as Record<symbol, Shared | undefined>
    let shared = g[GLOBAL_KEY]
    if (!shared) {
      shared = { engine: new Engine(makeOpencode(ctx)), refs: 0 }
      g[GLOBAL_KEY] = shared
      shared.engine.start()
    }
    shared.refs++
    const engine = shared.engine
    // Commands run with this instance's context so session lookups resolve in the right location.
    const local = new Engine(makeOpencode(ctx))

    const registration = await ctx.command.transform((editor) => {
      editor.add({
        name: "handoff",
        description: "Send this session's work to the host (T3 Code); results come back here",
        execute: async ({ sessionID, prompt }) => {
          await local.handle(sessionID, prompt.text ?? "")
          engine.kick()
        },
      })
    })

    // The session's agent drives handoffs too: it can research first, choose what to send, and
    // supply what the host agent is missing without the user stepping in.
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "handoff",
        description: HANDOFF_TOOL,
        input: HANDOFF_SCHEMA,
        execute: async (input, context) => {
          const text = await local.agentHandoff(context.sessionID, input as AgentHandoffArgs)
          engine.kick()
          return { content: text }
        },
      })
      editor.add({
        name: "handoff_send",
        description: SEND_TOOL,
        input: SEND_SCHEMA,
        execute: async (input, context) => {
          const text = await local.agentSend(context.sessionID, input as AgentSendArgs)
          engine.kick()
          return { content: text }
        },
      })
      editor.add({
        name: "handoff_status",
        description: "Recent handoffs from this machine: progress on the host, questions or approvals waiting, and outcomes. Results arrive in the session as messages on their own; use this only when the user asks or you need a job id.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: await local.status() }),
      })
    })

    return async () => {
      await tools.dispose()
      await registration.dispose()
      if (shared && --shared.refs === 0) {
        await shared.engine.stop()
        delete g[GLOBAL_KEY]
      }
    }
  },
} satisfies Plugin.Plugin

const INPUT_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Short lowercase-hyphenated name, e.g. \"mac-app\"; the host files it under this name." },
    ref: { type: "string", description: "Branch, tag, remote branch (e.g. origin/feature/x) or commit. Omit for the current files." },
    repo: { type: "string", description: "Absolute path of another repository or folder on this machine. Omit for this session's repository." },
    paths: { type: "array", items: { type: "string" }, description: "Only these paths, relative to the repository. Omit for everything." },
    mode: { type: "string", enum: ["source", "history"], description: "\"source\" (default): the files at that ref, without history. \"history\": the commits too." },
    reason: { type: "string", description: "Why the host agent needs it. Shown to the user if it needs their approval." },
  },
} as const

const HANDOFF_TOOL = `Hand this session's work off to the host machine, where a T3 Code agent continues it on its own branch while this machine is free. Its commits and summary come back into this session on their own, as a message you then respond to.

Use it when the user asks to hand off, after any local preparation they asked for (for example "research X, then hand off with opus"). If a handoff from this session already finished, this continues the same T3 thread.

- task: a complete, self-contained brief. The host agent has the repository but not your understanding. Use these sections: Goal, Context (what's been done, decisions and why, files that matter), Remaining work, Constraints, Done when. Put research findings it needs here, or in a file you commit or send as an input.
- request: the user's own words, unchanged. Model names in it ("use opus, have Luna review") choose the host's models.
- inputs: everything the work depends on that isn't in the current checkout's history. The host gets this repository's current branch with its uncommitted and untracked files. It does NOT get other branches, commits that aren't ancestors of HEAD, or other repositories, and it can't fetch from remotes. Naming a branch in the brief doesn't send it. Anything from this repository (including its other worktrees) is sent automatically. Other repositories and folders wait for the user's approval. Files that look like secrets (.env, keys, credentials) are never sent.`

const HANDOFF_SCHEMA = {
  type: "object",
  required: ["task"],
  additionalProperties: false,
  properties: {
    task: { type: "string", description: "The brief for the host agent, in markdown." },
    request: { type: "string", description: "The user's request in their own words, including any model names." },
    title: { type: "string", description: "Short imperative title, at most 60 characters." },
    model: { type: "string", description: "Lead model as a short name (e.g. \"opus\") or provider/model spec, if the user named one explicitly." },
    inputs: { type: "array", items: INPUT_SCHEMA, description: "Other branches, commits, repositories or folders the work needs." },
    files: { type: "array", items: { type: "string" }, description: "Repository-relative files the host agent should read first." },
    context: { type: "string", enum: ["full", "reference", "none"], description: "How much of this session's transcript the host agent should read: full, reference (default: on hand for lookups), or none (fresh start)." },
    keepOnBranch: { type: "boolean", description: "Leave the result on its own branch instead of fast-forwarding the user's." },
  },
} as const

const SEND_TOOL = `Send material or a message to this session's handoff. Use it when the host agent asked for something you had to get first (for example, \`git fetch\` a branch that was only on a remote), or when it is blocked on something you can supply.

If the handoff is still running, the material reaches the host agent where it is waiting. If it has finished, this becomes a follow-up in the same T3 thread. Inputs follow the same rules as the handoff tool: this repository goes automatically, other locations need the user's approval (never approve for them), and secret-looking files are never sent.`

const SEND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    inputs: { type: "array", items: INPUT_SCHEMA, description: "What to send." },
    message: { type: "string", description: "A note for the host agent: what you sent, what you found, or what to do next." },
    job: { type: "string", description: "Handoff id; defaults to this session's latest handoff." },
  },
} as const
