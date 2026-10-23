// Device-side engine: packs and submits handoffs, polls the relay, applies
// results, and reports back into the originating opencode session. It talks to
// opencode only through `Opencode`, which keeps it testable outside opencode.

import { hostname } from "node:os"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  DeviceClient,
  PROTOCOL_VERSION,
  concat,
  describeInputSpec,
  normalizeInputList,
  RelayError,
  fingerprint,
  formatModelSpec,
  generateKeyPair,
  normalizeFingerprint,
  parseModelSpec,
  open,
  openJson,
  packContainer,
  seal,
  sealContext,
  sealJson,
  ulid,
  unpackContainer,
  type DeliveryNotice,
  type ErrorPayload,
  type HandoffBrief,
  type InputRequestPayload,
  type InputSpec,
  type InputsManifest,
  type InputsReceipt,
  type JobRecord,
  type QuestionPayload,
  type RelayEvent,
  type ReplyPayload,
  type RequestManifest,
  type ResultManifest,
  type StatusPayload,
} from "@handoff/shared"
import { slugify } from "@handoff/shared/git"
import { condenseTranscript } from "@handoff/shared/transcript"
import { briefPrompt, parseBrief } from "./brief.js"
import { packInputs, reviewInputs, type ReviewedInput } from "./inputs.js"
import { summarizeSkipped } from "./secrets.js"
import { adoptSnapshot, applyResult, createBundle, deleteRef, repoTop, takeSnapshot, type ApplyOutcome } from "./repo.js"
import {
  DEFAULT_SETTINGS,
  WORK_DIR,
  acquireLease,
  loadConfig,
  loadSettings,
  loadState,
  mutateState,
  releaseLease,
  saveConfig,
  saveSettings,
  updateJob,
  type ClientSettings,
  type DeviceConfig,
  type DeviceJob,
  type InputRequest,
} from "./store.js"

export interface Opencode {
  /** Name of the app the user talks to, for messages (default "opencode"). */
  readonly app?: string
  /** The session's agent has the handoff tools (handoff, handoff_send, handoff_status). */
  readonly tools?: boolean
  /** Working directory of a session. */
  sessionDirectory(sessionID: string): Promise<string>
  sessionTitle(sessionID: string): Promise<string | null>
  exportSession(sessionID: string): Promise<unknown>
  /** Ask the session's model for text, from the session's context, without adding a turn. */
  generate(sessionID: string, prompt: string): Promise<string>
  /** Add a message to the session; with resume the agent takes a turn. Returns false if the session is gone. */
  post(sessionID: string, text: string, opts: { resume: boolean; description: string }): Promise<boolean>
  createSession(directory: string, title: string): Promise<string>
  log(message: string): void
}

/** Inbox description marking ephemeral notices (see tui.ts). */
export const NOTICE = "handoff-notice"
const ACTIVE_POLL_MS = 15_000
/** After a result, the user may keep talking to the agent in T3; check for updates this often. */
const CONVERSATION_POLL_MS = 60_000
const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000
const IDLE_POLL_MS = 5 * 60_000
/** Writing the brief uses the session's model; don't hold the handoff up longer than this per attempt. */
const BRIEF_TIMEOUT_MS = 90_000
const BRIEF_ATTEMPTS = 2
const LEASE_MS = 60_000
/** Longer than any single relay call may take (blob transfers allow 15 minutes). */
const POLL_STUCK_MS = 20 * 60_000

const short = (id: string) => id.slice(-6).toLowerCase()

export class Engine {
  private readonly owner = `${process.pid}-${Math.random().toString(36).slice(2)}`
  private timer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private pollStartedAt = 0
  private pollPass = 0
  /** Finished relay jobs that aren't updates for this machine (e.g. results whose local record is gone). */
  private readonly unclaimable = new Set<string>()
  /** Only a started engine polls; command-handling engines stay passive. */
  private stopped = true

  constructor(private readonly opencode: Opencode) {}

  private async client(): Promise<{ config: DeviceConfig; relay: DeviceClient }> {
    const config = await loadConfig()
    if (!config) throw new Error("This machine is not paired. On the host run `handoff-daemon pair`, then `/handoff pair <url> <code>` here.")
    return { config, relay: new DeviceClient({ url: config.relayUrl, token: config.token, ...(config.headers ? { headers: config.headers } : {}) }) }
  }

  // ---------- commands ----------

  async handle(sessionID: string, rawText: string): Promise<void> {
    const text = rawText.replace(/^\s*\/handoff\b/, "").trim()
    const [sub, ...rest] = text.split(/\s+/)
    // Ephemeral replies: the TUI plugin shows these as toasts and drops them from the inbox.
    const say = (msg: string) => this.opencode.post(sessionID, msg, { resume: false, description: NOTICE })
    try {
      switch (sub?.toLowerCase()) {
        case "pair":
          return void (await say(await this.pair(rest[0] ?? "", rest[1] ?? "", rest[2] ?? "", rest.slice(3).join(" "))))
        case "status":
          return void (await say(await this.status()))
        case "cancel":
          return void (await say(await this.cancel(rest[0] ?? "")))
        case "reply":
          return void (await say(await this.reply(rest[0] ?? "", rest.slice(1).join(" "))))
        case "approve":
          return void (await say(await this.decide(rest[0] ?? "", true)))
        case "deny":
          return void (await say(await this.decide(rest[0] ?? "", false, rest.slice(1).join(" "))))
        case "config":
          return void (await say(await this.configure(rest)))
        case "help":
          return void (await say(HELP))
        default: {
          const { instructions, ...options } = parseHandoffArgs(text)
          // The user is driving again: the local agent's automatic follow-ups start over.
          await mutateState((s) => void delete s.blockedRounds?.[sessionID])
          if ((await loadSettings()).brief) await say("Writing the handoff brief…")
          const job = await this.submit(sessionID, instructions, options)
          // A notice, not a queued message: queued messages reach the agent one turn each, so a stale
          // "handed off" note would cost a turn ahead of the result. The result message says it all.
          await say(
            `Handed off as job \`${short(job.id)}\`. The host will pick it up${job.instructions ? "" : " and continue this session's work"}. ` +
              `Results land back here automatically, even if this machine sleeps or goes offline in the meantime. Use \`/handoff status\` to check progress.` +
              sentNote(job),
          )
        }
      }
    } catch (err) {
      await say(`Handoff failed: ${(err as Error).message}`)
    }
  }

  async pair(url: string, code: string, hostFingerprint: string, name: string): Promise<string> {
    if (!url || !code || !hostFingerprint) {
      return "Usage: `/handoff pair <relay-url> <code> <host-fingerprint>`. Run `handoff-daemon pair` on the host to get this command."
    }
    const keys = (await loadConfig())?.keys ?? (await generateKeyPair())
    const res = await DeviceClient.pair({ url }, { code, name: name || hostname(), publicKey: keys.publicKey })
    // The relay handed us the host's key; trust it only if it matches the fingerprint you copied from the host.
    const received = await fingerprint(res.hostPublicKey)
    if (received !== normalizeFingerprint(hostFingerprint)) {
      throw new Error(
        `the host key from the relay has fingerprint ${received}, not ${normalizeFingerprint(hostFingerprint)}. ` +
          "Not paired. Someone may be tampering with the relay; on the host run `handoff-daemon devices` and revoke the new device.",
      )
    }
    await saveConfig({ relayUrl: url.replace(/\/+$/, ""), token: res.token, deviceId: res.deviceId, keys, hostPublicKey: res.hostPublicKey })
    return `Paired with the host. Confirm on the host that this machine's fingerprint is:\n\n${await fingerprint(keys.publicKey)}`
  }

