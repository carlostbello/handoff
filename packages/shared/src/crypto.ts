// End-to-end encryption between the client and the host. The relay stores
// only ciphertext and is not trusted. Scheme (like HPKE auth mode):
// ECDH(eph, recipient) || ECDH(sender, recipient) -> HKDF-SHA256 -> AES-256-GCM,
// chunked so truncation and reordering are detected. Including the sender's
// static key authenticates the sender: only the holder of the sender's private
// key (or the recipient's) can produce a blob that opens. A context string
// (e.g. "request:<jobId>") binds each blob to its purpose so the relay can't
// replay it elsewhere.
//
// Sealed layout:
//   "HOF2" | ephPub (65 bytes, raw P-256) | salt (16) | chunkSize u32
//   then repeated: len u32 | ciphertext(len)   (len includes the 16-byte tag)
// Nonce per chunk = noncePrefix(4) || chunkIndex u64be. AAD = header || flag,
// where flag is 1 for the final chunk and 0 otherwise.

import { b64url, concat, fromB64url, randomBytes, utf8, fromUtf8, type Bytes } from "./encoding.js"

const MAGIC = utf8("HOF2")
const CHUNK_SIZE = 4 * 1024 * 1024
const EC = { name: "ECDH", namedCurve: "P-256" } as const

export interface KeyPair {
  /** base64url raw uncompressed P-256 public key */
  publicKey: string
  /** base64url PKCS#8 private key */
  privateKey: string
}

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)
  const priv = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer)
  return { publicKey: b64url(pub), privateKey: b64url(priv) }
}

async function importPublic(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, EC, true, [])
}

async function importPrivate(pkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", fromB64url(pkcs8), EC, false, ["deriveBits"])
}

async function dh(privateKey: CryptoKey, peerPublic: CryptoKey): Promise<Bytes> {
  // Cast: DOM and Workers type the ECDH params differently; the runtime shape is identical.
  const ecdh = { name: "ECDH", public: peerPublic } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0]
  return new Uint8Array(await crypto.subtle.deriveBits(ecdh, privateKey, 256))
}

async function deriveKey(
  shared: Bytes,
  salt: Bytes,
  ephPub: Bytes,
  senderPub: Bytes,
  recipientPub: Bytes,
  context: string,
): Promise<{ key: CryptoKey; prefix: Bytes }> {
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"])
  const info = concat([utf8("handoff/v2"), ephPub, senderPub, recipientPub, utf8(context)])
  const okm = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, ikm, 288),
  )
  const key = await crypto.subtle.importKey("raw", okm.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"])
  return { key, prefix: okm.slice(32, 36) }
}

function nonce(prefix: Bytes, index: number): Bytes {
  const out = new Uint8Array(12)
  out.set(prefix, 0)
  new DataView(out.buffer).setBigUint64(4, BigInt(index))
  return out
}

function u32(n: number): Bytes {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

/** Encrypt to `recipientPublicKey`, authenticated as `sender`, bound to `context`. */
export async function seal(plaintext: Uint8Array, recipientPublicKey: string, sender: KeyPair, context: string): Promise<Bytes> {
  const recipientRaw = fromB64url(recipientPublicKey)
  const recipient = await importPublic(recipientRaw)
  const eph = (await crypto.subtle.generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair
  const ephPub = new Uint8Array((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer)
  const salt = randomBytes(16)
  const shared = concat([await dh(eph.privateKey, recipient), await dh(await importPrivate(sender.privateKey), recipient)])
  const { key, prefix } = await deriveKey(shared, salt, ephPub, fromB64url(sender.publicKey), recipientRaw, context)
  const header = concat([MAGIC, ephPub, salt, u32(CHUNK_SIZE)])

  const out: Uint8Array[] = [header]
  const count = Math.max(1, Math.ceil(plaintext.length / CHUNK_SIZE))
  for (let i = 0; i < count; i++) {
    const chunk = plaintext.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
    const final = i === count - 1
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce(prefix, i), additionalData: concat([header, new Uint8Array([final ? 1 : 0])]) },
        key,
        new Uint8Array(chunk),
      ),
    )
    out.push(u32(ct.length), ct)
  }
  return concat(out)
}

/** Decrypt a blob sealed to `recipient`; fails unless it was sealed by `senderPublicKey` for `context`. */
export async function open(sealed: Uint8Array, recipient: KeyPair, senderPublicKey: string, context: string): Promise<Bytes> {
  if (sealed.length < 89 || fromUtf8(sealed.subarray(0, 4)) !== "HOF2") throw new Error("not a handoff sealed blob")
  const view = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength)
  const ephPub = new Uint8Array(sealed.subarray(4, 69))
  const salt = new Uint8Array(sealed.subarray(69, 85))
  const header = new Uint8Array(sealed.subarray(0, 89))
  const priv = await importPrivate(recipient.privateKey)
  const senderRaw = fromB64url(senderPublicKey)
  const shared = concat([await dh(priv, await importPublic(ephPub)), await dh(priv, await importPublic(senderRaw))])
  const { key, prefix } = await deriveKey(shared, salt, ephPub, senderRaw, fromB64url(recipient.publicKey), context)

  const out: Uint8Array[] = []
  let offset = 89
  let index = 0
  while (offset < sealed.length) {
    const len = view.getUint32(offset)
    offset += 4
    if (offset + len > sealed.length) throw new Error("sealed blob truncated")
    const ct = new Uint8Array(sealed.subarray(offset, offset + len))
    offset += len
    const final = offset === sealed.length
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce(prefix, index), additionalData: concat([header, new Uint8Array([final ? 1 : 0])]) },
      key,
      ct,
    )
    out.push(new Uint8Array(pt))
    index++
  }
  if (index === 0) throw new Error("sealed blob has no chunks")
  return concat(out)
}

export async function sealJson(value: unknown, recipientPublicKey: string, sender: KeyPair, context: string): Promise<string> {
  return b64url(await seal(utf8(JSON.stringify(value)), recipientPublicKey, sender, context))
}

export async function openJson<T>(payload: string, recipient: KeyPair, senderPublicKey: string, context: string): Promise<T> {
  return JSON.parse(fromUtf8(await open(fromB64url(payload), recipient, senderPublicKey, context))) as T
}

/** Context strings: each blob is bound to one job and one purpose. */
export const sealContext = {
  request: (jobId: string) => `request:${jobId}`,
  result: (jobId: string) => `result:${jobId}`,
  event: (kind: string, jobId: string) => `event:${kind}:${jobId}`,
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/**
 * Short human-comparable fingerprint of a public key: 80 bits of
 * SHA-256, as 16 Crockford base32 characters in groups of 4.
 */
export async function fingerprint(publicKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concat([utf8("handoff-key/v1"), fromB64url(publicKey)])))
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of digest.subarray(0, 10)) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out.match(/.{4}/g)!.join("-")
}

/** Accepts a fingerprint typed with any case, spacing, or dashes. */
export function normalizeFingerprint(input: string): string {
  const s = input.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1")
  return s.match(/.{1,4}/g)?.join("-") ?? ""
}

// ---------- Container: header JSON + binary payload ----------
// layout: headerLen u32 | header JSON | payload

export function packContainer(header: unknown, payload: Uint8Array = new Uint8Array()): Bytes {
  const json = utf8(JSON.stringify(header))
  return concat([u32(json.length), json, payload])
}

export function unpackContainer<T>(bytes: Uint8Array): { header: T; payload: Uint8Array } {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  const header = JSON.parse(fromUtf8(bytes.subarray(4, 4 + len))) as T
  return { header, payload: bytes.subarray(4 + len) }
}
