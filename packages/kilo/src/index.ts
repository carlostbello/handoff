// Kilo server plugin (opencode v1 API): adds /handoff and runs the background poller.
// Kilo's VS Code extension starts the same server, so this one file serves both the
// extension and the CLI. Its pairing and jobs are kept apart from the opencode client's.

import type { KiloClient } from "@kilocode/sdk/client"
import { Engine } from "@handoff/opencode-plugin/engine"
import { useNamespace } from "@handoff/opencode-plugin/store"
import { kiloOpencode } from "./adapter.js"
import { COMMAND, runHandoffCommand } from "./command.js"

useNamespace("kilo")

// The subset of @kilocode/plugin's types this plugin uses.
interface PluginInput {
  client: KiloClient
  directory: string
}
interface Hooks {
  config?: (config: { command?: Record<string, { template: string; description?: string }> }) => Promise<void>
  "command.execute.before"?: (input: { command: string; sessionID: string; arguments: string }, output: { parts: Array<Record<string, unknown>> }) => Promise<void>
  dispose?: () => Promise<void>
}

/** Kilo sets up plugins once per project directory; one engine per process polls for all of them. */
const GLOBAL_KEY = Symbol.for("handoff.kilo.engine")
type Shared = { engine: Engine; refs: number }

async function server({ client }: PluginInput): Promise<Hooks> {
  const g = globalThis as unknown as Record<symbol, Shared | undefined>
  let shared = g[GLOBAL_KEY]
  if (!shared) {
    shared = { engine: new Engine(kiloOpencode(client)), refs: 0 }
    g[GLOBAL_KEY] = shared
    shared.engine.start()
  }
  shared.refs++
  const engine = shared.engine
  // Commands use this directory's client so session lookups resolve in the right project.
  const local = kiloOpencode(client)
  let disposed = false

  return {
    async config(config) {
      config.command ??= {}
      config.command.handoff ??= COMMAND
    },
    async "command.execute.before"(input, output) {
      if (input.command !== "handoff") return
      await runHandoffCommand(local, input.sessionID, input.arguments, output.parts)
      engine.kick()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      if (shared && --shared.refs === 0) {
        await shared.engine.stop()
        delete g[GLOBAL_KEY]
      }
    },
  }
}

export default { id: "handoff", server }
