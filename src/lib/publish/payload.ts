/**
 * The key graph: what a published story actually ships.
 *
 * A passage is encrypted under its own random content key, and that key is
 * wrapped once per *inbound link* under a key derived from the passage the link
 * comes from. So holding a passage's key lets you open the passages it links to
 * and nothing else, and to open anything at all you must have walked a real
 * route to it from the start. The reader gets `CK_start` in the clear; every
 * other key is earned by traversal.
 *
 * That guarantee is progressive, not absolute, and the difference matters
 * enough to write down. Everything needed to play is in the file, so anything a
 * player can do a script can do: a breadth-first walk over this same structure
 * dumps the whole story in seconds. What the scheme buys is that reading ahead
 * costs *writing a program* rather than pressing Ctrl+F — there is no
 * client-only scheme that buys more, and hardening the derivation would not
 * help, since a player pays per step taken while an attacker pays per edge
 * once. Do not describe this as encryption that keeps the story from a
 * determined reader. It keeps the story from a casual one.
 *
 * Keys are per *node*, wrapped per *edge*. Keying by route instead would be the
 * obvious reading of "a route's identity is a sequence of codes", and it would
 * be exponential — `paths.ts` counts routes as `BigInt` for a reason. Per node
 * is linear in edges and gives the property actually wanted: you need *some*
 * predecessor, which inductively means *some* full route from the start.
 */

import type { StoryDoc, StoryNode, NodeId } from '../../types/story'
import { deriveGraph, displayedSnippet } from '../graph/derive'
import { displayClosure } from '../harlowe/macros'
import type { DerivedGraph } from '../graph/types'
import type { PlayerTheme } from './themes'
import { reachableFrom } from '../graph/reachability'
import {
  contentAddr,
  contentKey,
  decrypt,
  decodeText,
  encodeText,
  encrypt,
  fromBase64,
  gunzip,
  gzip,
  randomKey,
  toBase64,
  wrapAddr,
  wrapKey,
} from './crypto'

/**
 * Ciphertext is padded to a multiple of this many bytes.
 *
 * Blob lengths are the one thing the store cannot hide — an attacker who cannot
 * read a passage can still see how big it is, and a story's longest passage is
 * usually its ending. Quantizing costs at most 255 bytes per passage and turns
 * a word count into a bucket.
 */
const PAD_TO = 256

/** Bytes of big-endian length prefix written ahead of the compressed envelope. */
const LENGTH_PREFIX = 4

/** What a passage carries into the published file. Nothing else survives. */
export interface Envelope {
  /** Passage title, cosmetic, shown above the prose. */
  t: string
  /** Harlowe source. The player evaluates this with `renderPassage`. */
  b: string
  /** Authored ending. Terminates the route; disables every choice. */
  e: boolean
  /**
   * The passage code, shown in the reader's meta row like a page number.
   *
   * Inside the envelope, not beside it: a code is the name every link targets,
   * so a list of them in the clear would hand over the story's shape.
   */
  c: string
  /** The author's mark, or `''`. The reader runs these together as the trail. */
  s: string
  /**
   * The snippets this passage displays, directly or through one another, as
   * `[code, body]` in code order. Absent when it displays none.
   *
   * Carried here rather than as blobs of their own, because a snippet is on no
   * route and so has no key a reader could earn: sealed with the prose that
   * shows it, it opens exactly when that prose does, and no code map ships in
   * the clear. A snippet shown by many passages is carried by each — the cost of
   * needing no second key graph.
   */
  d?: [string, string][]
}

/** The shuffled store, as it is embedded in the published page. */
export interface Payload {
  /** Story title, for the page's heading and `<title>`. */
  title: string
  /** `CK_start`, base64. In the clear by design — the guarantee is progressive. */
  start: string
  /** `[base64 address, base64 ciphertext]`, shuffled. */
  blobs: [string, string][]
  /** `[base64 address, base64 wrapped key]`, shuffled. */
  wraps: [string, string][]
  /** How the page is drawn until the reader picks otherwise. */
  theme: PlayerTheme
  /**
   * Show the author console. Set only by the editor's Play, never by Publish.
   *
   * In the clear, and harmless there: the console shows what the reader has
   * already opened (codes, variables, unread macros), so switching it on in a
   * hand-edited file reveals nothing a walk had not.
   */
  author?: true
  /** The session starts somewhere other than the story's first passage. */
  midStory?: true
  /**
   * A theme preview from the editor's settings. The player neither reads nor
   * writes the reader's saved theme for one, so a preview always shows the
   * theme it was opened for and a choice made inside it goes nowhere.
   */
  preview?: true
}

/** What `buildPayload` needs besides the document. */
export interface PayloadOptions {
  theme: PlayerTheme
  /**
   * Where reading begins. Defaults to the story's start passage. Play from here
   * passes the passage the author is looking at, and the payload then ships
   * everything reachable from *there*.
   */
  start?: NodeId | null
  author?: boolean
  preview?: boolean
}

