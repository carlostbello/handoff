// Runs against a live relay: `npx wrangler dev` with HOST_TOKEN in .dev.vars.
// Skipped unless RELAY_URL is set, e.g. RELAY_URL=http://localhost:8787 HOST_TOKEN=... npx vitest run relay
import { describe, expect, it } from "vitest"
import {
  DeviceClient,
  HostClient,
  generateKeyPair,
  open,
  openJson,
  randomBytes,
  seal,
  sealContext,
  sealJson,
  ulid,
  RelayError,
} from "@handoff/shared"

const url = process.env.RELAY_URL
// Local wrangler passes cf-connecting-ip through (Cloudflare overwrites it in production),
// so each run looks like a fresh client to the per-IP pairing limiter.
const ipHeaders = { "cf-connecting-ip": `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.1` }
const hostToken = process.env.HOST_TOKEN ?? ""

describe.skipIf(!url)("relay smoke", () => {
  it("runs a full job lifecycle", async () => {
    const host = new HostClient({ url: url!, token: hostToken, retries: 0 })
    const hostKeys = await generateKeyPair()
    await host.setHostKey(hostKeys.publicKey)

    // pairing: bad code rejected, good code works once
    const deviceKeys = await generateKeyPair()
    await expect(DeviceClient.pair({ url: url!, retries: 0, headers: ipHeaders }, { code: "AAAA-BBBB", name: "x", publicKey: deviceKeys.publicKey })).rejects.toThrow(/403/)
    const { code } = await host.createPairing()
    const paired = await DeviceClient.pair({ url: url!, retries: 0, headers: ipHeaders }, { code: code.toLowerCase(), name: "work-mac", publicKey: deviceKeys.publicKey })
    expect(paired.hostPublicKey).toBe(hostKeys.publicKey)
    await expect(DeviceClient.pair({ url: url!, retries: 0, headers: ipHeaders }, { code, name: "again", publicKey: deviceKeys.publicKey })).rejects.toThrow(/403/)

    const device = new DeviceClient({ url: url!, token: paired.token, retries: 0 })
    // device cannot use host routes
    await expect(new HostClient({ url: url!, token: paired.token, retries: 0 }).jobs()).rejects.toThrow(/404/)

    // device creates job + uploads a 40 MiB request (2 parts)
    const jobId = ulid()
    const job = await device.createJob(jobId)
    expect(job.status).toBe("uploading")
    expect((await device.createJob(jobId)).id).toBe(jobId) // idempotent
    const request = randomBytes(40 * 1024 * 1024)
    const sealedReq = await seal(request, hostKeys.publicKey, deviceKeys, sealContext.request(jobId))
    await device.uploadRequest(jobId, sealedReq)
    expect((await device.getJob(jobId)).status).toBe("queued")

    // host sees it, claims once
    const queued = await host.jobs("queued")
    expect(queued.map((j) => j.id)).toContain(jobId)
    expect(await host.claim(jobId)).not.toBeNull()
    expect(await host.claim(jobId)).toBeNull()
    const downloaded = await host.downloadRequest(jobId)
    const opened = await open(downloaded, hostKeys, deviceKeys.publicKey, sealContext.request(jobId))
    expect(Buffer.from(opened).equals(Buffer.from(request))).toBe(true)

    // progress events + reply round trip
    await host.setStatus(jobId, "running")
    await host.postEvent(jobId, "status", await sealJson({ message: "started" }, deviceKeys.publicKey, hostKeys, sealContext.event("status", jobId)))
    const ev = await device.events(0)
    expect(ev.events.at(-1)?.kind).toBe("status")
    expect((await openJson<{ message: string }>(ev.events.at(-1)!.payload, deviceKeys, hostKeys.publicKey, sealContext.event("status", jobId))).message).toBe("started")
    await device.postEvent(jobId, "reply", await sealJson({ requestId: "r", answers: {} }, hostKeys.publicKey, deviceKeys, sealContext.event("reply", jobId)))
    const sev = await host.events(0)
    expect(sev.events.some((e) => e.kind === "reply" && e.jobId === jobId)).toBe(true)
    await expect(device.postEvent(jobId, "status", "")).rejects.toThrow(/400/)

    // device can't fetch result early
    await expect(device.downloadResult(jobId)).rejects.toThrow(/409/)

    // host uploads result -> done + result event
    const result = randomBytes(1000)
    await host.uploadResult(jobId, await seal(result, deviceKeys.publicKey, hostKeys, sealContext.result(jobId)))
    expect((await device.getJob(jobId)).status).toBe("done")
    const ev2 = await device.events(ev.cursor)
    expect(ev2.events.map((e) => e.kind)).toContain("result")
    const res = await open(await device.downloadResult(jobId), deviceKeys, hostKeys.publicKey, sealContext.result(jobId))
    expect(Buffer.from(res).equals(Buffer.from(result))).toBe(true)

    await device.ack(jobId)
    expect((await device.getJob(jobId)).status).toBe("delivered")
    await expect(device.downloadResult(jobId)).rejects.toThrow(/404/)

    // revoke
    await host.revokeDevice(paired.deviceId)
    await expect(device.listJobs()).rejects.toSatisfy((e: unknown) => e instanceof RelayError && e.status === 401)
  }, 60_000)

  it("pushes job notifications over the websocket", async () => {
    const host = new HostClient({ url: url!, token: hostToken, retries: 0 })
    const keys = await generateKeyPair()
    await host.setHostKey(keys.publicKey)
    const ws = new WebSocket(await host.socketUrl())
    const messages: string[] = []
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (m) => {
        messages.push(String(m.data))
        resolve()
      }
      ws.onerror = () => reject(new Error("socket error"))
    })
    const { code } = await host.createPairing()
    const dk = await generateKeyPair()
    const paired = await DeviceClient.pair({ url: url!, headers: ipHeaders }, { code, name: "ws", publicKey: dk.publicKey })
    const device = new DeviceClient({ url: url!, token: paired.token })
    const jobId = ulid()
    await device.createJob(jobId)
    await device.uploadRequest(jobId, await seal(new Uint8Array([1]), keys.publicKey, dk, sealContext.request(jobId)))
    await new Promise((r) => setTimeout(r, 300))
    ws.close()
    expect(messages.some((m) => m.includes(jobId))).toBe(true)
    // ticket is single use
    const ticketUrl = await host.socketUrl()
    const first = new WebSocket(ticketUrl)
    await new Promise((r) => (first.onopen = r))
    first.close()
    const second = new WebSocket(ticketUrl)
    const failed = await new Promise<boolean>((r) => {
      second.onopen = () => r(false)
      second.onerror = () => r(true)
    })
    expect(failed).toBe(true)
  }, 30_000)
})