  async submit(sessionID: string, instructions: string, options: SubmitOptions = {}, retryOf?: DeviceJob): Promise<DeviceJob> {
    const { config, relay } = await this.client()
    const settings = await loadSettings()
    const model = options.model ?? settings.model
    const directory = retryOf?.directory ?? (await this.opencode.sessionDirectory(sessionID))
    const top = retryOf?.repoTop ?? (await repoTop(directory).catch(() => {
      throw new Error(`${directory} is not inside a git repository`)
    }))
    const id = ulid()
    const repo = await mutateState((s) => {
      s.repos[top] ??= { id: ulid().toLowerCase(), knownCommit: null }
      return { ...s.repos[top]! }
    })

    const job: DeviceJob = {
      id,
      phase: "packing",
      sessionID,
      directory,
      repoTop: top,
      repoId: repo.id,
      branch: null,
      head: null,
      instructions,
      ...(model ? { model } : {}),
      apply: options.apply ?? settings.apply,
      createdAt: Date.now(),
      ...(retryOf ? { retryOf: retryOf.id } : {}),
    }
    await mutateState((s) => void (s.jobs[id] = job))

    // Inputs that need the user's approval; delivered to the running handoff if they give it.
    let asks: InputSpec[] = []
    try {
      const snap = retryOf?.snapshot
        ? await adoptSnapshot(top, id, { branch: retryOf.branch, head: retryOf.head, snapshot: retryOf.snapshot })
        : await takeSnapshot(top, id)
      if (retryOf?.snapshotRef) await deleteRef(top, retryOf.snapshotRef)
      const known = retryOf ? null : repo.knownCommit
      const { bundle, base } = await createBundle(top, snap, known)
      Object.assign(job, { branch: snap.branch, head: snap.head, snapshot: snap.snapshot, snapshotRef: snap.snapshotRef, base })
      await updateJob(id, { branch: snap.branch, head: snap.head, snapshot: snap.snapshot, snapshotRef: snap.snapshotRef, base })

      let transcript = ""
      try {
        transcript = condenseTranscript(await this.opencode.exportSession(sessionID), settings.transcriptChars)
      } catch (err) {
        this.opencode.log(`handoff: session export failed: ${(err as Error).message}`)
      }
      const repoName = top.split("/").pop() || "repo"
      const brief = options.brief ?? retryOf?.brief ?? (settings.brief && !retryOf && !options.skipBrief ? await this.writeBrief(sessionID, instructions, repoName) : undefined)
      if (brief) await updateJob(id, { brief })

      // Material beyond the snapshot: what the brief or the agent listed. Anything that needs the
      // user's approval follows as a delivery once they give it.
      const wanted = mergeInputs(brief?.inputs, options.inputs ?? retryOf?.inputs)
      let inputs: RequestManifest["inputs"]
      let inputBundles: Uint8Array[] = []
      if (wanted.length) {
        const reviewed = await reviewInputs(wanted, top)
        asks = reviewed.filter((r) => r.decision === "ask").map((r) => r.spec)
        const packed = await packInputs(reviewed.filter((r) => r.decision !== "ask"), id, { approvedByUser: false, exclude: [snap.snapshot] })
        inputs = { delivered: packed.delivered, refused: [...packed.refused, ...asks.map((a) => ({ name: a.name, reason: "waiting for the user's approval; it's delivered here if they give it" }))] }
        inputBundles = packed.bundles
      }
      const sent = { inputs: inputs?.delivered.map((d) => d.name) ?? [], refused: inputs?.refused ?? [], skipped: snap.skipped }
      await updateJob(id, { sent, ...(wanted.length ? { inputs: wanted } : {}) })
      const manifest: RequestManifest = {
        v: PROTOCOL_VERSION,
        jobId: id,
        deviceId: config.deviceId,
        createdAt: job.createdAt,
        instructions,
        ...(brief ? { brief } : {}),
        repo: {
          id: repo.id,
          name: repoName,
          branch: snap.branch,
          head: snap.head,
          snapshot: snap.snapshot,
          snapshotRef: snap.snapshotRef,
          base,
          remotes: snap.remotes,
        },
        session: { id: sessionID, title: await this.opencode.sessionTitle(sessionID).catch(() => null), directory, transcript },
        options: model ? { model } : {},
        ...(inputs ? { inputs } : {}),
        ...(snap.skipped.length ? { skipped: snap.skipped } : {}),
      }
      const sealed = await seal(packContainer(manifest, concat([bundle, ...inputBundles])), config.hostPublicKey, config.keys, sealContext.request(id))
      await updateJob(id, { phase: "uploading" })
      await relay.createJob(id)
      await relay.uploadRequest(id, sealed)
      await updateJob(id, { phase: "submitted", lastStatus: "queued for the host" })
    } catch (err) {
      await updateJob(id, { phase: "failed", lastStatus: (err as Error).message })
      throw err
    }
    if (asks.length) {
      const req: InputRequest = { id: ulid(), inputs: asks, state: "awaiting-approval", createdAt: Date.now() }
      await mutateState((s) => void (s.jobs[id]!.inputRequests = [req]))
      await this.askApproval((await loadState()).jobs[id]!, req)
    }
    this.kick()
    return (await loadState()).jobs[id]!
  }

  // ---------- the local agent's tools ----------

