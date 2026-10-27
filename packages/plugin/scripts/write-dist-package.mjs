// Writes dist/handoff/package.json so the folder can be dropped into
// ~/.config/opencode/plugins/ as a package with server + TUI entries.
import { readFileSync, writeFileSync } from "node:fs"

const version = readFileSync(new URL("../src/version.ts", import.meta.url), "utf8").match(/PLUGIN_VERSION = "([^"]+)"/)[1]

writeFileSync(
  new URL("../dist/handoff/package.json", import.meta.url),
  JSON.stringify({ name: "opencode-handoff", version, type: "module", exports: { ".": "./server.js", "./tui": "./tui.jsx" } }, null, 2) + "\n",
)