/**
 * Passages that exist but will not ship, and why.
 *
 * `past-ending` is a passage the links reach only through an authored ending.
 * The player disables every choice on an ending, so no reader could open it,
 * and shipping it would be encrypted prose nobody can reach.
 */
export interface Excluded {
  node: StoryNode
  reason: 'unreachable' | 'past-ending'
}

/**
 * Which passages a reader can actually get to, and which are left behind.
 *
 * `reachableFrom` is the reader's question, not the route model's: it follows
 * self-loops and back edges, because a reader who circles back is still reading.
 * `paths.ts`'s `forwardTargets` answers a different question and would strand
 * passages the reader can plainly visit. It does stop at an authored ending,
 * because the player does.
 *
 * Anything left out is reported rather than silently dropped. A passage the
 * author wrote and cannot reach is usually a broken link, and finding that out
 * when someone else opens the demo is too late.
 *
 * `graph` is a parameter so a caller that has derived one already need not
 * derive a second.
 */
export function partitionNodes(
  doc: StoryDoc,
  start: NodeId | null = doc.startNodeId,
  graph: DerivedGraph = deriveGraph(doc),
): { shipped: StoryNode[]; excluded: Excluded[] } {
  // A snippet is neither: it ships inside the envelope of every passage that
  // displays it, so it is not left behind, and reporting it would tell the
  // author their snippets were lost.
  const nodes = doc.nodes.filter((node) => !node.isSnippet)
  if (start === null) {
    return { shipped: [], excluded: nodes.map((node) => ({ node, reason: 'unreachable' })) }
  }
  const endings = new Set(doc.nodes.filter((node) => node.isEnding).map((node) => node.id))
  const reader = reachableFrom(graph, start, endings)
  const linked = reachableFrom(graph, start)
  const shipped: StoryNode[] = []
  const excluded: Excluded[] = []
  for (const node of nodes) {
    if (reader.has(node.id)) shipped.push(node)
    else excluded.push({ node, reason: linked.has(node.id) ? 'past-ending' : 'unreachable' })
  }
  return { shipped, excluded }
}

export class PublishError extends Error {}

/**
 * The passage reading begins at, or a `PublishError` saying why there is none.
 *
 * Synchronous and separate so Play and Publish can both ask before anything
 * else happens: before a tab opens, and before a save dialog does. Worded for
 * both, because either can be the one asking.
 */
export function startOf(doc: StoryDoc, start: NodeId | null | undefined): NodeId {
  const id = start ?? doc.startNodeId
  if (id === null) {
    throw new PublishError('This story has no start passage yet. Mark one as the start to play or publish it.')
  }
  const node = doc.nodes.find((n) => n.id === id)
  if (node === undefined) {
    throw new PublishError('That passage no longer exists, so there is nothing to read.')
  }
  if (node.isSnippet) {
    throw new PublishError('A snippet is not on any route. Play from a passage that displays it.')
  }
  return id
}

/**
 * Build the key graph for `doc`. Throws if there is no passage to start from.
 *
 * Every passage and every link is sealed independently, so the WebCrypto and
 * gzip work runs concurrently rather than as several hundred round trips in a
 * row. Order is irrelevant: both lists are shuffled before they ship.
 */