  /** The `handoff` tool: the session's agent hands off (or follows up) with its own brief. */
  async agentHandoff(sessionID: string, args: AgentHandoffArgs): Promise<string> {
    const running = await this.runningJob(sessionID)
    if (running) throw new Error(`handoff \`${short(running.id)}\` from this session is still running on the host. Use handoff_send to give it more material or a message.`)
    const task = args.task?.trim()
    if (!task || task.length < 20) throw new Error("`task` must be the full brief for the host agent: goal, context, remaining work, constraints, and how to tell it's done")
    const inputs = args.inputs?.length ? normalizeInputList(args.inputs) : []
    const title = (args.title?.trim() || task.split("\n").find((l) => l.trim())!.replace(/^#+\s*/, "")).slice(0, 80)
    const top = await repoTop(await this.opencode.sessionDirectory(sessionID)).catch(() => "")
    const brief: HandoffBrief = {
      title,
      slug: slugify(title, 40),
      projectName: top.split("/").pop() || "",
      context: args.context ?? "reference",
      files: (args.files ?? []).filter((f) => typeof f === "string" && f.trim() && !f.includes("..")).map((f) => f.trim().replace(/^\/+/, "")).slice(0, 20),
      task,
      ...(inputs.length ? { inputs } : {}),
    }
    const job = await this.submit(sessionID, args.request?.trim() ?? "", { ...(args.model ? { model: checkModelArg(args.model) } : {}), ...(args.keepOnBranch ? { apply: "branch" } : {}), brief })
    return `Handed off as job ${short(job.id)}.${sentNote(job)}\n\nThe host works on it in the background. Its result, or any question or request it has, arrives in this session as a message: don't poll or wait for it.`
  }

  /** The `handoff_send` tool: more material or a message for this session's handoff. */
  async agentSend(sessionID: string, args: AgentSendArgs): Promise<string> {
    const inputs = args.inputs?.length ? normalizeInputList(args.inputs) : []
    const message = args.message?.trim()
    if (!inputs.length && !message) throw new Error("give `inputs`, a `message`, or both")
    const target = args.job ? await this.findJob(args.job) : ((await this.runningJob(sessionID)) ?? (await this.latestJob(sessionID)))
    if (!target) throw new Error("this session has no handoff yet; use the handoff tool")
    if (target.phase !== "submitted") {
      // That run is over: a follow-up continues the same T3 thread with the material.
      const job = await this.submit(sessionID, message || "Continue the task with the inputs provided.", { inputs, skipBrief: true })
      return `Handoff ${short(target.id)} had finished, so this went as follow-up job ${short(job.id)} in the same T3 thread.${sentNote(job)}\n\nThe result arrives here as a message.`
    }
    const { config, relay } = await this.client()
    const req: InputRequest = { id: ulid(), inputs, ...(message ? { message } : {}), state: "sending", createdAt: Date.now() }
    const reviewed = await reviewInputs(inputs, target.repoTop)
    if (reviewed.some((r) => r.decision === "ask")) {
      req.state = "awaiting-approval"
      await this.saveRequest(target.id, req)
      await this.askApproval(target, req)
      return `Some of this is outside the handed-off repository, so the user has to approve it first (they were asked with \`/handoff approve ${short(target.id)}\`). Nothing was sent yet. Don't approve on their behalf.`
    }
    await this.saveRequest(target.id, req)
    const packed = await this.sendInputs(config, relay, target, req, reviewed, false)
    return `Sent to handoff ${short(target.id)}: ${describePacked(packed)}`
  }

  private async runningJob(sessionID: string): Promise<DeviceJob | undefined> {
    const jobs = Object.values((await loadState()).jobs).filter((j) => j.sessionID === sessionID && ["packing", "uploading", "submitted"].includes(j.phase))
    return jobs.sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  private async latestJob(sessionID: string): Promise<DeviceJob | undefined> {
    return Object.values((await loadState()).jobs)
      .filter((j) => j.sessionID === sessionID)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  // ---------- inputs for a running handoff ----------

  private async saveRequest(jobId: string, req: InputRequest): Promise<void> {
    await mutateState((s) => {
      const job = s.jobs[jobId]
      if (!job) return
      job.inputRequests = [...(job.inputRequests ?? []).filter((r) => r.id !== req.id), { ...req }]
      job.updatedAt = Date.now()
    })
  }

  private async askApproval(job: DeviceJob, req: InputRequest): Promise<void> {
    const who = req.requestId ? "The host agent working on" : "Sending more material to"
    await updateJob(job.id, { lastStatus: "waiting for your approval to send material" })
    await this.postToSession(
      job,
      `${who} handoff \`${short(job.id)}\` wants material from outside its repository:\n\n${req.inputs.map((i) => `- ${describeInputSpec(i)}`).join("\n")}${req.note ? `\n\nThe agent says: ${req.note}` : ""}\n\n` +
        `Send it with \`/handoff approve ${short(job.id)}\`, or refuse with \`/handoff deny ${short(job.id)} [reason]\`. Files that look like secrets are left out either way.`,
      false,
    )
  }

  /** Package inputs and deliver them to the host for a running handoff. */
  private async sendInputs(
    config: DeviceConfig,
    relay: DeviceClient,
    job: DeviceJob,
    req: InputRequest,
    reviewed: ReviewedInput[],
    approvedByUser: boolean,
    refuseReason?: string,
  ): Promise<Awaited<ReturnType<typeof packInputs>>> {
    const deliveryJobId = req.deliveryJobId ?? ulid()
    Object.assign(req, { deliveryJobId, state: "sending", ...(approvedByUser ? { approved: true } : {}), ...(refuseReason ? { refuseReason } : {}) })
    await this.saveRequest(job.id, req)
    await mutateState((s) => void ((s.deliveries ??= {})[deliveryJobId] = job.id))
    try {
      const packed = await packInputs(reviewed, deliveryJobId, { approvedByUser, exclude: job.snapshot ? [job.snapshot] : [], ...(refuseReason ? { refuseReason } : {}) })
      const manifest: InputsManifest = {
        v: PROTOCOL_VERSION,
        kind: "inputs",
        jobId: deliveryJobId,
        deviceId: config.deviceId,
        parentJobId: job.id,
        ...(req.requestId ? { requestId: req.requestId } : {}),
        ...(req.message ? { message: req.message } : {}),
        delivered: packed.delivered,
        refused: packed.refused,
      }
      const sealed = await seal(packContainer(manifest, concat(packed.bundles)), config.hostPublicKey, config.keys, sealContext.request(deliveryJobId))
      // On a retry the upload may already be done; only the notice is missing then.
      const record = await relay.createJob(deliveryJobId)
      if (record.status === "uploading") await relay.uploadRequest(deliveryJobId, sealed)
      const notice: DeliveryNotice = { type: "inputs", deliveryJobId }
      await relay.postEvent(job.id, "reply", await sealJson(notice, config.hostPublicKey, config.keys, sealContext.event("reply", job.id)))
      Object.assign(req, { state: "sent", detail: describePacked(packed) })
      await this.saveRequest(job.id, req)
      await updateJob(job.id, { lastStatus: `sent material to the host: ${describePacked(packed)}` })
      return packed
    } catch (err) {
      Object.assign(req, { state: "failed", detail: (err as Error).message })
      await this.saveRequest(job.id, req)
      throw err
    }
  }

  /** The host agent asked for material. Send what policy allows; wake this session's agent for the rest. */
  private async onInputRequest(config: DeviceConfig, relay: DeviceClient, job: DeviceJob, p: InputRequestPayload): Promise<void> {
    if (job.inputRequests?.some((r) => r.requestId === p.requestId)) return
    let inputs: InputSpec[]
    try {
      inputs = normalizeInputList(p.inputs)
    } catch {
      inputs = []
    }
    const req: InputRequest = { id: ulid(), requestId: p.requestId, inputs, ...(p.note ? { note: p.note } : {}), state: "sending", createdAt: Date.now() }
    const reviewed = await reviewInputs(inputs, job.repoTop)
    if (reviewed.some((r) => r.decision === "ask")) {
      req.state = "awaiting-approval"
      await this.saveRequest(job.id, req)
      return this.askApproval(job, req)
    }
    await this.saveRequest(job.id, req)
    const packed = await this.sendInputs(config, relay, job, req, reviewed, false)
    if (!packed.refused.length) {
      await this.opencode.post(job.sessionID, `Handoff \`${short(job.id)}\`: the host agent asked for material; sent ${describePacked(packed)}`, { resume: false, description: NOTICE }).catch(() => false)
      return
    }
    // Some of it isn't here as asked (e.g. a branch that needs fetching): this session's agent can fix that.
    const { resume } = await loadSettings()
    const asked = inputs.map((i) => `- ${describeInputSpec(i)}`).join("\n")
    const fix = this.opencode.tools
      ? "If you can get what's missing on this machine (for example `git fetch` a branch that's only on a remote, or find the right path), do it and call `handoff_send` with the corrected `inputs`. The host agent is waiting. Ask the user only for access or decisions you don't have."
      : "Tell the user what's missing and how to provide it (for example `git fetch` the branch), then they can run `/handoff <message>` once this run finishes."
    await this.postToSession(
      job,
      `The host agent working on handoff \`${short(job.id)}\` asked for:\n\n${asked}${p.note ? `\n\nIt says: ${p.note}` : ""}\n\nSent: ${packed.delivered.map((d) => `\`${d.name}\``).join(", ") || "nothing"}. Couldn't send:\n${packed.refused.map((r) => `- \`${r.name}\`: ${r.reason}`).join("\n")}${resume ? `\n\n_${fix}_` : ""}`,
      resume,
    )
  }

  /** `/handoff approve <id>` and `/handoff deny <id> [reason]`: the user's decision on material waiting for approval. */
  async decide(ref: string, approve: boolean, reason = ""): Promise<string> {
    const job = await this.findJob(ref)
    const waiting = (job.inputRequests ?? []).filter((r) => r.state === "awaiting-approval")
    if (!waiting.length) throw new Error(`handoff \`${short(job.id)}\` has nothing waiting for approval`)
    const { config, relay } = await this.client()
    const lines: string[] = []
    for (const req of waiting) {
      const reviewed = await reviewInputs(req.inputs, job.repoTop)
      const packed = await this.sendInputs(config, relay, job, req, reviewed, approve, approve ? undefined : `the user declined${reason ? `: ${reason}` : ""}`)
      lines.push(describePacked(packed))
    }
    await updateJob(job.id, { lastStatus: approve ? "approved material sent" : "material declined" })
    return approve ? `Sent to handoff \`${short(job.id)}\`: ${lines.join("; ")}` : `Told the host agent of \`${short(job.id)}\` that you declined.`
  }

  /** The host's receipt for a delivery. */
  private async confirmDelivery(config: DeviceConfig, relay: DeviceClient, deliveryId: string): Promise<void> {
    const parentId = (await loadState()).deliveries?.[deliveryId]
    if (!parentId) return
    const plain = await open(await relay.downloadResult(deliveryId), config.keys, config.hostPublicKey, sealContext.result(deliveryId))
    const { header } = unpackContainer<InputsReceipt>(plain)
    if (header.kind !== "inputs-receipt" || header.jobId !== deliveryId || header.parentJobId !== parentId) throw new Error(`unexpected receipt for delivery ${deliveryId}`)
    await mutateState((s) => {
      const req = s.jobs[parentId]?.inputRequests?.find((r) => r.deliveryJobId === deliveryId)
      if (req) Object.assign(req, { state: "received", detail: `the host received ${header.imported.length ? header.imported.map((n) => `\`${n}\``).join(", ") : "the reply"}` })
      delete s.deliveries?.[deliveryId]
    })
    await relay.ack(deliveryId).catch((err) => this.opencode.log(`handoff: ack failed: ${(err as Error).message}`))
  }

  private async deliveryFailed(deliveryId: string, message: string): Promise<void> {
    const parentId = (await loadState()).deliveries?.[deliveryId]
    if (!parentId) return
    await mutateState((s) => {
      const req = s.jobs[parentId]?.inputRequests?.find((r) => r.deliveryJobId === deliveryId)
      if (req) Object.assign(req, { state: "rejected", detail: message })
      delete s.deliveries?.[deliveryId]
    })
    const job = (await loadState()).jobs[parentId]
    if (job) await this.postToSession(job, `Material sent to handoff \`${short(job.id)}\` couldn't be used on the host: ${message}`, false)
  }

  /** The session's model writes the brief; if it can't, the user's words go as they are. */
  private async writeBrief(sessionID: string, instructions: string, repoName: string): Promise<HandoffBrief | undefined> {
    // Models occasionally return nothing or malformed JSON; one retry fixes most of those.
    for (let attempt = 1; attempt <= BRIEF_ATTEMPTS; attempt++) {
      try {
        const text = await withTimeout(this.opencode.generate(sessionID, briefPrompt(instructions, repoName)), BRIEF_TIMEOUT_MS)
        const brief = parseBrief(text)
        if (brief) return brief
        this.opencode.log(`handoff: the model's brief wasn't usable (attempt ${attempt}): ${JSON.stringify(text.slice(0, 300))}`)
      } catch (err) {
        this.opencode.log(`handoff: couldn't write a brief (attempt ${attempt}): ${(err as Error).message}`)
      }
    }
    this.opencode.log("handoff: sending the request as typed")
    return undefined
  }

  /** `/handoff config [key [value|reset]]` */
  async configure(args: string[]): Promise<string> {
    const settings = await loadSettings()
    const [key, ...rest] = args
    const value = rest.join(" ")
    if (!key) {
      const lines = Object.entries(CLIENT_SETTING_HELP).map(([k, help]) => `- \`${k}\`: **${formatSetting(settings, k as keyof ClientSettings)}**. ${help}`)
      return `Handoff settings (\`/handoff config <key> <value>\`, or \`reset\`):\n${lines.join("\n")}`
    }
    if (!Object.hasOwn(CLIENT_SETTING_HELP, key)) throw new Error(`unknown setting \`${key}\`. Settings: ${Object.keys(CLIENT_SETTING_HELP).join(", ")}`)
    const k = key as keyof ClientSettings
    if (!value) return `\`${k}\` is **${formatSetting(settings, k)}**. ${CLIENT_SETTING_HELP[k]}`
    const next: Record<string, unknown> = { ...settings }
    if (value === "reset" || (value === "default" && k === "model")) {
      delete next[k]
      Object.assign(next, { ...DEFAULT_SETTINGS, ...next })
    } else if (k === "model") {
      next.model = checkModelArg(value)
    } else if (k === "apply") {
      if (value !== "auto" && value !== "branch") throw new Error("`apply` is `auto` or `branch`")
      next.apply = value
    } else if (k === "autoFollowUps") {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error("`autoFollowUps` is a whole number from 0 to 10")
      next.autoFollowUps = n
    } else if (k === "resume" || k === "brief") {
      if (value !== "true" && value !== "false") throw new Error(`\`${k}\` is \`true\` or \`false\``)
      next[k] = value === "true"
    } else {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0) throw new Error("`transcriptChars` is a whole number")
      next.transcriptChars = n
    }
    await saveSettings(next as unknown as ClientSettings)
    return `\`${k}\` is now **${formatSetting(next as unknown as ClientSettings, k)}**.`
  }

  async status(): Promise<string> {
    const state = await loadState()
    const jobs = Object.values(state.jobs).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10)
    const config = await loadConfig()
    const me = config ? `This machine's fingerprint: ${await fingerprint(config.keys.publicKey)}\n\n` : ""
    if (!jobs.length) return `${me}No handoffs yet.`
    let remote = new Map<string, JobRecord>()
    try {
      const { relay } = await this.client()
      remote = new Map((await relay.listJobs()).map((j) => [j.id, j]))
    } catch {}
    const lines = jobs.map((j) => {
      const r = remote.get(j.id)
      const what = (j.instructions || "(continue session)").split("\n")[0]!.slice(0, 50)
      return `- \`${short(j.id)}\` ${j.phase}${r ? ` / relay: ${r.status}` : ""}: ${what}${j.lastStatus ? `\n  ${j.lastStatus}` : ""}${j.question ? `\n  ❓ waiting for your answer: \`/handoff reply ${short(j.id)} <answer>\`` : ""}${j.inputRequests?.some((r) => r.state === "awaiting-approval") ? `\n  ❓ material waiting for your approval: \`/handoff approve ${short(j.id)}\` or \`/handoff deny ${short(j.id)}\`` : ""}`
    })
    return `${me}Recent handoffs:\n${lines.join("\n")}`
  }

  private async findJob(ref: string): Promise<DeviceJob> {
    const state = await loadState()
    const matches = Object.values(state.jobs).filter((j) => j.id === ref || short(j.id) === ref.toLowerCase())
    if (matches.length !== 1) throw new Error(ref ? `no unique job matching \`${ref}\`` : "specify a job id (see `/handoff status`)")
    return matches[0]!
  }

  async cancel(ref: string): Promise<string> {
    const job = await this.findJob(ref)
    const { config, relay } = await this.client()
    await relay.postEvent(job.id, "cancel", await sealJson({ reason: "user" }, config.hostPublicKey, config.keys, sealContext.event("cancel", job.id)))
    await updateJob(job.id, { lastStatus: "cancel requested" })
    return `Cancel requested for \`${short(job.id)}\`.`
  }

  async reply(ref: string, answer: string): Promise<string> {
    const job = await this.findJob(ref)
    if (!job.question) throw new Error(`job \`${short(job.id)}\` has no open question`)
    const { config, relay } = await this.client()
    const answers = buildAnswers(job.question.question, answer)
    const payload: ReplyPayload = { requestId: job.question.requestId, answers }
    await relay.postEvent(job.id, "reply", await sealJson(payload, config.hostPublicKey, config.keys, sealContext.event("reply", job.id)))
    const { question: _q, ...rest } = job
    await mutateState((s) => void (s.jobs[job.id] = { ...rest, lastStatus: "answer sent" }))
    return `Answer sent to the host for \`${short(job.id)}\`.`
  }

  // ---------- polling ----------

  /** Starts the background loop. Safe to call from every plugin instance. */
  start(): void {
    this.stopped = false
    this.schedule(1000)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await releaseLease(this.owner).catch(() => {})
  }

  kick(): void {
    this.schedule(500)
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), ms)
  }

  private async tick(): Promise<void> {
    let next = ACTIVE_POLL_MS
    try {
      const active = await this.pollOnce()
      if (!active) {
        // Nothing in flight (a submit kicks the loop immediately). Updates from T3 can still arrive.
        const recent = Object.values((await loadState()).jobs).some((j) => j.phase === "applied" && Date.now() - j.createdAt < CONVERSATION_WINDOW_MS)
        next = recent ? CONVERSATION_POLL_MS : IDLE_POLL_MS
      }
    } catch (err) {
      this.opencode.log(`handoff: poll failed: ${(err as Error).message}`)
      next = 60_000
    }
    this.schedule(next)
  }

  /** One polling pass. Returns true while any job is still in flight. */
  async pollOnce(): Promise<boolean> {
    if (this.polling) {
      if (Date.now() - this.pollStartedAt < POLL_STUCK_MS) return true
      // A pass that never finished (e.g. a call into opencode that never returned) must not stop polling for good.
      this.opencode.log(`handoff: previous poll still running after ${Math.round((Date.now() - this.pollStartedAt) / 60_000)} minutes; starting a new one`)
    }
    const pass = ++this.pollPass
    this.polling = true
    this.pollStartedAt = Date.now()
    try {
      const config = await loadConfig()
      if (!config) return false
      const state = await loadState()
      const inFlight = Object.values(state.jobs).filter((j) => ["uploading", "submitted", "applying"].includes(j.phase))
      // Events are checked even with nothing in flight: the host may send an update from T3.
      if (!(await acquireLease(this.owner, LEASE_MS))) return inFlight.length > 0

      const { relay } = await this.client()
      // Resume uploads interrupted by a shutdown.
      for (const job of inFlight.filter((j) => j.phase === "uploading")) await this.resumeUpload(job)

      // One request returns new events and this device's open jobs (each extra request costs relay quota).
      let cursor = state.eventCursor
      let open: JobRecord[] = []
      for (;;) {
        const { events, cursor: next, jobs } = await relay.sync(cursor)
        open = jobs
        for (const ev of events) {
          try {
            await this.handleEvent(config, relay, ev)
          } catch (err) {
            this.opencode.log(`handoff: event ${ev.seq} for job ${ev.jobId} failed: ${(err as Error).message}`)
          }
        }
        if (next === cursor) break
        cursor = next
        await mutateState((s) => void (s.eventCursor = next))
        if (events.length < 200) break
      }

      // Deliveries interrupted by a shutdown or a relay error: send them again (same delivery id).
      for (const job of Object.values((await loadState()).jobs).filter((j) => j.phase === "submitted")) {
        for (const req of (job.inputRequests ?? []).filter((r) => r.state === "sending" || r.state === "failed")) {
          await this.sendInputs(config, relay, job, req, await reviewInputs(req.inputs, job.repoTop), req.approved ?? false, req.refuseReason).catch((err: unknown) =>
            this.opencode.log(`handoff: resending material for ${job.id} failed: ${(err as Error).message}`),
          )
        }
      }

      // Safety net for missed events: reconcile in-flight jobs with their relay status. Jobs missing
      // from the open list have ended (cancelled, failed or gone); only those need a lookup.
      const openById = new Map(open.map((j) => [j.id, j]))
      for (const job of Object.values((await loadState()).jobs).filter((j) => ["submitted", "applying"].includes(j.phase))) {
        const remote = openById.get(job.id) ?? (await relay.getJob(job.id).catch((e: unknown) => (e instanceof RelayError && e.status === 404 ? null : undefined)))
        if (remote === null) await updateJob(job.id, { phase: "failed", lastStatus: "job no longer exists on the relay" })
        else if (remote?.status === "done") await this.deliver(config, relay, job.id)
        else if (remote?.status === "cancelled") await this.finishCancelled(job)
        else if (remote?.status === "failed" && remote.errorCode !== "needs_full_bundle") {
          await updateJob(job.id, { phase: "failed", lastStatus: `failed on the host (${remote.errorCode ?? "see events"})` })
        }
      }

      // Same for updates from T3: they aren't in local state until received, so a lost or failed
      // result event would otherwise strand them on the relay. Pick up any finished, unclaimed one.
      const { jobs: known, deliveries = {} } = await loadState()
      for (const remote of open.filter((j) => j.status === "done" && !known[j.id] && !this.unclaimable.has(j.id))) {
        if (deliveries[remote.id]) {
          await this.confirmDelivery(config, relay, remote.id).catch((err: unknown) => this.opencode.log(`handoff: delivery ${remote.id}: ${(err as Error).message}`))
          continue
        }
        await this.receiveUpdate(config, relay, remote.id).catch((err: unknown) => {
          if (!(err instanceof RelayError)) this.unclaimable.add(remote.id)
          this.opencode.log(`handoff: update ${remote.id} failed: ${(err as Error).message}`)
        })
      }
      return Object.values((await loadState()).jobs).some((j) => ["uploading", "submitted", "applying"].includes(j.phase))
    } finally {
      if (pass === this.pollPass) this.polling = false
    }
  }

  private async resumeUpload(job: DeviceJob): Promise<void> {
    // The sealed blob isn't persisted; abandon and resubmit from the saved snapshot ref.
    await updateJob(job.id, { phase: "failed", lastStatus: "upload interrupted; resubmitted" })
    await this.submit(job.sessionID, job.instructions, jobOptions(job), job).catch((err) =>
      this.opencode.log(`handoff: resubmit failed: ${(err as Error).message}`),
    )
  }

  private async handleEvent(config: DeviceConfig, relay: DeviceClient, ev: RelayEvent): Promise<void> {
    if (ev.from !== "host") return
    const state = await loadState()
    const job = state.jobs[ev.jobId]
    if (!job) {
      if (state.deliveries?.[ev.jobId]) {
        // Material this machine sent to a running handoff: the host's receipt, or why it failed.
        if (ev.kind === "result") await this.confirmDelivery(config, relay, ev.jobId)
        if (ev.kind === "error") await this.deliveryFailed(ev.jobId, (await openJson<ErrorPayload>(ev.payload, config.keys, config.hostPublicKey, sealContext.event(ev.kind, ev.jobId))).message)
        return
      }
      // A result for a job this machine didn't start: an update from a conversation's T3 thread.
      if (ev.kind === "result") await this.receiveUpdate(config, relay, ev.jobId)
      return
    }
    // Every host event must be sealed by the host key pinned at pairing.
    const read = <T>() => openJson<T>(ev.payload, config.keys, config.hostPublicKey, sealContext.event(ev.kind, ev.jobId))
    switch (ev.kind) {
      case "status": {
        const p = await read<StatusPayload>()
        if (p.activity) {
          // Activity in the thread after this job's result arrived; the job's own outcome stays as it was.
          await updateJob(job.id, { remote: { active: p.activity === "busy", note: p.message, since: Date.now() } })
          break
        }
        await updateJob(job.id, { lastStatus: p.message, ...(p.threadId ? { threadId: p.threadId } : {}) })
        if (p.announce) await this.opencode.post(job.sessionID, `Handoff \`${short(job.id)}\`: ${p.message}`, { resume: false, description: NOTICE }).catch(() => false)
        break
      }
      case "question": {
        const p = await read<QuestionPayload | InputRequestPayload>()
        if (p.type === "inputs") {
          await this.onInputRequest(config, relay, job, p)
          break
        }
        await updateJob(job.id, { question: { requestId: p.requestId, question: p.question }, lastStatus: "agent asked a question" })
        await this.postToSession(
          job,
          `The host agent working on handoff \`${short(job.id)}\` has a question:\n\n${describeQuestion(p.question)}\n\nAnswer with \`/handoff reply ${short(job.id)} <answer>\`.`,
          false,
        )
        break
      }
      case "error": {
        const p = await read<ErrorPayload>()
        if (p.code === "needs_full_bundle" && !job.retryOf) {
          await updateJob(job.id, { phase: "failed", lastStatus: "Host needed a full bundle; resubmitting" })
          await mutateState((s) => {
            const repo = s.repos[job.repoTop]
            if (repo) repo.knownCommit = null
          })
          await this.submit(job.sessionID, job.instructions, jobOptions(job), job)
          return
        }
        await updateJob(job.id, { phase: "failed", lastStatus: p.message })
        await this.postToSession(job, `Handoff \`${short(job.id)}\` failed on the host: ${p.message}`, false)
        break
      }
      case "result":
        await this.deliver(config, relay, job.id)
        break
    }
  }

  private async finishCancelled(job: DeviceJob): Promise<void> {
    await updateJob(job.id, { phase: "cancelled", lastStatus: "cancelled" })
    if (job.snapshotRef) await deleteRef(job.repoTop, job.snapshotRef)
    await this.postToSession(job, `Handoff \`${short(job.id)}\` was cancelled.`, false)
  }

  /** Download, apply, and report a finished job. Idempotent across crashes. */
  private async deliver(config: DeviceConfig, relay: DeviceClient, jobId: string): Promise<void> {
    const job = (await loadState()).jobs[jobId]
    if (!job || job.phase === "applied") return
    await updateJob(jobId, { phase: "applying" })

    // Fails unless the host sealed this result for this job.
    const plain = await open(await relay.downloadResult(jobId), config.keys, config.hostPublicKey, sealContext.result(jobId))
    const { header: result, payload: bundle } = unpackContainer<ResultManifest>(plain)
    if (result.jobId !== jobId || result.snapshot !== job.snapshot) throw new Error("result does not match this handoff")
    const workDir = join(WORK_DIR, jobId)
    await mkdir(workDir, { recursive: true, mode: 0o700 })
    let outcome: ApplyOutcome
    try {
      outcome = await applyResult({
        cwd: job.repoTop,
        bundle,
        resultBranch: result.branch,
        resultHead: result.head,
        origBranch: job.branch,
        origHead: job.head,
        snapshot: result.snapshot,
        workDir,
        mode: job.apply ?? "auto",
      })
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }

    const rounds = await mutateState((s) => {
      const repo = s.repos[job.repoTop]
      if (repo && result.knownCommit) repo.knownCommit = result.knownCommit
      const j = s.jobs[jobId]
      if (j) Object.assign(j, { phase: "applied", outcome: result.outcome, resultBranch: result.branch, lastStatus: describeOutcome(outcome, result), updatedAt: Date.now(), remote: undefined })
      s.blockedRounds ??= {}
      if (result.outcome === "blocked") s.blockedRounds[job.sessionID] = (s.blockedRounds[job.sessionID] ?? 0) + 1
      else delete s.blockedRounds[job.sessionID]
      return s.blockedRounds[job.sessionID] ?? 0
    })
    if (job.snapshotRef) await deleteRef(job.repoTop, job.snapshotRef)

    const settings = await loadSettings()
    const next = { resume: settings.resume, tools: this.opencode.tools ?? false, rounds, maxRounds: settings.autoFollowUps }
    await this.postToSession(job, resultMessage(job, result, outcome, next, this.opencode.app ?? "opencode"), settings.resume)
    await relay.ack(jobId).catch((err) => this.opencode.log(`handoff: ack failed: ${(err as Error).message}`))
  }

  /**
   * The conversation continued in T3 (the user replied to the agent there) and the
   * host sent the result. Apply it like a handoff result, in the session it belongs to.
   */
  private async receiveUpdate(config: DeviceConfig, relay: DeviceClient, jobId: string): Promise<void> {
    const plain = await open(await relay.downloadResult(jobId), config.keys, config.hostPublicKey, sealContext.result(jobId))
    const { header: result } = unpackContainer<ResultManifest>(plain)
    if (result.jobId !== jobId || result.origin !== "host") throw new Error(`unexpected result for unknown job ${jobId}`)
    const jobs = Object.values((await loadState()).jobs)
    const parent =
      (result.parentJobId ? jobs.find((j) => j.id === result.parentJobId) : undefined) ??
      jobs.filter((j) => j.sessionID === result.sessionId).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!parent) throw new Error(`update ${jobId} is for a session this machine doesn't know`)
    const job: DeviceJob = {
      id: jobId,
      phase: "submitted",
      origin: "host",
      sessionID: parent.sessionID,
      directory: parent.directory,
      repoTop: parent.repoTop,
      repoId: parent.repoId,
      // Your branch fast-forwards only if it is still exactly where the last result left it.
      branch: parent.branch,
      head: result.snapshot,
      snapshot: result.snapshot,
      instructions: "",
      ...(parent.apply ? { apply: parent.apply } : {}),
      createdAt: Date.now(),
      lastStatus: "update from T3",
    }
    await mutateState((s) => void (s.jobs[jobId] ??= job))
    await this.deliver(config, relay, jobId)
  }

  private async postToSession(job: DeviceJob, text: string, resume: boolean): Promise<void> {
    const ok = await this.opencode.post(job.sessionID, text, { resume, description: `handoff ${short(job.id)}` }).catch(() => false)
    if (ok) return
    // Original session is gone; continue in a fresh one in the same directory.
    const sessionID = await this.opencode.createSession(job.directory, `Handoff ${short(job.id)}`)
    await updateJob(job.id, { sessionID })
    await this.opencode.post(sessionID, text, { resume, description: `handoff ${short(job.id)}` })
  }
}

