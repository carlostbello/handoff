// Single Durable Object holding all relay state in SQLite: devices, pairing
// codes, jobs, and the ordered event log. It also owns the hibernatable
// WebSocket the host daemon keeps open for instant job notifications.

import { DurableObject } from "cloudflare:workers"
import {
  TERMINAL_STATUSES,
  b64url,
  randomBytes,
  sha256Hex,
  type DeviceInfo,
  type EventKind,
  type JobRecord,
  type JobStatus,
  type RelayEvent,
} from "@handoff/shared"

export interface Env {
  HUB: DurableObjectNamespace<Hub>
  BLOBS: R2Bucket
  HOST_TOKEN: string
}

export type Principal = { role: "host" } | { role: "device"; deviceId: string }

/** Message is "HTTP <status>: <detail>" so the status survives Durable Object RPC, which drops the class. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly code?: string,
  ) {
    super(`HTTP ${status}: ${detail}`)
  }
}

const PAIRING_TTL_MS = 10 * 60 * 1000
const TICKET_TTL_MS = 60 * 1000
const MAX_PAIR_FAILURES_PER_IP_HOUR = 10
const MAX_PAIR_FAILURES_PER_HOUR = 100
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

type BlobKind = "request" | "result"

const HOST_TRANSITIONS: Partial<Record<JobStatus, readonly JobStatus[]>> = {
  claimed: ["running", "failed", "cancelled", "queued"],
  running: ["needs_input", "failed", "cancelled"],
  needs_input: ["running", "failed", "cancelled"],
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export class Hub extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
          last_seen_at INTEGER, revoked_at INTEGER);
        CREATE TABLE IF NOT EXISTS pairings (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tickets (ticket_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pair_failures (at INTEGER NOT NULL, ip TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, device_id TEXT NOT NULL, status TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          request_upload TEXT, request_size INTEGER,
          result_upload TEXT, result_size INTEGER, error_code TEXT);
        CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, device_id TEXT NOT NULL,
          sender TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS events_device ON events(device_id, seq);
      `)
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000)
    })
  }

  // ---------- auth ----------

  async authenticate(token: string): Promise<Principal | null> {
    if (!token) return null
    if (this.env.HOST_TOKEN && timingSafeEqual(token, this.env.HOST_TOKEN)) return { role: "host" }
    const hash = await sha256Hex(token)
    const row = this.sql
      .exec<{ id: string }>("SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL", hash)
      .toArray()[0]
    if (!row) return null
    this.sql.exec("UPDATE devices SET last_seen_at = ? WHERE id = ?", Date.now(), row.id)
    return { role: "device", deviceId: row.id }
  }

  // ---------- host key, pairing, devices ----------

  setHostKey(publicKey: string): void {
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('host_public_key', ?)", publicKey)
  }

  hostKey(): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'host_public_key'").toArray()[0]?.value ?? null
  }

  async createPairing(): Promise<{ code: string; expiresAt: number }> {
    const bytes = randomBytes(8)
    let code = ""
    for (const b of bytes) code += CROCKFORD[b % 32]
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.sql.exec("INSERT INTO pairings (code_hash, expires_at) VALUES (?, ?)", await sha256Hex(code), expiresAt)
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt }
  }

  async pair(code: string, name: string, publicKey: string, ip: string): Promise<{ deviceId: string; token: string; hostPublicKey: string }> {
    const now = Date.now()
    this.sql.exec("DELETE FROM pair_failures WHERE at < ?", now - 60 * 60 * 1000)
    const total = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pair_failures").one().n
    const fromIp = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pair_failures WHERE ip = ?", ip).one().n
    if (fromIp >= MAX_PAIR_FAILURES_PER_IP_HOUR || total >= MAX_PAIR_FAILURES_PER_HOUR) {
      throw new HttpError(429, "too many pairing attempts; try later")
    }

    const hostPublicKey = this.hostKey()
    if (!hostPublicKey) throw new HttpError(409, "host has not registered its key yet")

    const normalized = code.toUpperCase().replace(/[^0-9A-Z]/g, "")
    const hash = await sha256Hex(normalized)
    const row = this.sql
      .exec<{ expires_at: number }>("SELECT expires_at FROM pairings WHERE code_hash = ?", hash)
      .toArray()[0]
    if (!row || row.expires_at < now) {
      this.sql.exec("INSERT INTO pair_failures (at, ip) VALUES (?, ?)", now, ip)
      throw new HttpError(403, "invalid or expired pairing code")
    }
    this.sql.exec("DELETE FROM pairings WHERE code_hash = ?", hash)

    const deviceId = `dev_${b64url(randomBytes(9))}`
    const token = `hod_${b64url(randomBytes(32))}`
    this.sql.exec(
      "INSERT INTO devices (id, name, public_key, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      deviceId,
      name.slice(0, 100),
      publicKey,
      await sha256Hex(token),
      now,
    )
    return { deviceId, token, hostPublicKey }
  }

  devices(): DeviceInfo[] {
    return this.sql
      .exec<{ id: string; name: string; public_key: string; created_at: number; last_seen_at: number | null }>(
        "SELECT id, name, public_key, created_at, last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at",
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        name: r.name,
        publicKey: r.public_key,
        createdAt: r.created_at,
        ...(r.last_seen_at ? { lastSeenAt: r.last_seen_at } : {}),
      }))
  }

  revokeDevice(id: string): void {
    this.sql.exec("UPDATE devices SET revoked_at = ? WHERE id = ?", Date.now(), id)
  }

  async createSocketTicket(): Promise<string> {
    const ticket = b64url(randomBytes(24))
    this.sql.exec("DELETE FROM tickets WHERE expires_at < ?", Date.now())
    this.sql.exec("INSERT INTO tickets (ticket_hash, expires_at) VALUES (?, ?)", await sha256Hex(ticket), Date.now() + TICKET_TTL_MS)
    return ticket
  }

  // ---------- jobs ----------

  private row(id: string): (JobRecord & { requestUpload: string | null; resultUpload: string | null }) | null {
    const r = this.sql
      .exec<{
        id: string
        device_id: string
        status: JobStatus
        created_at: number
        updated_at: number
        request_upload: string | null
        request_size: number | null
        result_upload: string | null
        result_size: number | null
        error_code: string | null
      }>("SELECT * FROM jobs WHERE id = ?", id)
      .toArray()[0]
    if (!r) return null
    return {
      id: r.id,
      deviceId: r.device_id,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ...(r.request_size != null ? { requestSize: r.request_size } : {}),
      ...(r.result_size != null ? { resultSize: r.result_size } : {}),
      ...(r.error_code ? { errorCode: r.error_code } : {}),
      requestUpload: r.request_upload,
      resultUpload: r.result_upload,
    }
  }

  private public(job: NonNullable<ReturnType<Hub["row"]>>): JobRecord {
    const { requestUpload: _a, resultUpload: _b, ...rest } = job
    return rest
  }

  getJob(principal: Principal, id: string): JobRecord {
    return this.public(this.authorizedJob(principal, id))
  }

  private authorizedJob(principal: Principal, id: string) {
    const job = this.row(id)
    if (!job || (principal.role === "device" && job.deviceId !== principal.deviceId)) {
      throw new HttpError(404, "job not found")
    }
    return job
  }

  listJobs(principal: Principal, status?: JobStatus): JobRecord[] {
    const clauses: string[] = []
    const args: (string | number)[] = []
    if (principal.role === "device") {
      clauses.push("device_id = ?")
      args.push(principal.deviceId)
    }
    if (status) {
      clauses.push("status = ?")
      args.push(status)
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    return this.sql
      .exec<{ id: string }>(`SELECT id FROM jobs ${where} ORDER BY created_at DESC LIMIT 200`, ...args)
      .toArray()
      .map((r) => this.public(this.row(r.id)!))
  }

  /** Idempotent: re-creating an uploading job owned by the same device returns it. */
  createJob(deviceId: string, id: string): JobRecord {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new HttpError(400, "job id must be a ULID")
    const existing = this.row(id)
    if (existing) {
      if (existing.deviceId !== deviceId) throw new HttpError(409, "job id in use")
      return this.public(existing)
    }
    const now = Date.now()
    this.sql.exec(
      "INSERT INTO jobs (id, device_id, status, created_at, updated_at) VALUES (?, ?, 'uploading', ?, ?)",
      id,
      deviceId,
      now,
      now,
    )
    return this.public(this.row(id)!)
  }

  /** Returns the R2 multipart upload id for a blob, recording a new one if needed. */
  uploadIdFor(principal: Principal, id: string, kind: BlobKind): { uploadId: string | null; allowed: boolean } {
    const job = this.authorizedJob(principal, id)
    if (kind === "request") {
      if (principal.role !== "device" || job.status !== "uploading") return { uploadId: null, allowed: false }
      return { uploadId: job.requestUpload, allowed: true }
    }
    if (principal.role !== "host" || !["claimed", "running", "needs_input"].includes(job.status)) {
      return { uploadId: null, allowed: false }
    }
    return { uploadId: job.resultUpload, allowed: true }
  }

  recordUploadId(id: string, kind: BlobKind, uploadId: string): void {
    this.sql.exec(`UPDATE jobs SET ${kind}_upload = ?, updated_at = ? WHERE id = ?`, uploadId, Date.now(), id)
  }

  completeUpload(principal: Principal, id: string, kind: BlobKind, size: number): JobRecord {
    const job = this.authorizedJob(principal, id)
    const now = Date.now()
    if (kind === "request") {
      this.sql.exec("UPDATE jobs SET status = 'queued', request_size = ?, updated_at = ? WHERE id = ?", size, now, id)
      this.broadcast({ type: "job", jobId: id })
    } else {
      this.sql.exec("UPDATE jobs SET status = 'done', result_size = ?, updated_at = ? WHERE id = ?", size, now, id)
      this.appendEvent(job.id, job.deviceId, "host", "result", "")
    }
    return this.public(this.row(id)!)
  }

  claim(id: string): JobRecord {
    const job = this.row(id)
    if (!job) throw new HttpError(404, "job not found")
    if (job.status !== "queued") throw new HttpError(409, `job is ${job.status}`)
    this.sql.exec("UPDATE jobs SET status = 'claimed', updated_at = ? WHERE id = ?", Date.now(), id)
    return this.public(this.row(id)!)
  }

  setStatus(id: string, status: JobStatus, errorCode?: string): JobRecord {
    const job = this.row(id)
    if (!job) throw new HttpError(404, "job not found")
    const allowed = HOST_TRANSITIONS[job.status] ?? []
    if (job.status !== status && !allowed.includes(status)) {
      throw new HttpError(409, `cannot move job from ${job.status} to ${status}`)
    }
    this.sql.exec(
      "UPDATE jobs SET status = ?, error_code = ?, updated_at = ? WHERE id = ?",
      status,
      errorCode ?? null,
      Date.now(),
      id,
    )
    return this.public(this.row(id)!)
  }

  /** Device acknowledges the result; blobs can be deleted. Returns blob keys to delete. */
  ack(deviceId: string, id: string): string[] {
    const job = this.authorizedJob({ role: "device", deviceId }, id)
    if (!TERMINAL_STATUSES.includes(job.status)) throw new HttpError(409, `job is ${job.status}`)
    this.sql.exec("UPDATE jobs SET status = 'delivered', updated_at = ? WHERE id = ?", Date.now(), id)
    return [`jobs/${id}/request`, `jobs/${id}/result`]
  }

  // ---------- events ----------

  private appendEvent(jobId: string, deviceId: string, sender: "host" | "device", kind: EventKind, payload: string): void {
    this.sql.exec(
      "INSERT INTO events (job_id, device_id, sender, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      jobId,
      deviceId,
      sender,
      kind,
      payload,
      Date.now(),
    )
    if (sender === "device") this.broadcast({ type: "event", jobId })
  }

  postEvent(principal: Principal, jobId: string, kind: EventKind, payload: string): void {
    const job = this.authorizedJob(principal, jobId)
    const sender = principal.role
    const deviceKinds: EventKind[] = ["reply", "cancel"]
    const hostKinds: EventKind[] = ["status", "question", "error"]
    if (!(sender === "device" ? deviceKinds : hostKinds).includes(kind)) {
      throw new HttpError(400, `${sender} cannot send ${kind} events`)
    }
    if (payload.length > 512 * 1024) throw new HttpError(413, "event payload too large")
    if (kind === "cancel" && (job.status === "uploading" || job.status === "queued")) {
      this.sql.exec("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?", Date.now(), jobId)
    }
    this.appendEvent(jobId, job.deviceId, sender, kind, payload)
  }

  events(principal: Principal, after: number): { events: RelayEvent[]; cursor: number } {
    const rows =
      principal.role === "device"
        ? this.sql
            .exec<EventRow>(
              "SELECT * FROM events WHERE device_id = ? AND sender = 'host' AND seq > ? ORDER BY seq LIMIT 200",
              principal.deviceId,
              after,
            )
            .toArray()
        : this.sql.exec<EventRow>("SELECT * FROM events WHERE sender = 'device' AND seq > ? ORDER BY seq LIMIT 200", after).toArray()
    const events = rows.map((r) => ({
      seq: r.seq,
      jobId: r.job_id,
      deviceId: r.device_id,
      from: r.sender,
      kind: r.kind,
      payload: r.payload,
      createdAt: r.created_at,
    }))
    return { events, cursor: events.at(-1)?.seq ?? after }
  }

  // ---------- websocket ----------

  override async fetch(request: Request): Promise<Response> {
    const ticket = new URL(request.url).searchParams.get("ticket") ?? ""
    const hash = await sha256Hex(ticket)
    const row = this.sql
      .exec<{ expires_at: number }>("SELECT expires_at FROM tickets WHERE ticket_hash = ?", hash)
      .toArray()[0]
    this.sql.exec("DELETE FROM tickets WHERE ticket_hash = ?", hash)
    if (!row || row.expires_at < Date.now()) return new Response("invalid ticket", { status: 401 })
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], ["host"])
    pair[1].send(JSON.stringify({ type: "hello" }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") ws.send("pong")
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, "closing")
    } catch {}
  }

  private broadcast(message: object): void {
    const text = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets("host")) {
      try {
        ws.send(text)
      } catch {}
    }
  }

  // ---------- retention ----------

  override async alarm(): Promise<void> {
    const cutoff = Date.now() - RETENTION_MS
    const stale = this.sql.exec<{ id: string }>("SELECT id FROM jobs WHERE updated_at < ?", cutoff).toArray()
    for (const { id } of stale) {
      await this.env.BLOBS.delete([`jobs/${id}/request`, `jobs/${id}/result`])
      this.sql.exec("DELETE FROM events WHERE job_id = ?", id)
      this.sql.exec("DELETE FROM jobs WHERE id = ?", id)
    }
    this.sql.exec("DELETE FROM pairings WHERE expires_at < ?", Date.now())
    this.sql.exec("DELETE FROM tickets WHERE expires_at < ?", Date.now())
    await this.ctx.storage.setAlarm(Date.now() + 6 * 60 * 60 * 1000)
  }
}

interface EventRow {
  seq: number
  job_id: string
  device_id: string
  sender: "host" | "device"
  kind: EventKind
  payload: string
  created_at: number
  [key: string]: SqlStorageValue
}
