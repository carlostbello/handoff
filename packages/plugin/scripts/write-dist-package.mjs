// Writes dist/handoff/package.json so the folder can be dropped into
// ~/.config/opencode/plugins/ as a package with server + TUI entries.
import { writeFileSync } from "node:fs"

writeFileSync(
  new URL("../dist/handoff/package.json", import.meta.url),
  JSON.stringify({ name: "opencode-handoff", version: "0.3.1", type: "module", exports: { ".": "./server.js", "./tui": "./tui.js" } }, null, 2) + "\n",
)