// ---------- helpers ----------

const HELP = `**/handoff**: send this session's work to the host, where T3 Code finishes it and results come back here.

- \`/handoff <instructions>\`: hand off with instructions (empty = continue what we were doing)
- Name models in plain words: \`/handoff continue with opus, have fable and astra subagents review the plan, then execute with 6.1 sol\`. The first model named outside a subagent phrase leads; the others are used for the steps you name them for. The host only accepts models it allows (\`handoff-daemon models\` there).
- \`/handoff --model <name|provider/model> <instructions>\`: set the lead model explicitly (e.g. \`opus\` or \`claudeAgent/claude-opus-5-5:effort=high\`)
- \`/handoff --branch ...\`: keep the result on its own branch instead of fast-forwarding yours
- Follow up by running \`/handoff <message>\` again in the same session: it continues the same T3 thread. Replies you give the agent directly in T3 come back here too.
- \`/handoff config [key [value|reset]]\`: show or change defaults (model, apply, resume, transcriptChars)
- \`/handoff status\`: recent handoffs
- \`/handoff reply <id> <answer>\`: answer a question from the host agent
- \`/handoff approve <id>\` / \`/handoff deny <id> [reason]\`: decide on material from outside the repository that an agent wants to send to the host
- Agents can drive handoffs too: ask this session's agent to "research X, then hand off with opus" and it uses the \`handoff\` tool, sending the branches and files the work needs. When the host agent is missing something, it asks for it: anything from this repository (including its other worktrees) is sent automatically, anything else needs your approval, and secret-looking files (.env, keys, credentials) are never sent.
- \`/handoff cancel <id>\`
- \`/handoff pair <relay-url> <code> <host-fingerprint>\`: pair this machine (run \`handoff-daemon pair\` on the host for the command)`

