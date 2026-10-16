// opencode v2 server plugin: registers /handoff and runs the background poller
// inside opencode's shared service, so results arrive even with no TUI open.

import type { Plugin } from "@opencode/plugin"
import { Engine, type Opencode } from "./engine.js"

type Context = Plugin.Context

/** One engine per process; every plugin instance shares it. */
const GLOBAL_KEY = Symbol.for("handoff.engine")
type Shared = { engine: Engine; refs: number }

function makeOpencode(ctx: Context): Opencode {
  return {
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

    return async () => {
      await registration.dispose()
      if (shared && --shared.refs === 0) {
        await shared.engine.stop()
        delete g[GLOBAL_KEY]
      }
    }
  },
} satisfies Plugin.Plugin
