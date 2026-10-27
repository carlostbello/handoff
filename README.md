<img src="assets/icon.svg" width="64" height="64" alt="">

# handoff

Hand off an [opencode](https://opencode.ai) session to another machine running [T3 Code](https://t3.codes), and get the result back in the same session.

Type `/handoff <task>` in opencode. Your session context and repository state go to the **host**: the machine running T3 Code, which can be a desktop, a home server or a cloud box. That includes uncommitted and untracked files. A T3 agent does the task on its own branch. Its commits come back to your **client** (the machine running opencode) and land on your branch, and your opencode session continues with the agent's summary.

Typical uses:

- Run long tasks on a stronger machine while your laptop sleeps.
- Use models or tools that only the host has.
- Keep the client light: it only needs opencode and git, and the heavy lifting happens on the host.

How it behaves:

- **Durable.** Jobs and results wait in a relay, so either machine can be offline or shut down in the meantime.
- **Outbound only.** Neither machine accepts inbound connections.
- **End-to-end encrypted.** The relay is untrusted.
- **Cheap.** The relay runs on Cloudflare's free tier.

```
 CLIENT (opencode v2)                CLOUDFLARE (free)                 HOST (T3 Code)
 ┌──────────────────────┐  HTTPS  ┌─────────────────────────┐  HTTPS  ┌──────────────────────────┐
 │ handoff plugin       │────────▶│ Worker + Durable Object │◀────────│ handoff-daemon           │
 │  /handoff → job      │encrypted│  job queue, event log   │ WS/poll │  mirror repo → T3 project│
 │  poll, apply commits │◀────────│ R2: encrypted bundles   │────────▶│  T3 thread in a worktree │
 │  continue session    │         └─────────────────────────┘         │  bundle commits → return │
 └──────────────────────┘                                             └────────────┬─────────────┘
                                                                     MCP (localhost) → T3 Code
```

## How a handoff works

1. **Client:** `/handoff add retry logic to the uploader`
   - The plugin snapshots your working tree into a commit, using a throwaway index. Your files, index and stash are untouched.
   - It bundles the snapshot with git. After the first handoff, bundles are incremental.
   - The session's own model writes a brief for the host agent: goal, what's been done, remaining work, constraints, how to tell it's done. It also picks a title, a branch name, a project name, the files to read first, and how much of the conversation to pass on: all of it, for reference only, or none if you asked for a fresh start. Your words go along unchanged. Turn this off with `/handoff config brief false`.
   - It condenses the session into a transcript: the conversation, with tool calls reduced to one-liners.
   - It encrypts everything to the host's key and uploads it.
2. **Relay:** stores ciphertext only. It queues the job and notifies the daemon over a WebSocket.
3. **Host:** the daemon claims the job and decrypts it. It fetches the bundle into the repository's project folder, `~/handoff/<project name>`. The folder is created on the first handoff, registered as a T3 project, and reused after that. Then it starts a T3 thread:
   - The thread runs in a new worktree on branch `handoff/<task>-<id>`.
   - It uses the model you chose (see [Choosing models](#choosing-models)).
   - Its first message is kept short: the brief, the workspace rules, and pointers to `brief.md` and `transcript.md`, which the agent reads when it needs them.
4. **When the thread finishes:**
   - Anything left uncommitted is committed.
   - The daemon bundles the agent's commits and final message, encrypts them to the client's key, and uploads them.
5. **Client:** the plugin's background poller runs inside opencode's background service, so no TUI needs to be open. It downloads and applies the result:
   - **If your checkout hasn't moved since the handoff,** your branch is fast-forwarded onto the agent's commits. Your pre-handoff uncommitted work becomes the first commit, `WIP: uncommitted changes at handoff`.
   - **If you committed, switched branches, or edited files meanwhile,** or set `apply` to `branch`, the commits stay on `handoff/<task>-<id>` and your checkout is left alone.

   It then posts the result (commits, diffstat, the agent's summary) into the original session, and the local agent takes a turn on it.

If the agent asks a question, it shows up in your session. Answer with `/handoff reply <id> <answer>`.

### Continuing the conversation

Each opencode session gets one T3 thread, and you can keep talking to it from either side:

- **From opencode:** run `/handoff <message>` again in the same session. The host brings the thread's branch up to your latest snapshot and sends your message into the same thread. Naming a model, or using `--model`, switches the thread to that model where T3 allows it.
- **From T3:** reply to the agent in T3 Code or T3 Connect. When that round finishes, the host sends its commits and reply back to the opencode session, where they're applied the same way.

If you didn't take the previous result (for example, it stayed on its own branch), the next handoff starts a fresh thread.

### Agents drive it too

You don't have to type `/handoff`. The plugin gives opencode's agent three tools:
- `handoff` starts a handoff, or follows up on one, with a brief the agent writes.
- `handoff_send` gives a running handoff more material or a message.
- `handoff_status` checks on handoffs.

So you can say:

```
research how the recorder handles silence, add what the host needs, then hand off with opus and have Luna review
```

The agent does the research and writes the brief. It sends whatever the work depends on beyond your checkout: other branches or commits, or files from other repositories. Then it hands off. Model names in your words pick the host's models, just as with `/handoff`.

**When the host agent is missing something.** The host gets your current branch and its history, but not other branches, and it can't fetch from remotes. When the host agent needs more, it asks your machine for it and waits:

- **This repository**, including its other worktrees: sent automatically. That covers another branch, a commit, or the current files.
- **Anything else** (another repository or a folder): waits for you. Run `/handoff approve <id>` or `/handoff deny <id> [reason]`.
- **Things your machine can't send as asked**, such as a branch that only exists on a remote: your opencode agent gets a turn to fix it. For example, it runs `git fetch`, then sends the material with `handoff_send`. The host agent then continues in the same thread.
- **Files that look like secrets** (`.env` files, keys, credentials) are never sent automatically. This includes untracked files in the snapshot. The agent is told what was left out.

Each delivery lands on the host as a folder and a git ref, with a receipt: source commit, tree, SHA-256, and who approved it.

**When it's still blocked.** If the host agent can't go on, its result comes back marked blocked, with exactly what it needs. Your opencode agent then gets what's missing and follows up in the same thread, up to `autoFollowUps` times in a row (default 2). After that it stops and tells you. Typing `/handoff` yourself resets the count.

In Kilo, which has no tools for plugins, you get the same requests, approvals and blocked results, but you do the follow-ups with `/handoff`.

### Durability

| Situation | What happens |
|---|---|
| Client sleeps or shuts down during a job | The result waits in the relay (30-day retention). It's applied the next time opencode runs. |
| Shutdown mid-upload | The job is resubmitted from the saved snapshot ref. |
| Host offline when you hand off | The job waits in the queue and is claimed when the daemon comes back. |
| Daemon or host restarts mid-job | Every step is checkpointed. T3 threads are matched by job id, so a restart never creates duplicate threads. |
| Host lost its repository mirror | The incremental bundle fails, and the plugin resends a full bundle automatically. |
| T3 login expired (about 30 days) | The job pauses and retries every 5 minutes. Run `handoff-daemon login`. |
| Host can't reach the relay for 20 minutes | The installed daemon restarts itself, and jobs resume from their checkpoints. |
| The host agent asks for material the client never sends | After 15 minutes the agent is told to finish without it, or end with a `BLOCKED:` line saying what's missing. You get a notice, instead of a job that waits out its timeout. |
| Something fails on the client | The plugin reports it, encrypted, to the host. The host writes it to `~/.local/state/handoff/client-diagnostics.log`, so client problems can be diagnosed on the host. |

## Requirements

- **Host:** T3 Code, git, and Node 24. `handoff-daemon install` sets up a macOS LaunchAgent. On other systems, run `handoff-daemon run` under your service manager.
- **Client:** opencode 2.0.x, or Kilo 7.8.x (VS Code extension or CLI), and git. No Node, npm or Docker: opencode runs the plugin in its own built-in runtime, and installing it only takes `curl` and `tar`. You can also download `handoff-plugin.tar.gz` from the release page and unpack it with `tar -xzf`.
- **Relay:** a free Cloudflare account. R2 is free up to 10 GB, but Cloudflare asks for a payment method on file to enable it. See [Cloudflare account safety](#cloudflare-account-safety).

## Setup

On the host:

```sh
git clone https://github.com/carlostbello/handoff && cd handoff
npm install
npm run build
```

### 1. Deploy the relay (once)

```sh
cd packages/relay
npx wrangler login
npx wrangler r2 bucket create handoff-blobs
HOST_TOKEN=$(openssl rand -base64 32 | tr -d '\n')
printf %s "$HOST_TOKEN" | npx wrangler secret put HOST_TOKEN
npx wrangler deploy
echo "$HOST_TOKEN"
cd ../..
```

Keep the printed token for step 2. `deploy` prints your relay URL, `https://handoff-relay.<subdomain>.workers.dev`.

If `deploy` says you need a workers.dev subdomain, open **Workers & Pages** in the Cloudflare dashboard once, then deploy again. A brand-new subdomain can take a few minutes to start serving HTTPS.

### 2. Host daemon

Run these one at a time:

```sh
handoff-daemon() { node "$PWD/packages/daemon/dist/handoff-daemon.mjs" "$@"; }
handoff-daemon init --relay "https://handoff-relay.<subdomain>.workers.dev" --host-token "$HOST_TOKEN"
handoff-daemon login
handoff-daemon install
```

- The `handoff-daemon()` line defines a shell function for this session. Run it from the repository root.
- `login` opens T3's approval page. Choose **Full access**. If it asks for a code, run `t3 auth pairing create`.
- `install` adds a macOS LaunchAgent that starts at login and restarts on crash. Logs go to `~/Library/Logs/handoff-daemon.log`.

Then pick your models (see [Choosing models](#choosing-models)):

```sh
handoff-daemon models
handoff-daemon config set model claudeAgent/claude-opus-5-5
handoff-daemon config add subagentModels claudeAgent/claude-fable-5-1 codex/gpt-6.1-sol
```

`handoff-daemon models` lists the providers, models and options your T3 offers.

### 3. Client plugin

The plugin is three files, attached to each [GitHub release](https://github.com/carlostbello/handoff/releases). On the client:

```sh
mkdir -p ~/.config/opencode/plugins/handoff
curl -fsSL https://github.com/carlostbello/handoff/releases/latest/download/handoff-plugin.tar.gz | tar -xz -C ~/.config/opencode/plugins/handoff
```

- The release notes list the tarball's SHA-256.
- Alternatively, run `npm run build` and copy `packages/plugin/dist/handoff/` yourself.
- Afterwards, restart opencode (`opencode service restart`).

### 3a. Kilo client (instead of, or as well as, opencode)

Kilo, including its VS Code extension, uses a single plugin file, `handoff-kilo.js`, also attached to each release:

```sh
mkdir -p ~/.config/kilo/plugins
curl -fsSL -o ~/.config/kilo/plugins/handoff.js https://github.com/carlostbello/handoff/releases/latest/download/handoff-kilo.js
```

- To enable it for one repository only, put the file in that repository's `.kilo/plugins/` folder instead.
- Alternatively, run `npm run package:kilo` and copy `dist/handoff-kilo.js` yourself.
- Afterwards, reload VS Code (**Developer: Reload Window**) or restart the Kilo CLI.

`/handoff` then appears in the slash menu of Kilo's chat panel, and everything under [Usage](#usage) works the same, with these differences:

- **Pair it separately.** The Kilo client is its own client to the host, with its own pairing, settings and jobs under `~/.config/handoff/kilo/` and `~/.local/state/handoff/kilo/`. It never picks up results meant for opencode on the same machine, and the other way round.
- **Output appears in the chat.** A command's output is shown as its own message, labelled "Sent by Kilo · /handoff …". That message is kept out of the model's context, but Kilo still runs one short model turn after each `/handoff`, which the agent uses to acknowledge it.
- **Results** arrive as a "Sent by Kilo · Handoff … finished" message. With `resume` on (the default), the agent then takes a turn on it, and Kilo's usual "done" notification fires.
- **No live status.** Kilo's panel has no place for the status line, sidebar or toasts. Use `/handoff status`.
- **Results arrive while Kilo is running:** any VS Code window with Kilo open, or the Kilo CLI. Until then they wait in the relay.

### 4. Pair

With both machines in front of you:

1. On the host, run `handoff-daemon pair`. It prints a command, and the code in it expires in 10 minutes.
2. In opencode (or Kilo) on the client, run that command:
   ```
   /handoff pair https://handoff-relay.<subdomain>.workers.dev XXXX-XXXX XXXX-XXXX-XXXX-XXXX
   ```
   The last part is the host's key fingerprint. Pairing fails if the relay hands over a different key.
3. opencode shows the client's fingerprint. Check that it matches the one `handoff-daemon pair` shows on the host, then answer `y`. `/handoff status` shows the client's fingerprint again later.

The host refuses jobs from any client you haven't confirmed. Pair as many clients as you like.

## Usage

```
/handoff <instructions>                    hand off (empty = "continue what we were doing")
/handoff --model <name|spec> <instructions>  choose the lead model explicitly
/handoff --branch <instructions>           keep the result on its own branch
/handoff status                            recent handoffs, progress, this client's fingerprint
/handoff reply <id> <answer>               answer the agent's question
/handoff approve <id>                      send material an agent asked for from outside the repository
/handoff deny <id> [reason]                refuse it
/handoff cancel <id>
/handoff config [key [value|reset]]        client settings (below)
/handoff help
```

In the opencode TUI you can also see progress without asking:

- **Footer:** while the open session has a handoff in progress, the prompt footer shows a short line, such as `⇄ handoff mawvxy running 12m`. It also shows `T3 working` when the T3 thread is busy again after a result arrived, for example because you replied in T3 or a subagent is still finishing.
- **Sidebar:** a Handoff section lists the session's recent handoffs, with the host's latest progress note for running ones.
- **`/handoffs` or "Handoff: status" in the command palette:** every recent handoff across sessions, newest and running ones first. Picking one opens its session.

The TUI reads this from the plugin's local state file, so it adds no relay traffic.

On the host: `handoff-daemon status | config | models | devices | revoke <deviceId> | pair | run | install | uninstall`. `handoff-daemon devices` also shows each client's plugin version.

## Choosing models

The host decides which models handoffs may use:

| Setting | Meaning |
|---|---|
| `model` | Default lead model. If unset, handoffs use T3's default for the project. |
| `leadModels` | Other models a handoff may choose as its lead. |
| `subagentModels` | Models the agent may delegate subtasks to, via T3's `delegate_task`. |
| `aliases` | Optional nicknames, e.g. `config set alias.big claudeAgent/claude-opus-5-5`. |

**Model specs.** Models are written as `<provider>/<model>[:option=value,...]`, for example `claudeAgent/claude-opus-5-5` or `codex/gpt-6-astra:reasoningEffort=high`. Options such as effort set in the config apply wherever that model is used.

**Short names.** You don't have to type full specs in requests. Short names are derived from each allowed model's id, so `claude-opus-5-5` answers to `opus` and `opus 5.5`, and `gpt-6.1-sol` answers to `6.1 sol` and `sol`. If two allowed models share a name, the first one listed wins: `model`, then `leadModels`, then `subagentModels`. `handoff-daemon models` shows which names each allowed model answers to.

**Naming models in a request.** Name models in plain words:

```
/handoff continue this task with opus, spin up fable and astra subagents to review the final plan, then execute with 6.1 sol
```

- **The lead model** is the first allowed lead model you name outside a subagent phrase ("spin up…", "…subagents", "delegate…", "reviewers"). Here that's opus.
- **The other models you name** are given to the agent with their exact IDs, along with the step you named each one for. The agent runs each of those steps with `delegate_task`: here, fable and astra review the plan, and 6.1 sol does the build.
- **Models the host doesn't allow** aren't recognised, and the agent is told to use only the allowed ones.
- **What the host picked** comes back as a toast as soon as the job starts, for example `Lead model: claudeAgent/claude-opus-5-5 (named in your request). Models named for steps: fable → …`.
- **`--model <name|spec>` overrides the lead.** It must be the default or one of the `leadModels`, or the handoff fails with the list of allowed models.

## Configuration

### Host: `handoff-daemon config`

Changes apply to the next handoff without a restart.

```sh
handoff-daemon config                         # show everything
handoff-daemon config set <key> <value>
handoff-daemon config add|remove <list> <spec...>
handoff-daemon config unset <key>             # back to the default
```

| Setting | Default | Meaning |
|---|---|---|
| `model`, `leadModels`, `subagentModels`, `alias.<name>` | none | See [Choosing models](#choosing-models). |
| `runtimeMode` | `full-access` | T3 runtime mode. Lower modes make the agent wait for approvals, which reach the client as questions. |
| `interactionMode` | `default` | `plan` makes the agent plan instead of editing. |
| `branchPrefix` | `handoff/` | Prefix for each handoff's branch. |
| `instructions` | none | Extra instructions appended to every prompt. `@path` reads them from a file. |
| `promptTranscriptChars` | `4000` | Without a brief from the client, how much of the latest exchange the prompt shows. The full transcript is always a file the agent can read. |
| `concurrency` | `2` | Handoffs that run at the same time. |
| `jobTimeoutMinutes` | `240` | After this long, the thread is interrupted and whatever it has done is returned. |
| `reposDir` | `~/handoff` | Parent folder for project folders, one per client repository. |
| `jobsDir` | `~/.local/state/handoff/jobs` | Per-handoff scratch files: bundles, `brief.md`, `transcript.md`. |

The relay URL, token, keys and T3 login live in `~/.config/handoff/daemon.json`.

### Client: `/handoff config`

| Setting | Default | Meaning |
|---|---|---|
| `model` | host default | Lead model for this client's handoffs, as a short name or spec. It must be allowed on the host. |
| `apply` | `auto` | `auto` fast-forwards your branch when it hasn't moved. `branch` always leaves results on their own branch. |
| `resume` | `true` | Let the local agent take a turn when a result arrives. |
| `transcriptChars` | `120000` | Maximum session transcript sent with a handoff. |
| `brief` | `true` | Have the session's model write the brief. `false` sends your request as typed. |
| `autoFollowUps` | `2` | How many times in a row the local agent may follow up a blocked handoff on its own. `0` leaves it to you. |

Client settings live in `~/.config/handoff/client.json`, and pairing details in `device.json`.

## Security model

- **The relay is untrusted.** Even someone who fully controls the Cloudflare account can only delay or drop jobs. They can't read them, forge them or redirect them.
- **Encryption and sender authentication.** Each side holds an ECDH P-256 keypair.
  - Every blob and event is encrypted to the recipient using ECDH from an ephemeral key plus the sender's own key, similar to HPKE's auth mode, with chunked AES-256-GCM.
  - It only opens with the sender's real key, so the relay can't inject a job into the host or a result into your repo.
  - Each blob is bound to its job and purpose, so it can't be replayed elsewhere.
  - Tampering, reordering and truncation are all detected.
- **Pinned keys.** Each side saves the other's public key at pairing and never takes it from the relay again. Fingerprints are checked in both directions. Confirmed clients are saved in `~/.config/handoff/devices.json` on the host.
- **Result checks.** The client only applies results built on its own snapshot for that job. Result branches are only ever created or fast-forwarded, never force-updated.
- **Relay auth.**
  - Each client has its own 256-bit bearer token, stored as a hash and revocable with `handoff-daemon revoke`.
  - The host uses a separate secret token.
  - Pairing codes are single-use and expire in 10 minutes, with failed attempts rate-limited.
  - WebSocket tickets are single-use.
- **No inbound exposure.** No machine needs an open port. If you want SSO or MFA in front of the relay as well, put Cloudflare Access on it and set `relayHeaders` (host) or `headers` (client) to a service token.
- **T3 access.** Only the daemon talks to T3's local MCP endpoint, using a token you approve in the browser.
- **The agent.** It's told never to push or fetch. Credentials embedded in remote URLs are stripped before sending.
- **What leaves the client.** Untracked files that look like secrets (`.env` files, keys, credentials) are left out of snapshots. Extra material either agent asks for is sent automatically only from the handed-off repository, without secret-looking files. Anything else needs `/handoff approve`.
- **Code you're allowed to move.** handoff copies repositories from the client to the host, encrypted in transit and at rest in the relay. Only use it with code you're permitted to copy to that host, and check your organization's policies before using it with work repositories.

### Free-tier usage

The relay is designed to stay well inside Cloudflare's Workers Free limits (100,000 Worker requests, 100,000 Durable Object requests and 5 million SQLite rows read per day):

- **The host daemon** relies on a WebSocket for new jobs and client events. It polls the relay only every 5 minutes as a safety net, or every 30 seconds while the socket is down.
- **Each client** sends one request per poll: every 15 seconds while a handoff is running, every minute for a day after a result arrives (to catch replies made in T3), and every 5 minutes otherwise.
- **Each poll is one Durable Object request**, including authentication.

Expect a few thousand requests a day per active client.

### Cloudflare account safety

`wrangler` is only needed to deploy, never at runtime.

- **Use a dedicated Cloudflare account.** Put no domains on it, and pay with a low-limit card if you can.
- **Deploy with a scoped API token instead of `wrangler login`.** Give it *Workers Scripts: Edit* and *Workers R2 Storage: Edit* for that one account, and a short expiry. Export it as `CLOUDFLARE_API_TOKEN` for the deploy.
- **Remove the credential afterwards.** Run `npx wrangler logout`, or delete the token.

## Development

```sh
npm run typecheck
npm test                                                    # unit tests; live tests are skipped
cd packages/relay && echo 'HOST_TOKEN=dev-host-token-0123456789' > .dev.vars && npx wrangler dev --port 8787
RELAY_URL=http://localhost:8787 HOST_TOKEN=dev-host-token-0123456789 npm test   # + relay smoke + end-to-end
npm run package:plugin                                      # dist/handoff-plugin.tar.gz for a release
npm run package:kilo                                        # dist/handoff-kilo.js for a release
KILO_BIN=$(which kilo) KILO_MODEL=kilo/kilo-auto/free RELAY_URL=... HOST_TOKEN=... npx vitest run tests/kilo-live  # the Kilo client in a real `kilo serve`, with a free model
OPENCODE_BIN=$(which opencode) RELAY_URL=... HOST_TOKEN=... npx vitest run tests/opencode-live  # opencode's agent calls the handoff tool in a real `opencode serve`
LIVE_T3=1 RELAY_URL=... HOST_TOKEN=... npx vitest run tests/inputs-live  # a real T3 agent asks for a branch, and ends BLOCKED when it can't get one
```

| Package | What it is |
|---|---|
| `packages/shared` | Protocol types, encryption, model specs, relay client, git and transcript helpers |
| `packages/relay` | Cloudflare Worker + SQLite Durable Object + R2 |
| `packages/daemon` | `handoff-daemon`, the host runner. Drives T3 through its MCP endpoint. |
| `packages/plugin` | opencode v2 plugin: `server.js` (the `/handoff` command and poller) and `tui.js` (toasts and notifications) |
| `packages/kilo` | Kilo plugin (opencode v1 API), one file: `handoff.js`. Shares the engine with `packages/plugin`. |

The end-to-end test runs the real plugin engine, relay and daemon runner, with a fake T3 agent (`tests/support/fake-t3.ts`). It covers:

- fast-forwarding with uncommitted and untracked work
- incremental bundles
- leaving a moved branch alone
- recovering a lost mirror
- refusing forged and unconfirmed jobs
- choosing models from the request
- settings
- the host agent asking for a branch mid-run, and a blocked result followed up by the client

### Known limits

- Git LFS objects and submodule contents are not transferred.
- Bundles are held in memory. Fine for typical repos; very large monorepos will want streaming.
- Model names in requests are matched by simple rules, not by an LLM. When it matters, check the toast or use `--model`.
- Short `/handoff` notices (status, pairing, "handed off", the model choice) are TUI toasts. Without the TUI plugin, for example a headless `opencode serve`, they stay queued in the session, and the agent gets each one as a separate turn before the result.
- opencode's v2 plugin and session APIs are beta; this targets opencode 2.0.x.
- Kilo plugins can't run a command without a model turn, so each `/handoff` in Kilo costs one short turn. Kilo writes the brief in a temporary child session, with every tool denied.