export interface HandoffOptions {
  model?: string
  apply?: ClientSettings["apply"]
}

interface SubmitOptions extends HandoffOptions {
  /** A brief written by the agent itself, instead of asking the model for one. */
  brief?: HandoffBrief
  inputs?: InputSpec[]
  /** Send the request as given (a follow-up carrying material). */
  skipBrief?: boolean
}

/** Arguments of the local agent's `handoff` tool. */
export interface AgentHandoffArgs {
  task: string
  request?: string
  title?: string
  model?: string
  inputs?: unknown[]
  files?: string[]
  context?: HandoffBrief["context"]
  keepOnBranch?: boolean
}

/** Arguments of the local agent's `handoff_send` tool. */
export interface AgentSendArgs {
  inputs?: unknown[]
  message?: string
  job?: string
}

function mergeInputs(...lists: Array<InputSpec[] | undefined>): InputSpec[] {
  const out: InputSpec[] = []
  for (const spec of lists.flatMap((l) => l ?? [])) if (!out.some((o) => o.name === spec.name)) out.push(spec)
  return out
}

function describePacked(p: { delivered: Array<{ name: string; skipped: string[] }>; refused: Array<{ name: string; reason: string }> }): string {
  const sent = p.delivered.map((d) => `\`${d.name}\`${d.skipped.length ? ` (left out as secret-looking: ${summarizeSkipped(d.skipped, 5)})` : ""}`)
  const refused = p.refused.map((r) => `\`${r.name}\` not sent: ${r.reason}`)
  return [sent.length ? sent.join(", ") : "", ...refused].filter(Boolean).join("; ") || "a message"
}

