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
})
