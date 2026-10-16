export type Bytes = Uint8Array<ArrayBuffer>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function utf8(text: string): Bytes {
  return encoder.encode(text) as Bytes
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export function b64url(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromB64url(text: string): Bytes {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function concat(parts: readonly Uint8Array[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length)
  // getRandomValues fills at most 65536 bytes per call.
  for (let i = 0; i < length; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536))
  return out
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? utf8(input) : (new Uint8Array(input) as Bytes)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data))
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** ULID: time-sortable, 26 chars, safe in URLs, refs, and file names. */
export function ulid(now = Date.now()): string {
  let time = ""
  let t = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  const rand = randomBytes(16)
  let tail = ""
  for (let i = 0; i < 16; i++) tail += CROCKFORD[rand[i]! % 32]
  return time + tail
}
