import type { CompleteUploadRequest, JobStatus, PairRequest, PostEventRequest } from "@handoff/shared"
import { Hub, HttpError, type Env, type Principal } from "./hub.js"

export { Hub }

type HubStub = DurableObjectStub<Hub>

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    throw new HttpError(400, "invalid JSON body")
  }
}

function blobKey(jobId: string, kind: "request" | "result") {
  return `jobs/${jobId}/${kind}`
}

async function uploadPart(
  env: Env,
  hub: HubStub,
  principal: Principal,
  jobId: string,
  kind: "request" | "result",
  partNumber: number,
  request: Request,
): Promise<Response> {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new HttpError(400, "bad part number")
  const length = Number(request.headers.get("content-length"))
  if (!request.body || !Number.isFinite(length) || length <= 0) throw new HttpError(411, "content-length required")

  const { uploadId, allowed } = await hub.uploadIdFor(principal, jobId, kind)
  if (!allowed) throw new HttpError(409, `cannot upload ${kind} for this job now`)
  const key = blobKey(jobId, kind)
  let upload: R2MultipartUpload
  if (uploadId) {
    upload = env.BLOBS.resumeMultipartUpload(key, uploadId)
  } else {
    upload = await env.BLOBS.createMultipartUpload(key)
    await hub.recordUploadId(jobId, kind, upload.uploadId)
  }
  const stream = request.body.pipeThrough(new FixedLengthStream(length))
  const part = await upload.uploadPart(partNumber, stream)
  return json({ partNumber: part.partNumber, etag: part.etag })
}

async function completeUpload(
  env: Env,
  hub: HubStub,
  principal: Principal,
  jobId: string,
  kind: "request" | "result",
  request: Request,
): Promise<Response> {
  const { parts, size } = await body<CompleteUploadRequest>(request)
  const { uploadId, allowed } = await hub.uploadIdFor(principal, jobId, kind)
  if (!allowed || !uploadId) throw new HttpError(409, "no upload in progress")
  const upload = env.BLOBS.resumeMultipartUpload(blobKey(jobId, kind), uploadId)
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber)
  const object = await upload.complete(sorted)
  if (object.size !== size) throw new HttpError(400, `size mismatch: stored ${object.size}, expected ${size}`)
  return json(await hub.completeUpload(principal, jobId, kind, size))
}

