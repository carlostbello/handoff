// Processes handoff jobs: claim -> decrypt -> mirror repo -> T3 thread -> wait
// -> bundle agent commits -> encrypt -> upload. Each step is checkpointed in the
// local state file so a daemon restart (or host reboot) resumes where it left off.

import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  PROTOCOL_VERSION,
  HostClient,
  open,
  openJson,
  packContainer,
  seal,
  sealContext,
  sealJson,
  unpackContainer,
  type EventKind,
  type ModelSelection,
  type ErrorPayload,
  type JobRecord,
  type QuestionPayload,
  type RelayEvent,
  type ReplyPayload,
  type RequestManifest,
  type ResultManifest,
  type StatusPayload,
} from "@handoff/shared"
import { git, gitOk, revParse, commitList, slugify, GitError } from "@handoff/shared/git"
import { STATE_PATH, loadConfig, loadDevices, readJson, writeJsonAtomic, type DaemonConfig } from "./config.js"
import { ACTIVE_STATUSES, T3, T3AuthError } from "./t3.js"

/** The subset of the T3 client the runner uses (lets tests substitute a fake). */
export type T3Like = Pick<
  T3,
  | "ensureProject"
  | "findThreadByTitle"
  | "launch"
  | "wait"
  | "activeSubagents"
  | "finalRunStatus"
  | "thread"
  | "finalAssistantText"
  | "pendingRequests"
  | "readPendingRequest"
  | "respond"
  | "interrupt"
  | "close"
>
import { buildPrompt } from "./prompt.js"
import { describeResolution, resolveModels } from "./models.js"

type Phase = "claimed" | "launched" | "collecting" | "uploaded" | "failed" | "cancelled"

interface LocalJob {
  id: string
  deviceId: string
  phase: Phase
  repoDir?: string
  branch?: string
  baseBranch?: string
  snapshot?: string
  projectId?: string
  threadId?: string
  threadTitle?: string
  startedAt: number
  /** Request ids already forwarded to the device. */
  askedRequests?: string[]
}

interface State {
  eventCursor: number
  jobs: Record<string, LocalJob>
}

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args)

export class Runner {
  private state: State = { eventCursor: 0, jobs: {} }
  private active = new Map<string, Promise<void>>()
  private relay: HostClient
  private t3: T3Like
  private stopping = false
  private wake: (() => void) | null = null
  private replies = new Map<string, ReplyPayload[]>()
  /** How long a thread must stay idle, with no subagents working, before its result is collected. */
  settleMs = 20_000
  private cancels = new Set<string>()

  constructor(
    private config: DaemonConfig,
    t3?: T3Like,
  ) {
    this.relay = new HostClient({
      url: config.relayUrl,
      token: config.hostToken,
      ...(config.relayHeaders ? { headers: config.relayHeaders } : {}),
    })
    this.t3 = t3 ?? new T3(config)
  }

  /** One full pass (events, queue, and every job it starts). Used by tests and `status`. */
  async runOnce(): Promise<void> {
    this.state = (await readJson<State>(STATE_PATH)) ?? this.state
    await this.pollEvents()
    for (;;) {
      const claimed = await this.pollQueue()
      while (this.active.size) await Promise.all([...this.active.values()])
      if (!claimed) break
      await this.pollEvents()
    }
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(STATE_PATH, this.state)
  }

  private async update(job: LocalJob, patch: Partial<LocalJob>): Promise<void> {
    Object.assign(job, patch)
    this.state.jobs[job.id] = job
    await this.save()
  }

  async start(): Promise<void> {
    this.state = (await readJson<State>(STATE_PATH)) ?? { eventCursor: 0, jobs: {} }
    await this.relay.setHostKey(this.config.keys.publicKey)
    log(`handoff-daemon running; relay ${this.config.relayUrl}`)
    this.openSocket()

    // Resume interrupted jobs first.
    for (const job of Object.values(this.state.jobs)) {
      if (job.phase === "claimed" || job.phase === "launched" || job.phase === "collecting") this.spawn(job.id)
    }

    while (!this.stopping) {
      try {
        await this.pollEvents()
        await this.pollQueue()
      } catch (err) {
        log("poll error:", (err as Error).message)
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 30_000)
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wake = null
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.wake?.()
    await this.t3.close()
  }

  // ---------- notifications ----------

  private openSocket(): void {
    if (this.stopping) return
    let retry = 1000
    const connect = async () => {
      try {
        const ws = new WebSocket(await this.relay.socketUrl())
        let ping: ReturnType<typeof setInterval> | undefined
        ws.onopen = () => {
          retry = 1000
          ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000)
        }
        ws.onmessage = (m) => {
          if (String(m.data).includes('"job"') || String(m.data).includes('"event"')) this.wake?.()
        }
        ws.onclose = () => {
          clearInterval(ping)
          if (!this.stopping) setTimeout(connect, (retry = Math.min(retry * 2, 60_000)))
        }
        ws.onerror = () => ws.close()
      } catch {
        if (!this.stopping) setTimeout(connect, (retry = Math.min(retry * 2, 60_000)))
      }
    }
    void connect()
  }

