import {
  PART_SIZE,
  type CompleteUploadRequest,
  type CreateJobResponse,
  type DeviceInfo,
  type EventKind,
  type EventsResponse,
  type JobRecord,
  type JobStatus,
  type PairRequest,
  type PairResponse,
  type UploadedPart,
} from "./protocol.js"
import type { Bytes } from "./encoding.js"

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

export interface RelayClientOptions {
  url: string
  token?: string
  /** Extra headers on every request (e.g. Cloudflare Access service token). */
  headers?: Record<string, string>
  fetch?: typeof fetch
  retries?: number
  /** Per-attempt limit, so a connection that dies mid-request (sleep, network change) can't hang a caller. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
/** Jobs a client still has to act on (matches the relay's /v1/sync). */
const OPEN_STATUSES: readonly JobStatus[] = ["uploading", "queued", "claimed", "running", "needs_input", "done"]
/** Blob parts and downloads are larger; allow for slow links. */
const BLOB_TIMEOUT_MS = 15 * 60_000

/** "fetch failed" alone says nothing; the cause (DNS, refused, reset, timeout...) is what's useful in a log. */
function describeNetworkError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } }
  const cause = e.cause?.code ?? e.cause?.message
  return cause && !e.message.includes(cause) ? `${e.message} (${cause})` : e.message
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class BaseClient {
  protected readonly base: string
  constructor(protected readonly opts: RelayClientOptions) {
    this.base = opts.url.replace(/\/+$/, "")
  }

  protected async request(method: string, path: string, body?: BodyInit | object, extra?: Record<string, string>, timeoutMs?: number): Promise<Response> {
    const headers: Record<string, string> = { ...this.opts.headers, ...extra }
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`
    let payload: BodyInit | undefined
    if (body instanceof Uint8Array || body instanceof ArrayBuffer || typeof body === "string") {
      payload = body as BodyInit
      headers["content-type"] ??= "application/octet-stream"
    } else if (body !== undefined) {
      payload = JSON.stringify(body)
      headers["content-type"] = "application/json"
    }
    const doFetch = this.opts.fetch ?? fetch
    const retries = this.opts.retries ?? 4
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await doFetch(this.base + path, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) })
      } catch (err) {
        if (attempt >= retries) throw new RelayError(`network error: ${describeNetworkError(err)}`, 0)
        await sleep(Math.min(30_000, 500 * 2 ** attempt))
        continue
      }
      if (res.ok) return res
      let code: string | undefined
      let message = `${method} ${path} -> ${res.status}`
      try {
        const data = (await res.json()) as { error?: string; code?: string }
        if (data.error) message += `: ${data.error}`
        code = data.code
      } catch {}
      const err = new RelayError(message, res.status, code)
      if (!err.retryable || attempt >= retries) throw err
      await sleep(Math.min(30_000, 500 * 2 ** attempt))
    }
  }

  protected async json<T>(method: string, path: string, body?: object): Promise<T> {
    return (await (await this.request(method, path, body)).json()) as T
  }

  protected async uploadBlob(prefix: string, data: Uint8Array): Promise<void> {
    const parts: UploadedPart[] = []
    const count = Math.max(1, Math.ceil(data.length / PART_SIZE))
    for (let i = 0; i < count; i++) {
      const chunk = new Uint8Array(data.subarray(i * PART_SIZE, (i + 1) * PART_SIZE)) as Bytes
      const res = await this.request("PUT", `${prefix}/parts/${i + 1}`, chunk, undefined, BLOB_TIMEOUT_MS)
      parts.push((await res.json()) as UploadedPart)
    }
    const complete: CompleteUploadRequest = { parts, size: data.length }
    await this.request("POST", `${prefix}/complete`, complete)
  }

  protected async downloadBlob(path: string): Promise<Bytes> {
    const res = await this.request("GET", path, undefined, undefined, BLOB_TIMEOUT_MS)
    return new Uint8Array(await res.arrayBuffer()) as Bytes
  }

  async health(): Promise<{ ok: boolean; hostKey: boolean }> {
    return this.json("GET", "/v1/health")
  }
}

/** Client used by the opencode plugin on the client. */
export class DeviceClient extends BaseClient {
  static async pair(opts: RelayClientOptions, req: PairRequest): Promise<PairResponse> {
    const client = new DeviceClient(opts)
    return client.json<PairResponse>("POST", "/v1/pair", req)
  }

  async createJob(id: string): Promise<JobRecord> {
    return (await this.json<CreateJobResponse>("POST", "/v1/jobs", { id })).job
  }

  async uploadRequest(jobId: string, sealed: Uint8Array): Promise<void> {
    await this.uploadBlob(`/v1/jobs/${jobId}/request`, sealed)
  }

  async getJob(jobId: string): Promise<JobRecord> {
    return this.json("GET", `/v1/jobs/${jobId}`)
  }

  async listJobs(): Promise<JobRecord[]> {
    return (await this.json<{ jobs: JobRecord[] }>("GET", "/v1/jobs")).jobs
  }

  async downloadResult(jobId: string): Promise<Bytes> {
    return this.downloadBlob(`/v1/jobs/${jobId}/result`)
  }

  async ack(jobId: string): Promise<void> {
    await this.request("POST", `/v1/jobs/${jobId}/ack`, {})
  }

  async events(after: number): Promise<EventsResponse> {
    return this.json("GET", `/v1/events?after=${after}`)
  }

  private syncSupported = true

  /**
   * New events plus this device's open jobs, in one request. Falls back to separate calls
   * against a relay that predates /v1/sync.
   */
  async sync(after: number): Promise<EventsResponse & { jobs: JobRecord[] }> {
    if (this.syncSupported) {
      try {
        return await this.json("GET", `/v1/sync?after=${after}`)
      } catch (err) {
        if (!(err instanceof RelayError && err.status === 404)) throw err
        this.syncSupported = false
      }
    }
    const [events, jobs] = await Promise.all([this.events(after), this.listJobs()])
    return { ...events, jobs: jobs.filter((j) => OPEN_STATUSES.includes(j.status)) }
  }

  async postEvent(jobId: string, kind: EventKind, payload: string): Promise<void> {
    await this.request("POST", "/v1/events", { jobId, kind, payload })
  }

  /** Report a client-side problem to the host (payload sealed by the caller). Older relays ignore it. */
  async postDiagnostic(id: string, payload: string): Promise<boolean> {
    try {
      await this.request("POST", "/v1/diagnostics", { id, payload })
      return true
    } catch (err) {
      if (err instanceof RelayError && (err.status === 404 || err.status === 429)) return false
      throw err
    }
  }
}

/** Client used by the daemon on the host. */
export class HostClient extends BaseClient {
  async setHostKey(publicKey: string): Promise<void> {
    await this.request("PUT", "/v1/host/key", { publicKey })
  }

  async createPairing(): Promise<{ code: string; expiresAt: number }> {
    return this.json("POST", "/v1/host/pairings", {})
  }

  async devices(): Promise<DeviceInfo[]> {
    return (await this.json<{ devices: DeviceInfo[] }>("GET", "/v1/host/devices")).devices
  }

  async revokeDevice(id: string): Promise<void> {
    await this.request("DELETE", `/v1/host/devices/${id}`)
  }

  /** Start a job for a paired device: an update the host pushes without a request. */
  async createJob(id: string, deviceId: string): Promise<JobRecord> {
    return (await this.json<{ job: JobRecord }>("POST", "/v1/host/jobs", { id, deviceId })).job
  }

  async jobs(status?: JobStatus): Promise<JobRecord[]> {
    const q = status ? `?status=${status}` : ""
    return (await this.json<{ jobs: JobRecord[] }>("GET", `/v1/host/jobs${q}`)).jobs
  }

  /** Returns the job if this call claimed it, or null if it was not claimable. */
  async claim(jobId: string): Promise<JobRecord | null> {
    try {
      return await this.json<JobRecord>("POST", `/v1/host/jobs/${jobId}/claim`, {})
    } catch (err) {
      if (err instanceof RelayError && err.status === 409) return null
      throw err
    }
  }

  async downloadRequest(jobId: string): Promise<Bytes> {
    return this.downloadBlob(`/v1/host/jobs/${jobId}/request`)
  }

  async setStatus(jobId: string, status: JobStatus, errorCode?: string): Promise<void> {
    await this.request("POST", `/v1/host/jobs/${jobId}/status`, { status, errorCode })
  }

  async uploadResult(jobId: string, sealed: Uint8Array): Promise<void> {
    await this.uploadBlob(`/v1/host/jobs/${jobId}/result`, sealed)
  }

  async events(after: number): Promise<EventsResponse> {
    return this.json("GET", `/v1/host/events?after=${after}`)
  }

  private syncSupported = true

  /** New device events plus queued jobs, in one request (separate calls on an older relay). */
  async sync(after: number): Promise<EventsResponse & { queued: JobRecord[] }> {
    if (this.syncSupported) {
      try {
        return await this.json("GET", `/v1/host/sync?after=${after}`)
      } catch (err) {
        if (!(err instanceof RelayError && err.status === 404)) throw err
        this.syncSupported = false
      }
    }
    const [events, queued] = await Promise.all([this.events(after), this.jobs("queued")])
    return { ...events, queued }
  }

  async postEvent(jobId: string, kind: EventKind, payload: string): Promise<void> {
    await this.request("POST", "/v1/host/events", { jobId, kind, payload })
  }

  /** WebSocket URL (with a single-use ticket) that pushes `{type:"job"|"event"}` notifications. */
  async socketUrl(): Promise<string> {
    const { ticket } = await this.json<{ ticket: string }>("POST", "/v1/host/socket-ticket", {})
    return this.base.replace(/^http/, "ws") + `/v1/host/socket?ticket=${encodeURIComponent(ticket)}`
  }
}