export async function buildPayload(
  doc: StoryDoc,
  options: PayloadOptions,
  graph: DerivedGraph = deriveGraph(doc),
): Promise<Payload> {
  const start = startOf(doc, options.start)
  const { shipped } = partitionNodes(doc, start, graph)

  const keys = new Map<NodeId, Uint8Array>()
  for (const node of shipped) keys.set(node.id, randomKey())

  // Only a snippet may be displayed, resolved exactly as a link resolves. The
  // bodies come from `doc`, never the graph, which may predate a prose edit.
  const snippetBody = new Map<NodeId, string>()
  for (const node of doc.nodes) if (node.isSnippet) snippetBody.set(node.id, node.body)
  const resolve = (code: string): string | null => {
    const id = displayedSnippet(graph, code)
    return id === null ? null : (snippetBody.get(id) ?? null)
  }
  // Shared by every passage's closure, so each snippet is parsed once per publish.
  const displayMemo = new Map<string, (string | null)[]>()

  const blobs = await Promise.all(
    shipped.map(async (node): Promise<[string, string]> => {
      const key = keys.get(node.id)!
      const envelope: Envelope = {
        t: node.title,
        b: node.body,
        e: node.isEnding,
        c: node.code,
        s: node.slug,
      }
      const displays = displayClosure(node.body, resolve, displayMemo)
      if (displays.length > 0) envelope.d = displays
      const [addr, sealed] = await Promise.all([contentAddr(key), seal(envelope)])
      return [toBase64(addr), toBase64(await encrypt(await contentKey(key), sealed))]
    }),
  )

  const wrapped: Promise<[string, string]>[] = []
  for (const edge of graph.edges) {
    // Dangling edges are real entries in `graph.edges` whose target is a
    // phantom — an id with no passage and so no blob. Wrapping one would hand
    // the player a key that opens nothing, turning a choice the design wants
    // *disabled* into a crash. Their absence here is exactly how the player
    // learns the link is dangling, so this filter is the feature, not a guard.
    if (edge.dangling) continue
    const from = keys.get(edge.sourceId)
    const to = keys.get(edge.targetId)
    // Either end may be missing: an edge out of an unshipped passage, or one
    // out of an ending into a passage only that ending reaches. Neither is an
    // edge a reader can take, so neither is wrapped.
    if (from === undefined || to === undefined) continue
    wrapped.push(
      (async (): Promise<[string, string]> => {
        const [addr, wrapping] = await Promise.all([
          wrapAddr(from, edge.ordinal),
          wrapKey(from, edge.ordinal),
        ])
        return [toBase64(addr), toBase64(await encrypt(wrapping, to))]
      })(),
    )
  }
  const wraps = await Promise.all(wrapped)

  const payload: Payload = {
    title: doc.storyTitle,
    start: toBase64(keys.get(start)!),
    blobs: shuffle(blobs),
    wraps: shuffle(wraps),
    theme: options.theme,
  }
  if (options.author === true) payload.author = true
  if (options.preview === true) payload.preview = true
  if (start !== doc.startNodeId) payload.midStory = true
  return payload
}

/**
 * Envelope → the bytes that get encrypted.
 *
 * Compress *then* pad, never the other way round. Padding first and compressing
 * after would be worse than not padding at all: zeros compress to nothing, so
 * the output length would track the content length exactly while looking like
 * it had been hidden.
 */
async function seal(envelope: Envelope): Promise<Uint8Array> {
  const gz = await gzip(encodeText(JSON.stringify(envelope)))
  const total = LENGTH_PREFIX + gz.length
  const padded = new Uint8Array(Math.ceil(total / PAD_TO) * PAD_TO)
  new DataView(padded.buffer).setUint32(0, gz.length)
  padded.set(gz, LENGTH_PREFIX)
  return padded
}

/** The inverse of `seal`. Exported because the player is its only other caller. */
export async function unseal(padded: Uint8Array): Promise<Envelope> {
  const length = new DataView(padded.buffer, padded.byteOffset).getUint32(0)
  const gz = padded.subarray(LENGTH_PREFIX, LENGTH_PREFIX + length)
  return JSON.parse(decodeText(await gunzip(gz))) as Envelope
}

/**
 * Fisher-Yates over a crypto source.
 *
 * Insertion order is canonical node order, which is code order — so an
 * unshuffled store would hand back the numbering the author can see on their
 * own canvas, and with it the shape of the story. `Math.random` would do for
 * that, but the rest of this file is careful and a cheap shuffle in the middle
 * of it invites the question of why.
 */
function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Open one passage, given the key that reaches it.
 *
 * The builder's counterpart to the player's step, and the reason it lives here:
 * `publish.test.ts` walks a payload with these functions, so the test exercises
 * the real lookup rather than a second copy of it that could agree with a bug.
 */
export async function openPassage(
  payload: Lookup,
  key: Uint8Array,
): Promise<Envelope | null> {
  const blob = payload.blobs.get(toBase64(await contentAddr(key)))
  if (blob === undefined) return null
  try {
    return await unseal(await decrypt(await contentKey(key), fromBase64(blob)))
  } catch {
    return null
  }
}

/**
 * The key behind one link, or null when the link leads nowhere.
 *
 * Null is the dangling case and the player renders it as a disabled choice. It
 * needs no code map to reach that answer: a link with no wrap entry is a link
 * with no passage behind it.
 */
export async function followLink(
  payload: Lookup,
  key: Uint8Array,
  ordinal: number,
): Promise<Uint8Array | null> {
  const wrapped = payload.wraps.get(toBase64(await wrapAddr(key, ordinal)))
  if (wrapped === undefined) return null
  try {
    return await decrypt(await wrapKey(key, ordinal), fromBase64(wrapped))
  } catch {
    return null
  }
}

/** A payload indexed for lookup. Built once when the player starts. */
export interface Lookup {
  title: string
  start: Uint8Array
  blobs: Map<string, string>
  wraps: Map<string, string>
}

export function indexPayload(payload: Payload): Lookup {
  return {
    title: payload.title,
    start: fromBase64(payload.start),
    blobs: new Map(payload.blobs),
    wraps: new Map(payload.wraps),
  }
}