/** What went beyond the snapshot, for the "handed off" notice and the tool result. */
function sentNote(job: DeviceJob): string {
  const s = job.sent
  if (!s) return ""
  const parts = [
    s.inputs.length ? `Also sent: ${s.inputs.map((n) => `\`${n}\``).join(", ")}.` : "",
    s.refused.length ? `Not sent: ${s.refused.map((r) => `\`${r.name}\` (${r.reason})`).join(", ")}.` : "",
    s.skipped.length ? `Left out of the snapshot as secret-looking: ${summarizeSkipped(s.skipped, 10)}.` : "",
  ].filter(Boolean)
  return parts.length ? ` ${parts.join(" ")}` : ""
}

const jobOptions = (job: DeviceJob): HandoffOptions => ({
  ...(job.model ? { model: job.model } : {}),
  ...(job.apply ? { apply: job.apply } : {}),
})

/** A full spec is checked here; short names ("opus") are resolved by the host against its allowed models. */
function checkModelArg(value: string): string {
  return value.includes("/") ? formatModelSpec(parseModelSpec(value)) : value
}

/**
 * Leading flags: --model <spec|name>, --branch. The rest is the instructions,
 * which may also name models in plain words ("...with opus, have fable review it").
 */
export function parseHandoffArgs(text: string): HandoffOptions & { instructions: string } {
  const options: HandoffOptions = {}
  let rest = text.trim()
  for (;;) {
    const m = rest.match(/^--(model)(?:=|\s+)(\S+)\s*/) ?? rest.match(/^--(branch)(?:\s+|$)/)
    if (!m) break
    if (m[1] === "model") options.model = checkModelArg(m[2]!)
    else options.apply = "branch"
    rest = rest.slice(m[0].length)
  }
  return { ...options, instructions: rest.trim() }
}

const CLIENT_SETTING_HELP: Record<keyof ClientSettings, string> = {
  model: "Lead model for your handoffs: a short name like `opus` or `<provider>/<model>[:option=value,...]`; `default` lets the host decide. Must be allowed on the host.",
  apply: "`auto` fast-forwards your branch when it hasn't moved; `branch` always leaves results on their own branch.",
  resume: "`true` lets the local agent respond when a result arrives; `false` just adds the result to the session.",
  transcriptChars: "Most characters of session transcript sent with a handoff.",
  brief: "`true` has this session's model write a task brief for the host agent; `false` sends your request as typed.",
  autoFollowUps: "How many times in a row this session's agent may follow up a blocked handoff on its own (getting what the host agent is missing and sending it). `0` always leaves it to you.",
}

function formatSetting(settings: ClientSettings, key: keyof ClientSettings): string {
  const v = settings[key]
  if (v === undefined) return "host default"
  return String(v)
}

function describeQuestion(q: unknown): string {
  const obj = q as Record<string, unknown> | null
  const questions = (obj?.questions ?? (obj?.request as Record<string, unknown> | undefined)?.questions) as Array<Record<string, unknown>> | undefined
  if (Array.isArray(questions) && questions.length) {
    return questions
      .map((x) => {
        const opts = Array.isArray(x.options) ? (x.options as Array<Record<string, unknown>>).map((o) => String(o.label ?? o)).join(" / ") : ""
        return `- ${String(x.question ?? x.prompt ?? x.header ?? JSON.stringify(x))}${opts ? ` (options: ${opts})` : ""}`
      })
      .join("\n")
  }
  return "```json\n" + JSON.stringify(q, null, 2).slice(0, 4000) + "\n```"
}

/** Map a free-text answer onto the pending request's question ids. */
function buildAnswers(q: unknown, answer: string): Record<string, unknown> {
  const obj = q as Record<string, unknown> | null
  const questions = (obj?.questions ?? (obj?.request as Record<string, unknown> | undefined)?.questions) as Array<Record<string, unknown>> | undefined
  if (Array.isArray(questions) && questions.length) {
    const out: Record<string, unknown> = {}
    for (const x of questions) out[String(x.id ?? x.question ?? "answer")] = answer
    return out
  }
  return { answer }
}

function describeOutcome(outcome: ApplyOutcome, result: ResultManifest): string {
  switch (outcome.kind) {
    case "fast-forwarded":
      return `applied: \`${outcome.branch}\` fast-forwarded (${result.commits.length} commits)`
    case "branch-only":
      return `saved on branch \`${result.branch}\` (${outcome.reason})`
    case "no-changes":
      return "finished without code changes"
  }
}