  // ---------- polling ----------

  /** Pick up `handoff-daemon config` changes without a restart. Keys and tokens stay as started. */
  private async reloadSettings(): Promise<void> {
    const fresh = await loadConfig().catch(() => null)
    if (!fresh) return
    const { relayUrl: _r, hostToken: _h, keys: _k, relayHeaders: _rh, t3: _t, ...settings } = fresh
    this.config = { ...this.config, ...settings }
  }

  /** Claims queued jobs up to the concurrency limit. Returns how many were claimed. */
  private async pollQueue(): Promise<number> {
    await this.reloadSettings()
    let claimedCount = 0
    const queued = await this.relay.jobs("queued")
    for (const job of queued.reverse()) {
      if (this.active.size >= this.config.concurrency) break
      if (this.state.jobs[job.id]) continue
      const claimed = await this.relay.claim(job.id)
      if (!claimed) continue
      await this.update({ id: job.id, deviceId: job.deviceId, phase: "claimed", startedAt: Date.now() }, {})
      this.spawn(job.id)
      claimedCount++
    }
    return claimedCount
  }

  private async pollEvents(): Promise<void> {
    for (;;) {
      const { events, cursor } = await this.relay.events(this.state.eventCursor)
      for (const ev of events) await this.handleEvent(ev)
      if (cursor === this.state.eventCursor) break
      this.state.eventCursor = cursor
      await this.save()
      if (events.length < 200) break
    }
  }

  private async handleEvent(ev: RelayEvent): Promise<void> {
    if (!this.state.jobs[ev.jobId]) return
    try {
      await this.applyEvent(ev)
    } catch (err) {
      log(`skipping unreadable event ${ev.seq} for job ${ev.jobId}:`, (err as Error).message)
    }
  }

  /** Public key pinned for a device at pairing. Re-read each time so newly paired devices work without a restart. */
  private async deviceKey(deviceId: string): Promise<string> {
    const device = (await loadDevices())[deviceId]
    if (!device) throw Object.assign(new Error(`device ${deviceId} is not paired with this host`), { code: "unpaired_device" })
    return device.publicKey
  }

  private async openEvent<T>(ev: RelayEvent): Promise<T> {
    return openJson<T>(ev.payload, this.config.keys, await this.deviceKey(ev.deviceId), sealContext.event(ev.kind, ev.jobId))
  }

  private async sealEvent(job: LocalJob, kind: EventKind, payload: unknown): Promise<string> {
    return sealJson(payload, await this.deviceKey(job.deviceId), this.config.keys, sealContext.event(kind, job.id))
  }

  private async applyEvent(ev: RelayEvent): Promise<void> {
    if (ev.from !== "device" || ev.deviceId !== this.state.jobs[ev.jobId]?.deviceId) return
    if (ev.kind === "cancel") {
      await this.openEvent(ev)
      this.cancels.add(ev.jobId)
      const job = this.state.jobs[ev.jobId]
      if (job?.threadId) await this.t3.interrupt(job.threadId, "Cancelled from client", `handoff-cancel-${ev.jobId}`).catch(() => {})
    } else if (ev.kind === "reply") {
      const reply = await this.openEvent<ReplyPayload>(ev)
      this.replies.set(ev.jobId, [...(this.replies.get(ev.jobId) ?? []), reply])
    }
  }

  // ---------- job lifecycle ----------

  private spawn(jobId: string): void {
    if (this.active.has(jobId)) return
    const run = this.process(jobId)
      .catch((err) => log(`job ${jobId} crashed:`, err))
      .finally(() => {
        this.active.delete(jobId)
        this.wake?.()
      })
    this.active.set(jobId, run)
  }

