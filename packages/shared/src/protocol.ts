// Wire protocol shared by the relay, the host daemon, and the opencode plugin.
// Everything sensitive (code, transcripts, summaries, questions) travels inside
// encrypted blobs or encrypted event payloads; the relay only sees ids and states.

export const PROTOCOL_VERSION = 1

export type JobStatus =
  | "uploading" // device is still uploading the request blob
  | "queued" // request blob complete, waiting for the host
  | "claimed" // Host downloaded it and is preparing the T3 thread
  | "running" // T3 thread is working
  | "needs_input" // agent asked a question; waiting for a device reply
  | "done" // result blob uploaded
  | "failed" // terminal failure (details in an encrypted event)
  | "cancelled"
  | "delivered" // device applied the result and acknowledged it

export const TERMINAL_STATUSES: readonly JobStatus[] = ["done", "failed", "cancelled", "delivered"]

export interface JobRecord {
  id: string
  deviceId: string
  status: JobStatus
  createdAt: number
  updatedAt: number
  requestSize?: number
  resultSize?: number
  /** Non-sensitive failure code (e.g. "needs_full_bundle"). Details live in encrypted events. */
  errorCode?: string
}

export type EventKind =
  | "status" // host -> device: progress note
  | "question" // host -> device: agent needs input
  | "reply" // device -> host: answer to a question
  | "cancel" // device -> host: stop the job
  | "error" // host -> device: failure details
  | "result" // host -> device: result blob is ready

export interface RelayEvent {
  seq: number
  jobId: string
  deviceId: string
  /** Which side wrote the event. */
  from: "host" | "device"
  kind: EventKind
  /** base64url of an encrypted (sealed) JSON payload, or empty. */
  payload: string
  createdAt: number
}

export interface DeviceInfo {
  id: string
  name: string
  publicKey: string
  createdAt: number
  lastSeenAt?: number
}

// ---------- Encrypted payloads ----------

/** Header of the request container the plugin sends (encrypted to the host key). */
export interface RequestManifest {
  v: typeof PROTOCOL_VERSION
  jobId: string
  deviceId: string
  createdAt: number
  instructions: string
  repo: {
    /** Stable random id the device assigns per repository. */
    id: string
    name: string
    branch: string | null
    head: string | null
    /** Commit containing HEAD + all uncommitted (incl. untracked) changes. */
    snapshot: string
    /** Ref name inside the bundle that points at `snapshot`. */
    snapshotRef: string
    /** Commit the bundle is incremental against, if any. */
    base: string | null
    remotes: Record<string, string>
  }
  session: {
    id: string
    title: string | null
    directory: string
    /** Condensed markdown transcript of the opencode session. */
    transcript: string
  }
  options: {
    /** Lead model: a spec or a short name like "opus"; the host checks it against its allowed models. */
    model?: string
  }
}

/** Header of the result container the host returns (encrypted to the device key). */
export interface ResultManifest {
  v: typeof PROTOCOL_VERSION
  jobId: string
  outcome: "succeeded" | "failed"
  /** Branch inside the bundle holding the agent's commits (child of the snapshot). */
  branch: string
  /** Tip of `branch`, or null if no bundle (no commits). */
  head: string | null
  snapshot: string
  commits: Array<{ sha: string; subject: string }>
  diffstat: string
  summary: string
  t3: { projectId: string; threadId: string; threadTitle: string }
  /** Commit the host now has for this repo; future bundles can be incremental against it. */
  knownCommit: string | null
}

export interface StatusPayload {
  message: string
  threadId?: string
  /** Show this to the user now, not just in /handoff status. */
  announce?: boolean
}
export interface QuestionPayload {
  requestId: string
  threadId: string
  question: unknown
}
export interface ReplyPayload {
  requestId: string
  answers: Record<string, unknown>
}
export interface ErrorPayload {
  message: string
  code?: string
}

// ---------- HTTP API shapes ----------

export interface PairRequest {
  code: string
  name: string
  publicKey: string
}
export interface PairResponse {
  deviceId: string
  token: string
  hostPublicKey: string
}
export interface CreateJobRequest {
  id: string
}
export interface CreateJobResponse {
  job: JobRecord
}
export interface UploadedPart {
  partNumber: number
  etag: string
}
export interface CompleteUploadRequest {
  parts: UploadedPart[]
  size: number
}
export interface PostEventRequest {
  jobId: string
  kind: EventKind
  payload: string
}
export interface EventsResponse {
  events: RelayEvent[]
  /** Highest seq observed; pass back as `after`. */
  cursor: number
}

/** Blob part size. Must be >= 5 MiB (R2 multipart minimum) and well under the 100 MB request cap. */
export const PART_SIZE = 32 * 1024 * 1024