interface NextStep {
  resume: boolean
  /** The agent has the handoff tools. */
  tools: boolean
  /** Blocked results in a row in this session, and how many the agent may follow up on its own. */
  rounds: number
  maxRounds: number
}

function resultMessage(job: DeviceJob, result: ResultManifest, outcome: ApplyOutcome, next: NextStep, app: string): string {
  const { resume } = next
  const commits = result.commits.map((c) => `- \`${c.sha.slice(0, 8)}\` ${c.subject}`).join("\n")
  let applied: string
  switch (outcome.kind) {
    case "fast-forwarded":
      applied = (outcome.note ? `${outcome.note} ` : "") + (
        result.origin === "host"
          ? `Your branch \`${outcome.branch}\` was fast-forwarded to the new commits (also saved as \`${result.branch}\`).`
          : `Your branch \`${outcome.branch}\` was fast-forwarded to the host's commits (also saved as \`${result.branch}\`). Your uncommitted work from before the handoff is now the first commit ("WIP: uncommitted changes at handoff").`)
      break
    case "branch-only":
      applied = `The commits are on local branch \`${result.branch}\`. I did not touch your checkout because ${outcome.reason}. Integrate with \`git merge ${result.branch}\` (or cherry-pick) when ready.`
      break
    case "no-changes":
      applied = "The host made no code changes."
  }
  const update = result.origin === "host"
  const blocked = result.outcome === "blocked"
  return [
    update
      ? `## Update from T3 (\`${short(job.id)}\`)${blocked ? ": blocked" : ""}`
      : `## Handoff \`${short(job.id)}\` ${result.outcome === "succeeded" ? "finished" : blocked ? "is blocked" : "ended without success"}`,
    update
      ? `The conversation from this session continued on the host in T3 thread "${result.t3.threadTitle}".${result.request ? ` The message sent to the agent in T3:\n\n> ${result.request.replace(/\n/g, "\n> ")}\n\n` : " "}Reply here with \`/handoff <message>\` to continue it from ${app}.`
      : `You handed this off from this session${job.instructions ? ` with the instructions: "${job.instructions.split("\n")[0]!.slice(0, 300)}"` : " to continue the work in progress"}. It ran on the host in T3 thread "${result.t3.threadTitle}". Follow up with \`/handoff <message>\` here, or directly in that thread in T3.`,
    applied,
    commits ? `### Commits\n${commits}` : "",
    result.diffstat ? `### Diffstat\n\`\`\`\n${result.diffstat}\n\`\`\`` : "",
    `### host agent's summary\n${result.summary}`,
    blocked && result.missing ? `### What the host agent needs\n${result.missing}` : "",
    resume ? (blocked ? blockedStep(next) : "_The handoff is complete. Briefly confirm the result for the user (mention anything that needs their attention) and wait for further instructions._") : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

/** What this session's agent should do about a blocked handoff. */
function blockedStep(next: NextStep): string {
  if (!next.tools) return "_The host agent is blocked. Tell the user exactly what it needs and how to provide it (for example, `git fetch` the branch here, then `/handoff <message>` naming it). Don't start other work._"
  if (next.rounds > next.maxRounds) {
    return `_The host agent is still blocked after ${next.maxRounds} automatic follow-up${next.maxRounds === 1 ? "" : "s"}. Tell the user what it needs and why it couldn't be supplied, then wait for them._`
  }
  return (
    "_The host agent is blocked on what's listed above. If you can supply it from this machine, do it now: get it (for example `git fetch` a branch that's only on a remote, find the right repository or files, or do the research it needs), then call the `handoff_send` tool with those `inputs` and a short `message`. That continues the same T3 thread. " +
    `Ask the user only for decisions or access you don't have, and say what you're doing. (Automatic follow-up ${next.rounds} of ${next.maxRounds}.)_`
  )
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms)
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    )
  })
}