  /** Progress for the client; `announce` also shows it to the user right away. */
  private async notify(job: LocalJob, message: string, announce = false): Promise<void> {
    log(`job ${job.id}: ${message}`)
    try {
      const payload: StatusPayload = { message, ...(job.threadId ? { threadId: job.threadId } : {}), ...(announce ? { announce } : {}) }
      await this.relay.postEvent(job.id, "status", await this.sealEvent(job, "status", payload))
    } catch (err) {
      log(`job ${job.id}: could not send status:`, (err as Error).message)
    }
  }

  private async fail(job: LocalJob, message: string, code?: string): Promise<void> {
    log(`job ${job.id} failed: ${message}`)
    try {
      const payload: ErrorPayload = { message, ...(code ? { code } : {}) }
      // Unpaired devices get no event (there's no trusted key to encrypt to), only the status.
      if (code !== "unpaired_device") await this.relay.postEvent(job.id, "error", await this.sealEvent(job, "error", payload))
      await this.relay.setStatus(job.id, "failed", code)
    } catch (err) {
      log(`job ${job.id}: could not report failure:`, (err as Error).message)
    }
    await this.update(job, { phase: "failed" })
  }

  private async process(jobId: string): Promise<void> {
    const job = this.state.jobs[jobId]!
    try {
      if (job.phase === "claimed") await this.prepareAndLaunch(job)
      if (this.cancels.has(job.id)) return this.cancel(job)
      if (job.phase === "launched") await this.waitForThread(job)
      if (this.cancels.has(job.id)) return this.cancel(job)
      if (job.phase === "collecting") await this.collectAndUpload(job)
    } catch (err) {
      if (err instanceof T3AuthError) {
        // Leave the job resumable; it will retry once the user logs in again.
        log(`job ${job.id}: ${err.message}`)
        await this.notify(job, `Host cannot reach T3: ${err.message}. The job will resume after re-login.`)
        await new Promise((r) => setTimeout(r, 5 * 60 * 1000))
        if (!this.stopping) setTimeout(() => this.spawn(job.id), 0)
        return
      }
      const code = (err as { code?: string }).code
      await this.fail(job, (err as Error).message, typeof code === "string" ? code : undefined)
    }
  }

  private async cancel(job: LocalJob): Promise<void> {
    await this.relay.setStatus(job.id, "cancelled").catch(() => {})
    await this.update(job, { phase: "cancelled" })
    log(`job ${job.id} cancelled`)
  }

  private jobDir(id: string): string {
    return join(this.config.jobsDir, id)
  }

