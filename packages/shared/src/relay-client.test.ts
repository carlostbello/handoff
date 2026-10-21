import { describe, expect, it } from "vitest"
import { DeviceClient, RelayError } from "./relay-client.js"

describe("relay client", () => {
  it("gives up on a request that never answers instead of hanging", async () => {
    let calls = 0
    // Like a connection that died mid-request: never responds, only honours the abort signal.
    const hang = ((_url: string, init: RequestInit) => {
      calls++
      return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
    }) as unknown as typeof fetch
    const client = new DeviceClient({ url: "http://relay.invalid", token: "t", fetch: hang, retries: 1, timeoutMs: 50 })
    const err = await client.events(0).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayError)
    expect((err as RelayError).retryable).toBe(true)
    expect(calls).toBe(2)
  })

  it("falls back to separate calls on a relay without /v1/sync, and remembers", async () => {
    const paths: string[] = []
    const fake = (async (url: string) => {
      const path = new URL(url).pathname
      paths.push(path)
      if (path === "/v1/sync") return new Response(JSON.stringify({ error: "not found" }), { status: 404 })
      if (path === "/v1/events") return Response.json({ events: [], cursor: 7 })
      return Response.json({ jobs: [{ id: "a", status: "done" }, { id: "b", status: "delivered" }] })
    }) as unknown as typeof fetch
    const client = new DeviceClient({ url: "http://relay.invalid", token: "t", fetch: fake, retries: 0 })
    expect(await client.sync(0)).toEqual({ events: [], cursor: 7, jobs: [{ id: "a", status: "done" }] })
    await client.sync(7)
    expect(paths.filter((p) => p === "/v1/sync")).toHaveLength(1)
  })
})
