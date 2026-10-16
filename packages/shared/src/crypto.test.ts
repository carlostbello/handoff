import { describe, expect, it } from "vitest"
import { fingerprint, generateKeyPair, normalizeFingerprint, open, openJson, packContainer, seal, sealJson, unpackContainer } from "./crypto.js"
import { randomBytes, ulid } from "./encoding.js"

describe("crypto", () => {
  it("round-trips multi-chunk payloads", async () => {
    const [sender, recipient] = [await generateKeyPair(), await generateKeyPair()]
    const data = randomBytes(9 * 1024 * 1024 + 123)
    const sealed = await seal(data, recipient.publicKey, sender, "request:J1")
    const opened = await open(sealed, recipient, sender.publicKey, "request:J1")
    expect(opened.length).toBe(data.length)
    expect(Buffer.from(opened).equals(Buffer.from(data))).toBe(true)
  })

  it("round-trips empty payloads and JSON", async () => {
    const [sender, recipient] = [await generateKeyPair(), await generateKeyPair()]
    expect((await open(await seal(new Uint8Array(), recipient.publicKey, sender, "c"), recipient, sender.publicKey, "c")).length).toBe(0)
    expect(await openJson(await sealJson({ a: 1 }, recipient.publicKey, sender, "c"), recipient, sender.publicKey, "c")).toEqual({ a: 1 })
  })

  it("rejects truncation, tampering, and the wrong key", async () => {
    const [sender, recipient, other] = [await generateKeyPair(), await generateKeyPair(), await generateKeyPair()]
    const sealed = await seal(randomBytes(5 * 1024 * 1024), recipient.publicKey, sender, "c")
    const firstChunkEnd = 89 + 4 + 4 * 1024 * 1024 + 16
    await expect(open(sealed.subarray(0, firstChunkEnd), recipient, sender.publicKey, "c")).rejects.toThrow()
    const tampered = new Uint8Array(sealed)
    tampered[200] = tampered[200]! ^ 1
    await expect(open(tampered, recipient, sender.publicKey, "c")).rejects.toThrow()
    await expect(open(sealed, other, sender.publicKey, "c")).rejects.toThrow()
  })

  it("authenticates the sender and binds the context", async () => {
    const [sender, recipient, forger] = [await generateKeyPair(), await generateKeyPair(), await generateKeyPair()]
    // Someone who knows only the recipient's public key (e.g. a malicious relay) can't pass as the sender.
    const forged = await seal(new Uint8Array([1]), recipient.publicKey, forger, "request:J1")
    await expect(open(forged, recipient, sender.publicKey, "request:J1")).rejects.toThrow()
    // A genuine blob can't be replayed under another job or purpose.
    const genuine = await seal(new Uint8Array([1]), recipient.publicKey, sender, "request:J1")
    await expect(open(genuine, recipient, sender.publicKey, "request:J2")).rejects.toThrow()
    await expect(open(genuine, recipient, sender.publicKey, "result:J1")).rejects.toThrow()
  })

  it("makes stable, comparable fingerprints", async () => {
    const [a, b] = [await generateKeyPair(), await generateKeyPair()]
    const fa = await fingerprint(a.publicKey)
    expect(fa).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
    expect(await fingerprint(a.publicKey)).toBe(fa)
    expect(await fingerprint(b.publicKey)).not.toBe(fa)
    expect(normalizeFingerprint(fa.toLowerCase().replace(/-/g, " "))).toBe(fa)
  })

  it("packs containers", () => {
    const { header, payload } = unpackContainer<{ x: string }>(packContainer({ x: "y" }, new Uint8Array([1, 2, 3])))
    expect(header.x).toBe("y")
    expect([...payload]).toEqual([1, 2, 3])
  })

  it("makes sortable ulids", () => {
    const a = ulid(1000)
    const b = ulid(2000)
    expect(a < b).toBe(true)
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})
