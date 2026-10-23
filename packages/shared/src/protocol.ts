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
  /** What the user typed, verbatim. The host reads model names from this. */
  instructions: string
  /** Written by the client's model from the session; absent if it couldn't write one. */
  brief?: HandoffBrief
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
  /**
   * Extra material the brief asked for (other branches, commits, repositories). Their bundles
   * follow the snapshot bundle in the payload, in this order; the snapshot bundle is what's left.
   */
  inputs?: InputBatch
  /** Untracked files left out of the snapshot because they look like secrets. */
  skipped?: string[]
}

// ---------- Inputs: more material from the client ----------

/**
 * Something the host agent (or the client's brief) asks the client to send: a branch or
 * commit of the handoff's repository, or files from another repository or folder.
 */
export interface InputSpec {
  /** Short lowercase-hyphenated name; the delivered input is filed under it on the host. */
  name: string
  /** Repository or folder on the client; omitted means the handoff's repository. */
  repo?: string
  /** Branch, tag, remote branch or commit; omitted means the current files. */
  ref?: string
  /** Only these paths, relative to the repository; omitted means everything. */
  paths?: string[]
  /** "source" (default): the files at `ref`, as one commit without history. "history": `ref` with its commits. */
  mode?: "source" | "history"
  /** Why it's needed; shown to the user when they're asked to approve. */
  reason?: string
}

export interface DeliveredInput {
  name: string
  /** Where it came from, as the client describes it (a path on the client). */
  repo: string
  /** What was asked for and what it resolved to. */
  ref: string | null
  sourceCommit: string | null
  paths: string[]
  mode: "source" | "history"
  /** The delivered commit: for "source", a new parentless commit of the selected files. */
  commit: string
  tree: string
  /** Ref inside this input's bundle that points at `commit`. */
  bundleRef: string
  /** Bytes of this input's bundle in the payload, and their SHA-256. */
  size: number
  sha256: string
  /** Files left out because they look like secrets (.env, keys, credentials). */
  skipped: string[]
  /** "policy": allowed by the client's sharing settings. "user": the user approved it. */
  approvedBy: "policy" | "user"
}

export interface RefusedInput {
  name: string
  reason: string
}

export interface InputBatch {
  delivered: DeliveredInput[]
  refused: RefusedInput[]
}

/** Host -> device, sent as a "question" event: the agent asks the client for inputs. */
export interface InputRequestPayload {
  type: "inputs"
  requestId: string
  threadId?: string
  inputs: InputSpec[]
  /** Anything else the agent said about what it needs. */
  note?: string
}

/**
 * Device -> host, sent as a "reply" event on the handoff: inputs are on their way in a
 * separate relay job, `deliveryJobId`, whose request is an InputsManifest.
 */
export interface DeliveryNotice {
  type: "inputs"
  deliveryJobId: string
}

/** Header of a delivery's request container. Bundles follow in `delivered` order. */
export interface InputsManifest extends InputBatch {
  v: typeof PROTOCOL_VERSION
  kind: "inputs"
  jobId: string
  deviceId: string
  /** The handoff the inputs are for. */
  parentJobId: string
  /** The agent's request this answers; absent when the client sent them on its own. */
  requestId?: string
  /** A note for the host agent from the client's agent or user. */
  message?: string
}

/** Header of a delivery's result: the host's receipt. */
export interface InputsReceipt {
  v: typeof PROTOCOL_VERSION
  kind: "inputs-receipt"
  jobId: string
  parentJobId: string
  imported: string[]
}

/** A task brief the client's model writes from the session before handing off. */
export interface HandoffBrief {
  /** Short imperative title, e.g. "Add retry logic to the uploader". */
  title: string
  /** Few-word kebab-case name for the branch. */
  slug: string
  /** Human-friendly name for the repository's project on the host, e.g. "Recipe Planner". */
  projectName: string
  /** Self-contained markdown brief: goal, context, remaining work, constraints, done-when. */
  task: string
  /**
   * How much of the prior session the host agent should get:
   * "full": read the transcript; "reference": the brief is enough, transcript on hand if needed;
   * "none": the user wants a fresh start, so don't pass the transcript at all.
   */
  context: "full" | "reference" | "none"
  /** Repository-relative files the agent should read first. */
  files: string[]
  /** Material beyond the checkout the work depends on; the client packages and sends it. */
  inputs?: InputSpec[]
}

/** Header of the result container the host returns (encrypted to the device key). */
export interface ResultManifest {
  v: typeof PROTOCOL_VERSION
  jobId: string
  /**
   * "handoff": the answer to a request the device sent.
   * "host": an update the host sent on its own, after more work happened in the
   * conversation's T3 thread (e.g. the user replied to the agent in T3 Code).
   */
  origin: "handoff" | "host"
  /** The opencode session this conversation belongs to. */
  sessionId: string
  /** For "host" updates: the device's earlier job in this conversation. */
  parentJobId?: string
  /** For "host" updates: the latest message the user sent the agent in T3, if any. */
  request?: string
  /** "blocked": the agent stopped because it lacks something only the client can provide. */
  outcome: "succeeded" | "failed" | "blocked"
  /** For "blocked": what the agent says it needs. */
  missing?: string
  /** Branch inside the bundle holding the agent's commits (child of the snapshot). */
  branch: string
  /** Tip of `branch`, or null if no bundle (no commits). */
  head: string | null
  /** The commit this result builds on: the request's snapshot, or for updates the last commit delivered. */
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
  /** After a result was delivered: whether the T3 thread is working again (busy) or has stopped (idle). */
  activity?: "busy" | "idle"
}
export interface QuestionPayload {
  type?: undefined
  requestId: string
  threadId: string
  question: unknown
}
export interface ReplyPayload {
  type?: undefined
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
