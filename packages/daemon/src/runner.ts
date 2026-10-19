// Processes handoff jobs: claim -> decrypt -> mirror repo -> T3 thread -> wait
// -> bundle agent commits -> encrypt -> upload. Each step is checkpointed in the
// local state file so a daemon restart (or host reboot) resumes where it left off.

import { mkdir, rm, stat, writeFile, readFile } from "node:fs/promises"
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
  formatModelSpec,
  sha256Hex,
  ulid,
  unpackContainer,
  utf8,
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
  | "lastUserMessage"
  | "send"
  | "configure"
  | "finalRunStatus"
  | "thread"
  | "finalAssistantText"
  | "pendingRequests"
  | "readPendingRequest"
  | "respond"
  | "interrupt"
  | "close"
>
import { buildFollowUpPrompt, buildPrompt, type ContextFiles } from "./prompt.js"
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
  /** The opencode session this job came from. */
  sessionId?: string
  /** Set when this job continued an existing thread: its latest run before the follow-up was sent. */
  baselineRunId?: string | null
}

/**
 * One opencode session's conversation with one T3 thread. Follow-up handoffs
 * from that session continue the thread, and work done in the thread from T3
 * itself is sent back to the session.
 */
interface Conversation {
  deviceId: string
  sessionId: string
  repoKey: string
  repoDir: string
  projectId: string
  threadId: string
  threadTitle: string
  branch: string
  /** The newest commit of `branch` the device has received. */
  deliveredHead: string
  /** The thread's latest run when the device was last brought up to date. */
  lastRunId: string | null
  lastSummaryHash?: string
  /** The device's newest job in this conversation (a handoff or an update). */
  lastJobId: string
  /** A handoff job currently working in the thread. */
  activeJobId?: string
  updatedAt: number
}

/** The host's folder and T3 project for one client repository. */
interface RepoHome {
  dir: string
  name: string
}

interface State {
  eventCursor: number
  jobs: Record<string, LocalJob>
  conversations: Record<string, Conversation>
  repos: Record<string, RepoHome>
}

const EMPTY_STATE = (): State => ({ eventCursor: 0, jobs: {}, conversations: {}, repos: {} })
/** Stop watching a conversation's thread after this long without activity. */
const CONVERSATION_TTL_MS = 14 * 24 * 60 * 60 * 1000

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args)