async function download(env: Env, jobId: string, kind: "request" | "result"): Promise<Response> {
  const object = await env.BLOBS.get(blobKey(jobId, kind))
  if (!object) throw new HttpError(404, `${kind} blob not found`)
  return new Response(object.body, {
    headers: { "content-type": "application/octet-stream", "content-length": String(object.size) },
  })
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, "")
  const method = request.method
  const hub = env.HUB.get(env.HUB.idFromName("hub"))

  // ----- public -----
  if (method === "GET" && path === "/v1/health") {
    return json({ ok: true, hostKey: (await hub.hostKey()) !== null })
  }
  if (method === "POST" && path === "/v1/pair") {
    const req = await body<PairRequest>(request)
    if (!req.code || !req.publicKey || !req.name) throw new HttpError(400, "code, name, publicKey required")
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown"
    return json(await hub.pair(req.code, req.name, req.publicKey, ip))
  }
  if (method === "GET" && path === "/v1/host/socket") {
    // Authenticated by single-use ticket inside the Durable Object.
    return hub.fetch(request)
  }

  // ----- authenticated -----
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
  const principal = await hub.authenticate(token)
  if (!principal) throw new HttpError(401, "unauthorized")

  let m: RegExpMatchArray | null

  if (principal.role === "device") {
    const deviceId = principal.deviceId
    if (method === "POST" && path === "/v1/jobs") {
      const { id } = await body<{ id: string }>(request)
      return json({ job: await hub.createJob(deviceId, id) })
    }
    if (method === "GET" && path === "/v1/jobs") return json({ jobs: await hub.listJobs(principal) })
    if ((m = path.match(/^\/v1\/jobs\/([^/]+)$/)) && method === "GET") return json(await hub.getJob(principal, m[1]!))
    if ((m = path.match(/^\/v1\/jobs\/([^/]+)\/request\/parts\/(\d+)$/)) && method === "PUT") {
      return uploadPart(env, hub, principal, m[1]!, "request", Number(m[2]), request)
    }
    if ((m = path.match(/^\/v1\/jobs\/([^/]+)\/request\/complete$/)) && method === "POST") {
      return completeUpload(env, hub, principal, m[1]!, "request", request)
    }
    if ((m = path.match(/^\/v1\/jobs\/([^/]+)\/result$/)) && method === "GET") {
      const job = await hub.getJob(principal, m[1]!)
      if (job.status !== "done" && job.status !== "delivered") throw new HttpError(409, `job is ${job.status}`)
      return download(env, m[1]!, "result")
    }
    if ((m = path.match(/^\/v1\/jobs\/([^/]+)\/ack$/)) && method === "POST") {
      const keys = await hub.ack(deviceId, m[1]!)
      await env.BLOBS.delete(keys)
      return json({ ok: true })
    }
    if (method === "GET" && path === "/v1/events") {
      return json(await hub.events(principal, Number(url.searchParams.get("after") ?? 0)))
    }
    if (method === "POST" && path === "/v1/events") {
      const ev = await body<PostEventRequest>(request)
      await hub.postEvent(principal, ev.jobId, ev.kind, ev.payload ?? "")
      return json({ ok: true })
    }
    throw new HttpError(404, "not found")
  }

  // host
  if (method === "PUT" && path === "/v1/host/key") {
    const { publicKey } = await body<{ publicKey: string }>(request)
    if (!publicKey) throw new HttpError(400, "publicKey required")
    await hub.setHostKey(publicKey)
    return json({ ok: true })
  }
  if (method === "POST" && path === "/v1/host/pairings") return json(await hub.createPairing())
  if (method === "POST" && path === "/v1/host/socket-ticket") return json({ ticket: await hub.createSocketTicket() })
  if (method === "GET" && path === "/v1/host/devices") return json({ devices: await hub.devices() })
  if ((m = path.match(/^\/v1\/host\/devices\/([^/]+)$/)) && method === "DELETE") {
    await hub.revokeDevice(m[1]!)
    return json({ ok: true })
  }
  if (method === "GET" && path === "/v1/host/jobs") {
    const status = (url.searchParams.get("status") as JobStatus | null) ?? undefined
    return json({ jobs: await hub.listJobs(principal, status) })
  }
  if ((m = path.match(/^\/v1\/host\/jobs\/([^/]+)\/claim$/)) && method === "POST") return json(await hub.claim(m[1]!))
  if ((m = path.match(/^\/v1\/host\/jobs\/([^/]+)\/request$/)) && method === "GET") return download(env, m[1]!, "request")
  if ((m = path.match(/^\/v1\/host\/jobs\/([^/]+)\/status$/)) && method === "POST") {
    const { status, errorCode } = await body<{ status: JobStatus; errorCode?: string }>(request)
    return json(await hub.setStatus(m[1]!, status, errorCode))
  }
  if ((m = path.match(/^\/v1\/host\/jobs\/([^/]+)\/result\/parts\/(\d+)$/)) && method === "PUT") {
    return uploadPart(env, hub, principal, m[1]!, "result", Number(m[2]), request)
  }
  if ((m = path.match(/^\/v1\/host\/jobs\/([^/]+)\/result\/complete$/)) && method === "POST") {
    return completeUpload(env, hub, principal, m[1]!, "result", request)
  }
  if (method === "GET" && path === "/v1/host/events") {
    return json(await hub.events(principal, Number(url.searchParams.get("after") ?? 0)))
  }
  if (method === "POST" && path === "/v1/host/events") {
    const ev = await body<PostEventRequest>(request)
    await hub.postEvent(principal, ev.jobId, ev.kind, ev.payload ?? "")
    return json({ ok: true })
  }
  throw new HttpError(404, "not found")
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (err) {
      // Errors thrown inside the Durable Object lose their class over RPC; recover status from the message.
      if (err instanceof HttpError) return json({ error: err.detail, code: err.code }, err.status)
      const message = (err as Error).message ?? String(err)
      const m = message.match(/^HTTP (\d{3}): (.*)$/s)
      if (m) return json({ error: m[2] }, Number(m[1]))
      console.error(err)
      return json({ error: "internal error" }, 500)
    }
  },
} satisfies ExportedHandler<Env>
