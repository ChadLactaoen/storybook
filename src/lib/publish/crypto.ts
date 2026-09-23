/**
 * The primitives a published demo is built from, and the one place they live.
 *
 * Everything here is WebCrypto plus the streaming compression built into the
 * platform, so a published file carries no crypto library of its own. Both the
 * builder (in the editor) and the player (in the exported page) import this
 * module, which is the point: a scheme where encrypt and decrypt are described
 * twice is a scheme with two chances to disagree.
 *
 * The façade is deliberately thin and deliberately total. It exists so that
 * swapping the implementation is one file's work — `crypto.subtle` requires a
 * secure context, and while `file://` qualifies on current Chrome (verified:
 * `isSecureContext` is true and an HKDF + AES-GCM round trip succeeds), a
 * browser where it does not would need a pure-JS cipher underneath these same
 * six functions and nothing else would move.
 *
 * Key separation is by HKDF `info` string and nothing else. One 32-byte content
 * key per passage derives every value that passage needs — where its blob sits,
 * what opens it, and one wrapping key per outgoing link — so the player only
 * ever carries one secret per step. Reusing a raw key for two purposes is the
 * classic way to lose a scheme like this, so no caller is given the option: the
 * `info` strings are enumerated here, not passed in from outside.
 */

/** Bytes in a content key, and in every key derived from one. */
export const KEY_BYTES = 32

/** AES-GCM nonce length. 12 is the only size the spec recommends. */
const IV_BYTES = 12

/**
 * What a content key is used for. Each value is an HKDF `info` string, so two
 * purposes can never collide into the same derived key.
 *
 * `wrap` and `wrapAddr` take the link's ordinal, which is what makes a passage's
 * several outgoing links yield several distinct wrapping keys.
 */
const INFO = {
  /** Decrypts this passage's own blob. */
  content: () => 'content',
  /** Locates this passage's blob in the shuffled store. */
  addr: () => 'addr',
  /** Decrypts the content key of the passage this link leads to. */
  wrap: (ordinal: number) => `wrap:${ordinal}`,
  /** Locates that wrapped key in the shuffled store. */
  wrapAddr: (ordinal: number) => `wrapaddr:${ordinal}`,
} as const

const te = new TextEncoder()
const td = new TextDecoder()

/** A fresh content key. */
export function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES))
}

async function derive(key: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', bytes(key), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    // No salt. A salt would have to ship beside the ciphertext to be usable,
    // and since every content key is already 32 random bytes there is nothing
    // for it to add — HKDF's salt exists to spread out *low-entropy* input.
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) },
    base,
    KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

/**
 * Where this passage's blob sits in the store.
 *
 * Hashed rather than used raw so that the address reveals nothing about the key
 * that opens it. Addressing the store by a value only a key-holder can compute
 * is what hides the shape of the story: without the keys, the blob list and the
 * wrap list are both just shuffled piles of bytes, and which entry belongs to
 * which passage — or which edge to which parent — cannot be read off them.
 */
export async function contentAddr(key: Uint8Array): Promise<Uint8Array> {
  return sha256(await derive(key, INFO.addr()))
}

/** The key that opens this passage's blob. */
export async function contentKey(key: Uint8Array): Promise<Uint8Array> {
  return derive(key, INFO.content())
}

/** Where the key for the passage behind link `ordinal` sits. */
export async function wrapAddr(key: Uint8Array, ordinal: number): Promise<Uint8Array> {
  return sha256(await derive(key, INFO.wrapAddr(ordinal)))
}

/** The key that unwraps the content key behind link `ordinal`. */
export async function wrapKey(key: Uint8Array, ordinal: number): Promise<Uint8Array> {
  return derive(key, INFO.wrap(ordinal))
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(data)))
}

/**
 * AES-GCM, nonce prepended.
 *
 * The nonce travels with the ciphertext because every call here generates a
 * fresh one and nothing else would know it. GCM's tag comes along inside
 * `ciphertext`, so a wrong key fails loudly rather than returning noise — which
 * is what lets the player treat "cannot decrypt" as a real answer.
 */
export async function encrypt(key: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const k = await crypto.subtle.importKey('raw', bytes(key), 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, bytes(plain)))
  const out = new Uint8Array(IV_BYTES + ct.length)
  out.set(iv)
  out.set(ct, IV_BYTES)
  return out
}

/** Throws if the key is wrong or the bytes were tampered with. */
export async function decrypt(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', bytes(key), 'AES-GCM', false, ['decrypt'])
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes(blob.subarray(0, IV_BYTES)) },
    k,
    bytes(blob.subarray(IV_BYTES)),
  )
  return new Uint8Array(plain)
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('gzip'))
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('gzip'))
}

/**
 * Through a `Response` rather than `Blob.stream()`: every browser the player
 * supports has both, but jsdom's `Blob` has no `stream()`, and the player tests
 * run the real envelope code there.
 */
async function pipe(data: Uint8Array, through: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Response(bytes(data)).body!.pipeThrough(through)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * A `Uint8Array` the platform will accept.
 *
 * Under TypeScript's `ArrayBufferLike` typing a `Uint8Array` may be backed by a
 * `SharedArrayBuffer`, which the WebCrypto and Blob signatures refuse. Every
 * array this module produces is plain, so the cast asserts what is already
 * true rather than changing anything at runtime.
 */
function bytes(a: Uint8Array): Uint8Array<ArrayBuffer> {
  return a as Uint8Array<ArrayBuffer>
}

export function toBase64(data: Uint8Array): string {
  let s = ''
  // Chunked: `String.fromCharCode(...big)` overflows the argument limit, which
  // on a large story is a crash rather than a slow path.
  for (let i = 0; i < data.length; i += 0x8000) {
    s += String.fromCharCode(...data.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function encodeText(s: string): Uint8Array {
  return te.encode(s)
}

export function decodeText(data: Uint8Array): string {
  return td.decode(data)
}