export class Runner {
  private state: State = EMPTY_STATE()
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
    this.state = { ...EMPTY_STATE(), ...(await readJson<State>(STATE_PATH)) }
    await this.pollEvents()
    for (;;) {
      const claimed = await this.pollQueue()
      while (this.active.size) await Promise.all([...this.active.values()])
      if (!claimed) break
      await this.pollEvents()
    }
    await this.pollConversations()
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
    this.state = { ...EMPTY_STATE(), ...(await readJson<State>(STATE_PATH)) }
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
        await this.pollConversations()
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
    // Context the agent reads on demand, instead of a giant first message.
    const files: ContextFiles = { transcript: join(dir, "transcript.md") }
    await writeFile(files.transcript, manifest.session.transcript, { mode: 0o600 })
    if (manifest.brief) {
      files.brief = join(dir, "brief.md")
      await writeFile(files.brief, `# ${manifest.brief.title}\n\n${manifest.brief.task}\n`, { mode: 0o600 })
    }
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...manifest, session: { ...manifest.session, transcript: "(see context.md)" } }, null, 2))

    // One folder per client repository, registered once as a T3 project.
    const repoKey = `${job.deviceId}:${manifest.repo.id}`
    const home = await this.repoHome(repoKey, manifest)
    const repoDir = home.dir
    await mkdir(repoDir, { recursive: true })
    if (!(await gitOk(["rev-parse", "--git-dir"], { cwd: repoDir }))) {
      await git(["init", "--initial-branch=handoff-mirror"], { cwd: repoDir })
      await git(["config", "gc.auto", "0"], { cwd: repoDir })
    }

    await this.notify(job, "Host received the handoff; unpacking repository")
    const baseBranch = `handoff-base/${job.id}`
    const needsFull = () => Object.assign(new Error("Host is missing the base commit for an incremental bundle"), { code: "needs_full_bundle" })
    if (bundle.length === 0) {
      // The client sends no bundle when nothing changed since what the host last had.
      if (!(await gitOk(["cat-file", "-e", `${manifest.repo.snapshot}^{commit}`], { cwd: repoDir }))) throw needsFull()
      await git(["update-ref", `refs/heads/${baseBranch}`, manifest.repo.snapshot], { cwd: repoDir })
    } else {
      try {
        await git(["fetch", "--no-tags", bundlePath, `+${manifest.repo.snapshotRef}:refs/heads/${baseBranch}`], { cwd: repoDir })
      } catch (err) {
        if (err instanceof GitError && /prerequisite|missing|not a valid|did not send all necessary objects|lacks/i.test(err.stderr)) throw needsFull()
        throw err
      }
    }
    const snapshot = await revParse(repoDir, baseBranch)
    if (snapshot !== manifest.repo.snapshot) throw new Error(`snapshot mismatch: got ${snapshot}, expected ${manifest.repo.snapshot}`)

    // Keep the mirror's own checkout on the latest snapshot so T3 sees a valid repo.
    const dirty = (await git(["status", "--porcelain"], { cwd: repoDir })).trim()
    if (!dirty) await git(["checkout", "-q", "-B", "handoff-mirror", snapshot], { cwd: repoDir }).catch(() => {})

    const project = await this.t3.ensureProject(repoDir, home.name)
    // Model choice: --model, else a model named in the request, else the host default; all within the allowed lists.
    const models = resolveModels(this.config, manifest.instructions, manifest.options.model)

    // A follow-up from the same opencode session continues that session's thread.
    const conversationKey = `${job.deviceId}:${manifest.session.id}`
    const conversation = this.state.conversations[conversationKey]
    if (conversation && conversation.repoKey === repoKey && (await this.canContinue(conversation, snapshot))) {
      await this.update(job, { repoDir, baseBranch, branch: conversation.branch, snapshot, projectId: project.id, threadTitle: conversation.threadTitle, sessionId: manifest.session.id })
      await this.continueConversation(job, conversation, manifest, snapshot, files, models)
      return
    }

    const title = manifest.brief?.title || manifest.instructions || manifest.session.title || manifest.repo.name
    const branch = `${this.config.branchPrefix}${slugify(manifest.brief?.slug || manifest.instructions || manifest.session.title || "task", 32)}-${job.id.slice(-6).toLowerCase()}`
    const threadTitle = `Handoff: ${title.split("\n")[0]!.slice(0, 60)} [${job.id.slice(-6)}]`
    await this.update(job, { repoDir, baseBranch, branch, snapshot, projectId: project.id, threadTitle, sessionId: manifest.session.id })

    // A crash between launch and the checkpoint below must not create a duplicate thread.
    const existing = await this.t3.findThreadByTitle(project.id, `[${job.id.slice(-6)}]`)
    let threadId = existing?.threadId
    if (!threadId) {
      await this.notify(job, describeResolution(models), true)
      const model = models.lead
      const message = buildPrompt({
        manifest,
        branch,
        snapshot,
        files,
        models,
        instructions: this.config.instructions,
        excerptChars: this.config.promptTranscriptChars,
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
    this.state.conversations[conversationKey] = {
      deviceId: job.deviceId,
      sessionId: manifest.session.id,
      repoKey,
      repoDir,
      projectId: project.id,
      threadId,
      threadTitle,
      branch,
      deliveredHead: snapshot,
      lastRunId: null,
      lastJobId: job.id,
      activeJobId: job.id,
      updatedAt: Date.now(),
    }
    await this.save()
    await this.relay.setStatus(job.id, "running")
    await this.notify(job, `T3 thread started on branch ${branch}`)
  }

  /**
   * The folder and T3 project name for a client repository: `<reposDir>/<name>`,
   * named after the project name the client's model suggested (or the repository).
   */
  private async repoHome(repoKey: string, manifest: RequestManifest): Promise<RepoHome> {
    const known = this.state.repos[repoKey]
    if (known) return known
    const name = manifest.brief?.projectName?.trim() || manifest.repo.name
    // Folders from before named project folders: keep using them.
    const legacyName = `${slugify(manifest.repo.name, 30)}-${manifest.repo.id.slice(0, 8)}`
    for (const legacy of [join(this.config.reposDir, legacyName), join(this.config.reposDir, "repos", legacyName)]) {
      if (await gitOk(["rev-parse", "--git-dir"], { cwd: legacy })) return this.saveRepoHome(repoKey, { dir: legacy, name })
    }
    const base = slugify(name, 40) || "project"
    const taken = new Set(Object.values(this.state.repos).map((r) => r.dir))
    for (let n = 1; ; n++) {
      const dir = join(this.config.reposDir, n === 1 ? base : `${base}-${n}`)
      if (!taken.has(dir) && !(await pathExists(dir))) return this.saveRepoHome(repoKey, { dir, name })
    }
  }

  private async saveRepoHome(repoKey: string, home: RepoHome): Promise<RepoHome> {
    this.state.repos[repoKey] = home
    await this.save()
    return home
  }

  /** The thread can take a follow-up if it still exists and the client built on what it last received. */
  private async canContinue(conversation: Conversation, snapshot: string): Promise<boolean> {
    const thread = await this.t3.thread(conversation.threadId).catch(() => null)
    if (!thread?.worktreePath || !(await pathExists(thread.worktreePath))) return false
    const tip = await revParse(conversation.repoDir, `refs/heads/${conversation.branch}`)
    if (!tip) return false
    return gitOk(["merge-base", "--is-ancestor", tip, snapshot], { cwd: conversation.repoDir })
  }

  /** Send a follow-up into an existing thread, after bringing its branch up to the client's snapshot. */
  private async continueConversation(
    job: LocalJob,
    conversation: Conversation,
    manifest: RequestManifest,
    snapshot: string,
    files: ContextFiles,
    models: ReturnType<typeof resolveModels>,
  ): Promise<void> {
    conversation.activeJobId = job.id
    conversation.updatedAt = Date.now()
    await this.save()
    await this.waitUntilIdle(job, conversation)
    const thread = await this.t3.thread(conversation.threadId)
    const worktree = thread.worktreePath!
    await this.commitLeftovers(worktree)
    await git(["merge", "--ff-only", "-q", snapshot], { cwd: worktree })
    const lead = await this.leadForFollowUp(conversation, thread, models)
    await this.notify(job, `${lead} Continuing T3 thread "${conversation.threadTitle}".`, true)
    const message = buildFollowUpPrompt({ manifest, branch: conversation.branch, snapshot, files, models })
    await this.update(job, { threadId: conversation.threadId, baselineRunId: thread.latestRunId })
    await this.t3.send(conversation.threadId, message, `handoff-${job.id}`)
    await this.update(job, { phase: "launched" })
    await this.relay.setStatus(job.id, "running")
  }

  /**
   * A follow-up keeps the thread's model unless the user chose one (--model or by
   * name). Then the thread switches to it, if T3 allows that mid-thread.
   */
  private async leadForFollowUp(
    conversation: Conversation,
    thread: { providerInstanceId?: string | null; model?: string | null },
    models: ReturnType<typeof resolveModels>,
  ): Promise<string> {
    const current = thread.providerInstanceId && thread.model ? `${thread.providerInstanceId}/${thread.model}` : "the thread's model"
    const steps = models.mentioned.length ? ` Models named for steps: ${models.mentioned.map((m) => `${m.mentionedAs[0]} → ${formatModelSpec(m.selection)}`).join(", ")}.` : ""
    const chosen = models.leadSource !== "default" ? models.lead : null
    if (!chosen || (chosen.instanceId === thread.providerInstanceId && chosen.model === thread.model)) {
      return `Lead model: ${current} (this thread's).${steps}`
    }
    try {
      await this.t3.configure(conversation.threadId, toT3Model(chosen))
      return `Lead model: ${formatModelSpec(chosen)} (switched from ${current}).${steps}`
    } catch (err) {
      log(`thread ${conversation.threadId}: couldn't switch model: ${(err as Error).message}`)
      // Still reachable as a subagent.
      models.subagents.unshift({ selection: chosen, mentionedAs: [] })
      return `Lead model: ${current}; T3 couldn't switch this thread to ${formatModelSpec(chosen)}, so it's available to the agent as a subagent instead.${steps}`
    }
  }

  /** Wait for the thread (and its subagents) to finish whatever it is doing before changing its branch. */
  private async waitUntilIdle(job: LocalJob, conversation: Conversation): Promise<void> {
    const deadline = job.startedAt + this.config.jobTimeoutMinutes * 60 * 1000
    for (let told = false; ; ) {
      const thread = await this.t3.thread(conversation.threadId)
      const busy = ACTIVE_STATUSES.includes(thread.status) || (await this.t3.activeSubagents(conversation.projectId, conversation.threadId)).length > 0
      if (!busy) return
      if (Date.now() > deadline) throw new Error("the conversation's T3 thread stayed busy until the job timed out")
      if (!told) await this.notify(job, "The T3 thread is still working; the follow-up will start when it finishes")
      told = true
      await new Promise((r) => setTimeout(r, Math.min(5000, this.settleMs)))
    }
  }

  private async commitLeftovers(worktree: string, message = "handoff: uncommitted changes left by the agent"): Promise<void> {
    const status = await git(["status", "--porcelain"], { cwd: worktree }).catch(() => "")
    if (!status.trim()) return
    await git(["add", "-A"], { cwd: worktree })
    await git(["commit", "-q", "-m", message], {
      cwd: worktree,
      env: { GIT_AUTHOR_NAME: "handoff", GIT_AUTHOR_EMAIL: "handoff@localhost", GIT_COMMITTER_NAME: "handoff", GIT_COMMITTER_EMAIL: "handoff@localhost" },
    })
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
      // A follow-up was sent to a thread whose previous run already finished: wait for the new run.
      const followUpPending = job.baselineRunId !== undefined && res.runId === job.baselineRunId
      if (followUpPending && Date.now() <= deadline) {
        await new Promise((r) => setTimeout(r, Math.min(3000, this.settleMs)))
        continue
      }
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
          // t3_thread_wait reports the newest run. When that is a subagent's wake-up that T3 cancelled
          // before it started (the lead was still busy), the lead's own run is still going: keep waiting.
          const status = await this.t3.finalRunStatus(threadId)
          if (ACTIVE_STATUSES.includes(status)) {
            idleSince = null
          } else {
            if (status !== "completed") {
              // Interrupted or failed runs still return whatever the agent committed.
              await this.notify(job, `T3 run ended with status ${status}; collecting partial results`)
            }
            break
          }
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
    if (worktree) await this.commitLeftovers(worktree)

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
      origin: "handoff",
      sessionId: job.sessionId ?? "",
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
    const conversation = Object.values(this.state.conversations).find((c) => c.activeJobId === job.id)
    if (conversation) {
      // The device is now up to date with this thread; later runs started from T3 are sent as updates.
      Object.assign(conversation, {
        deliveredHead: commits.length && head ? head : snapshot,
        lastRunId: (await this.t3.thread(job.threadId!)).latestRunId,
        lastSummaryHash: await sha256Hex(utf8(summary)),
        lastJobId: job.id,
        activeJobId: undefined,
        updatedAt: Date.now(),
      })
      await this.save()
    }
    await rm(join(this.jobDir(job.id), "request.bundle"), { force: true })
  }

  // ---------- updates from T3 ----------

  /**
   * Work done in a conversation's thread from T3 itself (the user replied to the
   * agent in T3 Code or T3 Connect) goes back to the client's opencode session
   * once the round finishes.
   */
  async pollConversations(): Promise<void> {
    const paired = await loadDevices()
    for (const [key, conversation] of Object.entries(this.state.conversations)) {
      try {
        if (!paired[conversation.deviceId]) {
          // The client was revoked: nothing to send it any more.
          delete this.state.conversations[key]
          await this.save()
          continue
        }
        const active = conversation.activeJobId ? this.state.jobs[conversation.activeJobId] : undefined
        if (active && ["claimed", "launched", "collecting"].includes(active.phase)) continue
        if (Date.now() - conversation.updatedAt > CONVERSATION_TTL_MS) {
          delete this.state.conversations[key]
          await this.save()
          continue
        }
        const thread = await this.t3.thread(conversation.threadId).catch(() => null)
        if (!thread?.latestRunId || thread.latestRunId === conversation.lastRunId) continue
        if (ACTIVE_STATUSES.includes(thread.status)) continue
        if ((await this.t3.activeSubagents(conversation.projectId, conversation.threadId)).length) continue
        // Same settling rule as handoff jobs: a subagent's report can start another run shortly after.
        const seen = this.settling.get(key)
        if (!seen || seen.runId !== thread.latestRunId) {
          this.settling.set(key, { runId: thread.latestRunId, since: Date.now() })
          continue
        }
        if (Date.now() - seen.since < this.settleMs) continue
        this.settling.delete(key)
        await this.pushUpdate(conversation, thread)
      } catch (err) {
        log(`conversation ${conversation.threadId}: ${(err as Error).message}`)
      }
    }
  }

  private settling = new Map<string, { runId: string; since: number }>()

  private async pushUpdate(conversation: Conversation, thread: { worktreePath: string | null; latestRunId: string | null }): Promise<void> {
    const { repoDir, branch } = conversation
    if (thread.worktreePath) await this.commitLeftovers(thread.worktreePath, "handoff: uncommitted changes from T3")
    const head = (await revParse(repoDir, `refs/heads/${branch}`)) ?? conversation.deliveredHead
    const commits = await commitList(repoDir, `${conversation.deliveredHead}..${head}`)
    const summary = (await this.t3.finalAssistantText(conversation.threadId)) || "(No message from the agent.)"
    const summaryHash = await sha256Hex(utf8(summary))
    if (!commits.length && summaryHash === conversation.lastSummaryHash) {
      // e.g. a queued wake-up that T3 cancelled before it started: nothing new to send.
      conversation.lastRunId = thread.latestRunId
      await this.save()
      return
    }

    // What the user asked in T3, unless the newest message is one of handoff's own prompts.
    const asked = await this.t3.lastUserMessage(conversation.threadId)
    const request = asked && !/^(You are continuing work handed off|Follow-up from the user's opencode session)/.test(asked) ? asked : undefined
    const id = ulid()
    await this.relay.createJob(id, conversation.deviceId)
    const dir = this.jobDir(id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    let bundle: Uint8Array = new Uint8Array()
    if (commits.length) {
      const path = join(dir, "result.bundle")
      await git(["bundle", "create", path, `refs/heads/${branch}`, `^${conversation.deliveredHead}`], { cwd: repoDir })
      bundle = await readFile(path)
    }
    const manifest: ResultManifest = {
      v: PROTOCOL_VERSION,
      jobId: id,
      origin: "host",
      sessionId: conversation.sessionId,
      parentJobId: conversation.lastJobId,
      ...(request ? { request } : {}),
      outcome: "succeeded",
      branch,
      head: commits.length ? head : null,
      snapshot: conversation.deliveredHead,
      commits,
      diffstat: commits.length ? await git(["diff", "--stat", conversation.deliveredHead, head], { cwd: repoDir }) : "",
      summary,
      t3: { projectId: conversation.projectId, threadId: conversation.threadId, threadTitle: conversation.threadTitle },
      knownCommit: head,
    }
    const key = await this.deviceKey(conversation.deviceId)
    await this.relay.uploadResult(id, await seal(packContainer(manifest, bundle), key, this.config.keys, sealContext.result(id)))
    Object.assign(conversation, {
      deliveredHead: head,
      lastRunId: thread.latestRunId,
      lastSummaryHash: summaryHash,
      lastJobId: id,
      updatedAt: Date.now(),
    })
    await this.save()
    await rm(dir, { recursive: true, force: true })
    log(`conversation ${conversation.threadId}: sent update ${id} (${commits.length} commits)`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
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