  private async prepareAndLaunch(job: LocalJob): Promise<void> {
    const dir = this.jobDir(job.id)
    await mkdir(dir, { recursive: true, mode: 0o700 })

    // Fails unless the request was sealed by the device key pinned at pairing.
    const deviceKey = await this.deviceKey(job.deviceId)
    const sealed = await this.relay.downloadRequest(job.id)
    const plain = await open(sealed, this.config.keys, deviceKey, sealContext.request(job.id))
    const { header: manifest, payload: bundle } = unpackContainer<RequestManifest>(plain)
    if (manifest.v !== PROTOCOL_VERSION) throw Object.assign(new Error(`unsupported protocol v${manifest.v}`), { code: "protocol" })
    if (manifest.jobId !== job.id || manifest.deviceId !== job.deviceId) throw new Error("manifest job or device mismatch")
    if (!/^refs\/handoff\/[0-9A-Z]{26}\/snapshot$/.test(manifest.repo.snapshotRef)) throw new Error("invalid snapshot ref")

    const bundlePath = join(dir, "request.bundle")
    await writeFile(bundlePath, bundle, { mode: 0o600 })
    const contextPath = join(dir, "context.md")
    await writeFile(contextPath, manifest.session.transcript, { mode: 0o600 })
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...manifest, session: { ...manifest.session, transcript: "(see context.md)" } }, null, 2))

    // Mirror repository (one per device repo id); registered once as a T3 project.
    const repoDir = join(this.config.reposDir, `${slugify(manifest.repo.name, 30)}-${manifest.repo.id.slice(0, 8)}`)
    await mkdir(repoDir, { recursive: true })
    if (!(await gitOk(["rev-parse", "--git-dir"], { cwd: repoDir }))) {
      await git(["init", "--initial-branch=handoff-mirror"], { cwd: repoDir })
      await git(["config", "gc.auto", "0"], { cwd: repoDir })
    }

    await this.notify(job, "Host received the handoff; unpacking repository")
    const baseBranch = `handoff-base/${job.id}`
    try {
      await git(["fetch", "--no-tags", bundlePath, `+${manifest.repo.snapshotRef}:refs/heads/${baseBranch}`], { cwd: repoDir })
    } catch (err) {
      if (err instanceof GitError && /prerequisite|missing|not a valid|did not send all necessary objects|lacks/i.test(err.stderr)) {
        throw Object.assign(new Error("Host is missing the base commit for an incremental bundle"), { code: "needs_full_bundle" })
      }
      throw err
    }
    const snapshot = await revParse(repoDir, baseBranch)
    if (snapshot !== manifest.repo.snapshot) throw new Error(`snapshot mismatch: got ${snapshot}, expected ${manifest.repo.snapshot}`)

    // Keep the mirror's own checkout on the latest snapshot so T3 sees a valid repo.
    const dirty = (await git(["status", "--porcelain"], { cwd: repoDir })).trim()
    if (!dirty) await git(["checkout", "-q", "-B", "handoff-mirror", snapshot], { cwd: repoDir }).catch(() => {})

    const project = await this.t3.ensureProject(repoDir, manifest.repo.name)
    const branch = `${this.config.branchPrefix}${slugify(manifest.instructions || manifest.session.title || "task", 32)}-${job.id.slice(-6).toLowerCase()}`
    const threadTitle = `Handoff: ${(manifest.instructions || manifest.session.title || manifest.repo.name).split("\n")[0]!.slice(0, 60)} [${job.id.slice(-6)}]`
    await this.update(job, { repoDir, baseBranch, branch, snapshot, projectId: project.id, threadTitle })

    // A crash between launch and the checkpoint below must not create a duplicate thread.
    const existing = await this.t3.findThreadByTitle(project.id, `[${job.id.slice(-6)}]`)
    let threadId = existing?.threadId
    if (!threadId) {
      // Model choice: --model, else a model named in the request, else the host default; all within the allowed lists.
      const models = resolveModels(this.config, manifest.instructions, manifest.options.model)
      await this.notify(job, describeResolution(models), true)
      const model = models.lead
      const message = buildPrompt({
        manifest,
        branch,
        snapshot,
        contextPath,
        models,
        instructions: this.config.instructions,
        transcriptChars: this.config.promptTranscriptChars,
      })
      threadId = await this.t3.launch({
        projectId: project.id,
        title: threadTitle,
        message,
        runtimeMode: this.config.runtimeMode,
        interactionMode: this.config.interactionMode,
        // Without a model selection T3 uses the project's default model.
        ...(model ? { modelSelection: toT3Model(model) } : {}),
        workspaceStrategy: { type: "worktree", baseRef: baseBranch, branch, startFromOrigin: false },
      })
    }
    await this.update(job, { threadId, phase: "launched" })
    await this.relay.setStatus(job.id, "running")
    await this.notify(job, `T3 thread started on branch ${branch}`)
  }

  private async waitForThread(job: LocalJob): Promise<void> {
    const threadId = job.threadId!
    const deadline = job.startedAt + this.config.jobTimeoutMinutes * 60 * 1000
    let needsInput = false
    let idleSince: number | null = null
    let waitingOn = ""
    for (;;) {
      if (this.stopping) throw new Error("daemon stopping")
      if (this.cancels.has(job.id)) return
      const res = await this.t3.wait(threadId, 60_000)
      if (res.timedOut || ACTIVE_STATUSES.includes(res.status)) {
        idleSince = null
      } else {
        // The run ended, but the job is only finished once no delegated subagent is still working
        // and the lead has stayed idle long enough for a subagent's report to start a new run.
        const busy = await this.t3.activeSubagents(job.projectId!, threadId)
        if (busy.length) {
          idleSince = null
          const names = busy.map((b) => b.title).sort().join(", ")
          if (names !== waitingOn) await this.notify(job, `Waiting on subagents: ${names}`)
          waitingOn = names
        } else if (idleSince === null) {
          idleSince = Date.now()
        } else if (Date.now() - idleSince >= this.settleMs) {
          const status = await this.t3.finalRunStatus(threadId)
          if (status !== "completed") {
            // Interrupted or failed runs still return whatever the agent committed.
            await this.notify(job, `T3 run ended with status ${status}; collecting partial results`)
          }
          break
        }
        await new Promise((r) => setTimeout(r, Math.min(5000, this.settleMs)))
      }

      // Forward questions; deliver replies.
      const pending = await this.t3.pendingRequests(threadId)
      const asked = new Set(job.askedRequests ?? [])
      for (const requestId of pending) {
        if (asked.has(requestId)) continue
        const question = await this.t3.readPendingRequest(threadId, requestId)
        const payload: QuestionPayload = { requestId, threadId, question }
        await this.relay.postEvent(job.id, "question", await this.sealEvent(job, "question", payload))
        asked.add(requestId)
        await this.update(job, { askedRequests: [...asked] })
      }
      if (pending.length && !needsInput) {
        await this.relay.setStatus(job.id, "needs_input")
        needsInput = true
      }
      for (const reply of this.replies.get(job.id) ?? []) {
        if (pending.includes(reply.requestId)) await this.t3.respond(threadId, reply.requestId, reply.answers)
      }
      this.replies.delete(job.id)
      if (needsInput && (await this.t3.pendingRequests(threadId)).length === 0) {
        await this.relay.setStatus(job.id, "running")
        needsInput = false
      }

      if (Date.now() > deadline) {
        await this.t3.interrupt(threadId, "handoff job timed out", `handoff-timeout-${job.id}`).catch(() => {})
        await this.notify(job, `Timed out after ${this.config.jobTimeoutMinutes} minutes; collecting partial results`)
        break
      }
    }
    if (needsInput) await this.relay.setStatus(job.id, "running").catch(() => {})
    await this.update(job, { phase: "collecting" })
  }

  private async collectAndUpload(job: LocalJob): Promise<void> {
    const repoDir = job.repoDir!
    const branch = job.branch!
    const snapshot = job.snapshot!
    const thread = await this.t3.thread(job.threadId!)

    // Commit anything the agent left uncommitted in its worktree.
    const worktree = thread.worktreePath ?? (await findWorktree(repoDir, branch))
    if (worktree) {
      const status = await git(["status", "--porcelain"], { cwd: worktree }).catch(() => "")
      if (status.trim()) {
        await git(["add", "-A"], { cwd: worktree })
        await git(["commit", "-q", "-m", "handoff: uncommitted changes left by the agent"], {
          cwd: worktree,
          env: { GIT_AUTHOR_NAME: "handoff", GIT_AUTHOR_EMAIL: "handoff@localhost", GIT_COMMITTER_NAME: "handoff", GIT_COMMITTER_EMAIL: "handoff@localhost" },
        })
      }
    }

    const head = await revParse(repoDir, `refs/heads/${branch}`)
    const commits = head ? await commitList(repoDir, `${snapshot}..${head}`) : []
    const diffstat = head && commits.length ? await git(["diff", "--stat", snapshot, head], { cwd: repoDir }) : ""
    let bundle: Uint8Array = new Uint8Array()
    if (head && commits.length) {
      const path = join(this.jobDir(job.id), "result.bundle")
      await git(["bundle", "create", path, `refs/heads/${branch}`, `^${snapshot}`], { cwd: repoDir })
      bundle = await readFile(path)
    }

    const summary = (await this.t3.finalAssistantText(job.threadId!)) || "(The agent finished without a final message.)"
    const manifest: ResultManifest = {
      v: PROTOCOL_VERSION,
      jobId: job.id,
      outcome: (await this.t3.finalRunStatus(job.threadId!)) === "completed" || commits.length > 0 ? "succeeded" : "failed",
      branch,
      head: commits.length ? head : null,
      snapshot,
      commits,
      diffstat,
      summary,
      t3: { projectId: job.projectId!, threadId: job.threadId!, threadTitle: job.threadTitle ?? "" },
      // The newest commit the host holds; the next bundle can be incremental against it.
      knownCommit: commits.length && head ? head : snapshot,
    }
    const sealed = await seal(packContainer(manifest, bundle), await this.deviceKey(job.deviceId), this.config.keys, sealContext.result(job.id))
    await this.relay.uploadResult(job.id, sealed)
    await this.update(job, { phase: "uploaded" })
    log(`job ${job.id}: result uploaded (${commits.length} commits, ${sealed.length} bytes)`)
    await rm(join(this.jobDir(job.id), "request.bundle"), { force: true })
  }
}

async function findWorktree(repoDir: string, branch: string): Promise<string | null> {
  const out = await git(["worktree", "list", "--porcelain"], { cwd: repoDir })
  let path: string | null = null
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9)
    if (line === `branch refs/heads/${branch}`) return path
  }
  return null
}

/** T3's modelSelection shape: options are a list of { id, value }. */
function toT3Model(selection: ModelSelection): Record<string, unknown> {
  const options = Object.entries(selection.options ?? {}).map(([id, value]) => ({ id, value }))
  return { instanceId: selection.instanceId, model: selection.model, ...(options.length ? { options } : {}) }
}

export type { JobRecord }
