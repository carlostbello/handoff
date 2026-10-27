import { mkdir, writeFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createInterface } from "node:readline/promises"
import { HostClient, fingerprint, formatModelSpec, generateKeyPair, parseModelSpec, type ModelSelection } from "@handoff/shared"
import { displayAliases } from "./models.js"
import { CONFIG_PATH, STATE_PATH, defaultConfig, loadConfig, loadDevices, readJson, saveConfig, saveDevices, type DaemonConfig } from "./config.js"
import { Runner } from "./runner.js"
import { SETTINGS, applySetting, describeSettings, editList, isSettingKey, setAlias } from "./settings.js"

const sameModel = (a: ModelSelection, b: ModelSelection) => a.instanceId === b.instanceId && a.model === b.model
import { T3, login } from "./t3.js"

const run = promisify(execFile)
const LABEL = "dev.handoff.daemon"
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
const LOG = join(homedir(), "Library", "Logs", "handoff-daemon.log")

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

function relay(config: DaemonConfig): HostClient {
  return new HostClient({ url: config.relayUrl, token: config.hostToken, ...(config.relayHeaders ? { headers: config.relayHeaders } : {}) })
}

const HELP = `handoff-daemon: runs handoffs from opencode as T3 Code threads on this machine

  init --relay <url> --host-token <token>   Create config + encryption keys, register with the relay
       [--model <spec>]
  login                                     Connect to T3 Code (browser approval; choose "Full access")
  pair                                      Pair a client (one-time code + fingerprint check)
  devices                                   List paired clients
  revoke <deviceId>                         Revoke a client
  config                                    Show all settings
  config set <key> <value>                  Change a setting (applies to new handoffs; no restart needed)
  config add|remove <key> <spec...>         Edit a model list (leadModels, subagentModels)
  config set alias.<name> <spec>            Add a model nickname (config unset alias.<name> removes it)
  config unset <key>                        Reset a setting to its default
  models                                    List the providers, models, and options T3 offers
  status                                    Show config, T3 connection, and local jobs
  run                                       Run in the foreground
  install                                   Install + start a LaunchAgent (macOS: starts at login, restarts on crash)
  uninstall                                 Remove the LaunchAgent

Model specs look like <provider>/<model>[:option=value,...], e.g.
  claudeAgent/claude-opus-5-5   codex/gpt-6-sol:reasoningEffort=high
`

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2)
  switch (cmd) {
    case "init": {
      const relayUrl = flag(args, "relay")
      const hostToken = flag(args, "host-token") ?? process.env.HANDOFF_HOST_TOKEN
      if (!relayUrl || !hostToken) throw new Error("usage: handoff-daemon init --relay <url> --host-token <token>")
      const existing = await readJson<DaemonConfig>(CONFIG_PATH)
      let config: DaemonConfig = {
        ...defaultConfig(),
        ...existing,
        relayUrl,
        hostToken,
        keys: existing?.keys ?? (await generateKeyPair()),
      }
      const model = flag(args, "model")
      if (model) config = await applySetting(config, "model", model)
      await saveConfig(config)
      await relay(config).setHostKey(config.keys.publicKey)
      console.log(`Saved ${CONFIG_PATH} and registered the host key with the relay.`)
      console.log(`Host fingerprint: ${await fingerprint(config.keys.publicKey)}`)
      console.log(`Next: handoff-daemon login`)
      break
    }
    case "login": {
      const config = await loadConfig()
      const token = await login(config, console.log)
      config.t3 = { ...config.t3, accessToken: token.accessToken, clientId: token.clientId, ...(token.expiresAt ? { tokenExpiresAt: token.expiresAt } : {}) }
      await saveConfig(config)
      const t3 = new T3(config)
      const projects = await t3.call<{ projects: unknown[] }>("t3_project_list", { limit: 1 })
      await t3.close()
      console.log(`Connected to T3 (${projects.projects ? "ok" : "unexpected response"}).`)
      break
    }
    case "pair": {
      await pair(await loadConfig())
      break
    }
    case "devices": {
      const config = await loadConfig()
      const pinned = await loadDevices()
      for (const d of await relay(config).devices()) {
        const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never"
        const trust = pinned[d.id]?.publicKey === d.publicKey ? pinned[d.id]!.fingerprint : "NOT TRUSTED (not confirmed at pairing)"
        console.log(`${d.id}  ${d.name}  ${trust}  paired ${new Date(d.createdAt).toLocaleDateString()}  last seen ${seen}  ${d.client ?? "client version unknown"}`)
      }
      break
    }
    case "revoke": {
      const config = await loadConfig()
      if (!args[0]) throw new Error("usage: handoff-daemon revoke <deviceId>")
      const pinned = await loadDevices()
      delete pinned[args[0]]
      await saveDevices(pinned)
      await relay(config).revokeDevice(args[0])
      console.log(`Revoked ${args[0]}`)
      break
    }
    case "config": {
      let config = await loadConfig()
      const [action, key, ...rest] = args
      if (!action) {
        console.log(`${CONFIG_PATH}\n\n${describeSettings(config)}`)
        break
      }
      if (!["set", "unset", "get", "add", "remove"].includes(action) || !key) {
        throw new Error("usage: handoff-daemon config [get <key> | set <key> <value> | add|remove <key> <spec...> | unset <key>]")
      }
      if (key.startsWith("alias.") && (action === "set" || action === "unset")) {
        const name = key.slice(6)
        if (action === "set" && !rest.length) throw new Error(`usage: handoff-daemon config set alias.${name} <provider>/<model>`)
        config = setAlias(config, name, action === "set" ? rest.join(" ") : undefined)
        if (action === "set") await warnIfUnknownModel(config, [parseModelSpec(config.aliases[name]!)])
        await saveConfig(config)
        console.log(action === "set" ? `alias ${name} → ${config.aliases[name]}` : `removed alias ${name}`)
        break
      }
      if (!isSettingKey(key)) throw new Error(`unknown setting "${key}". Settings: ${Object.keys(SETTINGS).join(", ")}, alias.<name>`)
      if (action === "get") {
        console.log(SETTINGS[key].format(config[key]))
        break
      }
      if (action !== "unset" && !rest.length) throw new Error(`usage: handoff-daemon config ${action} ${key} <value>`)
      config =
        action === "add" || action === "remove"
          ? editList(config, key, action, rest.join(" "))
          : await applySetting(config, key, action === "set" ? rest.join(" ") : undefined)
      if (key === "model") await warnIfUnknownModel(config, config.model ? [config.model] : [])
      if (key === "leadModels" || key === "subagentModels") await warnIfUnknownModel(config, config[key])
      await saveConfig(config)
      console.log(`${key} = ${SETTINGS[key].format(config[key])}`)
      break
    }
    case "models": {
      const config = await loadConfig()
      const providers = await t3Catalog(config)
      for (const provider of providers) {
        if (!provider.models.length) continue
        console.log(`${provider.displayName ?? provider.providerInstanceId}`)
        for (const m of provider.models) {
          const opts = (m.options ?? []).map((o) => `${o.id}=${(o.options ?? []).map((v) => v.id).join("|") || o.type}`).join("  ")
          console.log(`  ${provider.providerInstanceId}/${m.id}${opts ? `   options: ${opts}` : ""}`)
        }
      }
      const roles = (s: ModelSelection) =>
        [
          config.model && sameModel(config.model, s) ? "default lead" : "",
          config.leadModels.some((l) => sameModel(l, s)) ? "lead" : "",
          config.subagentModels.some((l) => sameModel(l, s)) ? "subagent" : "",
        ].filter(Boolean).join(", ")
      const allowed = [...(config.model ? [config.model] : []), ...config.leadModels, ...config.subagentModels].filter(
        (s, i, all) => all.findIndex((t) => sameModel(s, t)) === i,
      )
      console.log(`\nAllowed in handoffs (handoff-daemon config to change):`)
      if (!allowed.length) console.log("  (none configured; handoffs use T3's project default)")
      for (const s of allowed) {
        const aliases = displayAliases(s)
        const nick = Object.entries(config.aliases).filter(([, spec]) => sameModel(parseModelSpec(spec), s)).map(([n]) => n)
        console.log(`  ${formatModelSpec(s).padEnd(44)} ${roles(s).padEnd(26)} say: ${[...nick, ...aliases].map((a) => `"${a}"`).join(", ")}`)
      }
      break
    }
    case "status": {
      const config = await loadConfig()
      console.log(`config: ${CONFIG_PATH}\nrelay:  ${config.relayUrl}`)
      const health = await relay(config).health().catch((e: Error) => ({ error: e.message }))
      console.log(`relay health: ${JSON.stringify(health)}`)
      const t3 = new T3(config)
      try {
        await t3.call("t3_project_list", { limit: 1 })
        console.log("T3: connected")
      } catch (err) {
        console.log(`T3: ${(err as Error).message}`)
      } finally {
        await t3.close()
      }
      const state = await readJson<{ jobs: Record<string, { phase: string; branch?: string; threadId?: string }> }>(STATE_PATH)
      for (const [id, job] of Object.entries(state?.jobs ?? {}).slice(-20)) {
        console.log(`${id}  ${job.phase.padEnd(10)}  ${job.branch ?? ""}  ${job.threadId ?? ""}`)
      }
      break
    }
    case "run": {
      const runner = new Runner(await loadConfig())
      // Under the installed launchd service (KeepAlive), exiting is how the daemon recovers from a stuck
      // network. Run by hand there's nothing to restart it, so it keeps retrying instead.
      runner.restartOnOutage = process.env.XPC_SERVICE_NAME === "dev.handoff.daemon"
      const shutdown = () => void runner.stop().then(() => process.exit(0))
      process.on("SIGTERM", shutdown)
      process.on("SIGINT", shutdown)
      await runner.start()
      break
    }
    case "install": {
      await loadConfig()
      const script = resolve(process.argv[1]!)
      const path = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":")
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${script}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`
      await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true })
      await writeFile(PLIST, plist)
      const uid = process.getuid?.() ?? 501
      await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {})
      await run("launchctl", ["bootstrap", `gui/${uid}`, PLIST])
      console.log(`Installed ${PLIST}\nLogs: ${LOG}`)
      break
    }
    case "uninstall": {
      const uid = process.getuid?.() ?? 501
      await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {})
      await rm(PLIST, { force: true })
      console.log("Removed LaunchAgent.")
      break
    }
    default:
      console.log(HELP)
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1
  }
}

/**
 * Pairing: the relay brokers the exchange, but isn't trusted with it. The client
 * checks the host's key against the fingerprint in the pair command, and
 * you check the client's key here before the daemon will accept its jobs.
 */
async function pair(config: DaemonConfig): Promise<void> {
  const client = relay(config)
  const hostFingerprint = await fingerprint(config.keys.publicKey)
  const before = new Set((await client.devices()).map((d) => d.id))
  const { code, expiresAt } = await client.createPairing()
  console.log(`On the client, in opencode run:\n\n  /handoff pair ${config.relayUrl} ${code} ${hostFingerprint}\n`)
  console.log(`Code expires ${new Date(expiresAt).toLocaleTimeString()}. Waiting for the client (Ctrl-C to stop)...`)

  for (;;) {
    if (Date.now() > expiresAt + 10_000) throw new Error("Pairing code expired. Run handoff-daemon pair again.")
    await new Promise((r) => setTimeout(r, 2000))
    const device = (await client.devices()).find((d) => !before.has(d.id))
    if (!device) continue
    const deviceFingerprint = await fingerprint(device.publicKey)
    console.log(`\n"${device.name}" paired. Its fingerprint, as received through the relay:\n\n  ${deviceFingerprint}\n`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question("Does it match the fingerprint opencode shows on the client? [y/N] ")
    rl.close()
    if (/^y(es)?$/i.test(answer.trim())) {
      const pinned = await loadDevices()
      pinned[device.id] = { name: device.name, publicKey: device.publicKey, fingerprint: deviceFingerprint, pairedAt: Date.now() }
      await saveDevices(pinned)
      console.log(`Trusted ${device.id}. Handoffs from "${device.name}" will now run.`)
    } else {
      await client.revokeDevice(device.id)
      console.log("Revoked it. Don't use this relay until you know why the fingerprints differ.")
      process.exitCode = 1
    }
    return
  }
}

interface CatalogProvider {
  providerInstanceId: string
  displayName?: string
  models: Array<{ id: string; options?: Array<{ id: string; type?: string; options?: Array<{ id: string }> }> }>
}

async function t3Catalog(config: DaemonConfig): Promise<CatalogProvider[]> {
  const t3 = new T3(config)
  try {
    return (await t3.call<{ providers: CatalogProvider[] }>("orchestrator_capabilities", {})).providers
  } finally {
    await t3.close()
  }
}

/** Settings are saved even if T3 is unreachable; this only warns about typos. */
async function warnIfUnknownModel(config: DaemonConfig, selections: ModelSelection[]): Promise<void> {
  if (!selections.length) return
  let providers: CatalogProvider[]
  try {
    providers = await t3Catalog(config)
  } catch (err) {
    console.warn(`(Couldn't check the model against T3: ${(err as Error).message})`)
    return
  }
  for (const selection of selections) warnModel(providers, selection)
}

function warnModel(providers: CatalogProvider[], selection: ModelSelection): void {
  const provider = providers.find((p) => p.providerInstanceId === selection.instanceId)
  const model = provider?.models.find((m) => m.id === selection.model)
  if (!provider) console.warn(`Warning: T3 has no provider "${selection.instanceId}". Run handoff-daemon models.`)
  else if (!model) console.warn(`Warning: provider "${selection.instanceId}" has no model "${selection.model}". Run handoff-daemon models.`)
  else {
    for (const [id, value] of Object.entries(selection.options ?? {})) {
      const option = model.options?.find((o) => o.id === id)
      if (!option) console.warn(`Warning: ${selection.model} has no option "${id}".`)
      else if (option.options?.length && !option.options.some((v) => v.id === String(value))) {
        console.warn(`Warning: ${id} should be one of ${option.options.map((v) => v.id).join(", ")}.`)
      }
    }
  }
}

main().catch((err) => {
  console.error((err as Error).message)
  process.exit(1)
})
