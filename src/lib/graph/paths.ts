import type { NodeId } from '../../types/story'
import type { DerivedGraph, EdgeId } from './types'

/** No passage marked as an ending — the shape every call had before endings existed. */
export const NO_ENDINGS: ReadonlySet<NodeId> = new Set()

/** Nothing blocked: what `countPaths` asks, and a shared empty set so the
 *  per-passage loop in `stats.ts` does not allocate one per call. */
export const NO_BLOCKED: ReadonlySet<NodeId> = new Set()

/**
 * The passages a route can reach in one step from `id`.
 *
 * The one definition of a forward edge, because there were six: a self-loop
 * goes nowhere, a back edge is the loop the DAG broke so the walk can
 * terminate, and nothing leaves a passage the author marked as an ending. Two
 * of those copies had already drifted by the time this was written — the lint
 * disagreed with the counters about back edges, and told the author a passage
 * that plainly links to a hub was a dead end.
 *
 * Leaving `endings` empty asks the neighbouring question — what does this
 * passage link to, *ignoring* the ending cutoff — which is what the lint that
 * reports an ending with links still leaving it needs.
 */
export function forwardTargets(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  id: NodeId,
  endings: ReadonlySet<NodeId> = NO_ENDINGS,
): NodeId[] {
  if (endings.has(id)) return []
  const out: NodeId[] = []
  for (const eid of g.outAdj.get(id) ?? []) {
    const e = g.edgeById.get(eid)!
    if (e.selfLoop || backEdges.has(eid)) continue
    out.push(e.targetId)
  }
  return out
}

/**
 * How many links the author wrote out of, and into, `id`.
 *
 * The *other* question from `forwardTargets` — every `[[...]]` as written, self
 * loops, back edges and links out of an Ending included. It is one expression,
 * which is exactly why it belongs here: this predicate was hand-written in six
 * places once and two copies had drifted, and reading an authored question off
 * the route model is what made the tool state something false about the prose.
 * One home for each question, so the inspector's tile and the stats panel's
 * lint cannot disagree.
 */
export function authoredOut(g: DerivedGraph, id: NodeId): number {
  // A link to a snippet is no edge, but the author still wrote it — the same
  // reason a back edge counts here. Rare by construction (each is a lint row),
  // so a scan costs nothing.
  let snippetLinks = 0
  for (const l of g.snippetLinks) if (l.sourceId === id) snippetLinks++
  return (g.outAdj.get(id) ?? []).length + snippetLinks
}

export function authoredIn(g: DerivedGraph, id: NodeId): number {
  let snippetLinks = 0
  for (const l of g.snippetLinks) if (l.kind === 'to' && g.idByCode.get(l.targetCode) === id) snippetLinks++
  return (g.inAdj.get(id) ?? []).length + snippetLinks
}

/**
 * The mirror of `forwardTargets`: the passages a route can arrive from.
 *
 * The asymmetry is deliberate. Forwards, an ending stops the walk at itself;
 * backwards, it stops the walk at the *source*, because nothing arrives through
 * a passage routes already stopped at. Keeping both here is what makes the two
 * directions agree, which is what makes the endings sum to the total.
 */
export function backwardSources(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  id: NodeId,
  endings: ReadonlySet<NodeId> = NO_ENDINGS,
): NodeId[] {
  const out: NodeId[] = []
  for (const eid of g.inAdj.get(id) ?? []) {
    const e = g.edgeById.get(eid)!
    if (e.selfLoop || backEdges.has(eid)) continue
    if (endings.has(e.sourceId)) continue
    out.push(e.sourceId)
  }
  return out
}

/**
 * Count distinct story paths from `startId` down to any ending.
 *
 *   paths(n) = 1 when n ends a route, else the sum over children.
 *
 * A route ends either because the author said so — `n` is in `endings` — or
 * because nothing links out of `n`. The authored case wins and is checked
 * first, so a passage marked as an ending stops the walk even when links still
 * leave it. That is what makes the endings a partition of the routes rather
 * than an overlapping tally, and it is why anything past a marked ending is
 * unreachable; `stats.ts` reports that as stranded.
 *
 * `endings` defaults to empty, so every call written before endings existed
 * still means exactly what it meant, and a story with nothing marked counts
 * exactly as it always did.
 *
 * BigInt because the count is exponential in practice — a story with 40 binary
 * choices overflows a double long before it overflows the author's patience.
 * Back edges are excluded, so the traversal terminates.
 */
export function countPaths(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  startId: NodeId,
  endings: ReadonlySet<NodeId> = NO_ENDINGS,
): bigint {
  // The no-passages-blocked case of `countPathsAvoiding`, the way `countPathsTo`
  // is the one-passage case of `countPathsToAll`: the recurrence lives in one
  // place, so the plain count and the avoiding one cannot drift apart.
  return forwardCounter(g, backEdges, endings, NO_BLOCKED)(startId)
}

/**
 * Count distinct story paths from `startId` that never enter a blocked passage.
 *
 * The complement is the point. "How many routes pass through at least one
 * passage tagged `combat`" cannot be answered by summing over the tagged
 * passages the way the endings table sums over endings: a route stops at
 * exactly one ending, so endings partition the routes, but a route may collect
 * the same tag three times and would be counted three times. Blocking them all
 * and subtracting counts each route once, by construction:
 *
 *   touching(T) = countPaths(start) - countPathsAvoiding(start, passages tagged T)
 *
 * A null `startId` counts zero rather than one, the same answer `countPathsTo`
 * gives: a story with no start has no routes, and walking an id the graph does
 * not hold would otherwise report it as a terminal worth a route.
 */
export function countPathsAvoiding(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  startId: NodeId | null,
  blocked: ReadonlySet<NodeId>,
  endings: ReadonlySet<NodeId> = NO_ENDINGS,
): bigint {
  if (startId === null) return 0n
  return forwardCounter(g, backEdges, endings, blocked)(startId)
}

/**
 * The shared recurrence behind both counters above.
 *
 * Two orderings in here are load-bearing, and both state something false if
 * they are swapped or tidied:
 *
 * - **`blocked` is checked before `endings`.** A passage can be both marked as
 *   an ending and carry the tag being asked about. Checked the other way it
 *   returns `1n` as an ending before anyone notices it is blocked, so the
 *   routes that stop there get counted as avoiding the very tag they end on.
 * - **`kids` is never filtered.** The block check returns `0n` at the top of
 *   the walk; it does not prune children on the way out. Filtering them instead
 *   would leave a passage whose every successor is blocked with no kids at all,
 *   and `kids.length === 0` means *one route ends here* — inventing a route
 *   that stops in the middle of the story.
 *
 * A counter is only sound for the `(endings, blocked)` pair it closed over, so
 * each question gets its own. Sharing one memo across different blocked sets
 * would make every number it produced arbitrary.
 */
function forwardCounter(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  endings: ReadonlySet<NodeId>,
  blocked: ReadonlySet<NodeId>,
): (id: NodeId) => bigint {
  const memo = new Map<NodeId, bigint>()
  const visiting = new Set<NodeId>()

  const walk = (id: NodeId): bigint => {
    // Before the memo as well as before the endings check: a blocked passage is
    // a constant zero, and keeping it out of the memo keeps the memo about the
    // graph rather than about the question.
    if (blocked.has(id)) return 0n
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0n
    // Before the out-edges, not after: an ending with links still leaving it
    // is one route, not the sum of what follows.
    if (endings.has(id)) return 1n
    visiting.add(id)

    const kids = forwardTargets(g, backEdges, id, endings)
    let total = 0n
    for (const k of kids) total += walk(k)

    const result = kids.length === 0 ? 1n : total
    visiting.delete(id)
    memo.set(id, result)
    return result
  }

  return walk
}

/**
 * Count routes from `startId` by **how many** marked passages they pass
 * through: a histogram where `[j]` is the routes collecting exactly `j`, and
 * the last entry is `cap` *or more*.
 *
 * The complement trick behind `countPathsAvoiding` answers "any" and "none" and
 * stops there — one `bigint` per passage cannot say how often. This carries a
 * vector instead, which is the whole difference: `h(n)[j]` is the routes from
 * `n` down to a terminal whose suffix, `n` included, collects exactly `j`
 * marks.
 *
 * Unlike the tag counts built on `countPathsAvoiding`, these buckets *are* a
 * partition — a route collects the tag exactly one number of times — so
 * `sum(countPathsByHits(...)) === countPaths(...)`, and `[0]` is exactly
 * `countPathsAvoiding(..., marked, ...)`. Both are asserted in `tags.test.ts`,
 * because two counters that disagree about the same story would be worse than
 * either.
 *
 * Saturating at `cap` rather than growing the vector to the longest route keeps
 * the arithmetic bounded by the question an author asks — "once, twice, or a
 * lot" — instead of by the depth of the story.
 *
 * A null `startId` counts nothing at all, the way `countPathsAvoiding` does.
 */
export function countPathsByHits(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  startId: NodeId | null,
  marked: ReadonlySet<NodeId>,
  cap: number,
  endings: ReadonlySet<NodeId> = NO_ENDINGS,
): bigint[] {
  // A cap below one has no bucket to saturate into: `[0]` would mean "zero or
  // more", which is every route, and the identity above would quietly state
  // the opposite of what it says. Nothing asks for that today, so refuse it
  // rather than return a histogram that means something else.
  if (cap < 1) throw new Error(`countPathsByHits: cap must be at least 1, got ${cap}`)
  if (startId === null) return new Array<bigint>(cap + 1).fill(0n)
  return forwardHistogram(g, backEdges, endings, marked, cap)(startId)
}

/**
 * The recurrence behind `countPathsByHits`, shaped like `forwardCounter` above
 * and load-bearing in the same two places:
 *
 * - **The mark is applied after the terminal case, never before it.** A passage
 *   can be both a marked ending and carry the tag being asked about; the route
 *   that stops there has collected it, so the answer is one route at `j = 1`,
 *   not one at `j = 0`. This is the counterpart of `blocked` being checked
 *   before `endings` in `forwardCounter`, and it fails the same way — quietly,
 *   by filing routes under a count they do not have.
 * - **`kids` is never filtered**, for the reason written there: `kids.length
 *   === 0` means *a route ends here*.
 *
 * Every vector is built fresh and the memoized one is never written through, so
 * a shifted result cannot reach back into the table it was read from. The memo
 * is sound only for the `(endings, marked, cap)` question it closed over, so
 * each question gets its own counter.
 */
function forwardHistogram(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  endings: ReadonlySet<NodeId>,
  marked: ReadonlySet<NodeId>,
  cap: number,
): (id: NodeId) => bigint[] {
  const memo = new Map<NodeId, bigint[]>()
  const visiting = new Set<NodeId>()

  /** One route, having collected nothing yet — the terminal case. */
  const one = (): bigint[] => {
    const v = new Array<bigint>(cap + 1).fill(0n)
    v[0] = 1n
    return v
  }

  const walk = (id: NodeId): bigint[] => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return new Array<bigint>(cap + 1).fill(0n)

    let here: bigint[]
    if (endings.has(id)) {
      // Before the out-edges, as in `forwardCounter`: an ending with links
      // still leaving it is one route, not the sum of what follows.
      here = one()
    } else {
      visiting.add(id)
      const kids = forwardTargets(g, backEdges, id, endings)
      if (kids.length === 0) {
        here = one()
      } else {
        here = new Array<bigint>(cap + 1).fill(0n)
        for (const k of kids) {
          const sub = walk(k)
          for (let j = 0; j <= cap; j += 1) here[j] = here[j]! + sub[j]!
        }
      }
      visiting.delete(id)
    }

    if (marked.has(id)) {
      const shifted = new Array<bigint>(cap + 1).fill(0n)
      for (let j = 0; j <= cap; j += 1) {
        const to = Math.min(j + 1, cap)
        shifted[to] = shifted[to]! + here[j]!
      }
      here = shifted
    }

    memo.set(id, here)
    return here
  }

  return walk
}

/**
 * Count distinct story paths that run from `startId` down to `targetId` — the
 * mirror of `countPaths`, walking in-edges instead of out.
 *
 * Two things differ from simply reversing the arrows:
 *
 * - The base case is `id === startId ? 1n : 0n`, **not** "no in-edges means
 *   one". A passage nothing links to is not a route the reader can take; it is
 *   a passage no reader reaches, and it must count zero.
 * - An in-edge whose source is a marked ending carries nothing, because routes
 *   stop at that source. This is the same rule `countPaths` applies from the
 *   other side, and keeping the two in step is what makes the endings sum to
 *   the total.
 */
export function countPathsTo(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  targetId: NodeId,
  startId: NodeId | null,
  endings: ReadonlySet<NodeId> = NO_ENDINGS,
): bigint {
  // The one-entry case of `countPathsToAll`, the way `retargetLinks` is the
  // one-entry case of `remapLinks`: the recurrence lives in one place, so the
  // single-passage question and the whole-story one cannot drift apart.
  if (startId === null) return 0n
  return reverseCounter(g, backEdges, startId, endings)(targetId)
}

/**
 * `countPathsTo` for every passage at once, sharing a single memo.
 *
 * Asking per passage costs a full walk each time — O(V) walks of O(V+E) — which
 * is what the story stats did, and what a per-level share in the inspector would
 * do on every keystroke. One shared memo answers the whole story in one pass.
 *
 * Ids are visited in `g.ids` order, which is canonical, so the map is built the
 * same way every time. That matters beyond tidiness: the cycle guard below
 * returns `0n` for a node already on the stack, so were `backEdges` ever to
 * leave a cycle behind, a shared memo could otherwise record a value that
 * depended on which passage was asked about first.
 */
export function countPathsToAll(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  startId: NodeId | null,
  endings: ReadonlySet<NodeId> = NO_ENDINGS,
): Map<NodeId, bigint> {
  const out = new Map<NodeId, bigint>()
  if (startId === null) {
    for (const id of g.ids) out.set(id, 0n)
    return out
  }
  const count = reverseCounter(g, backEdges, startId, endings)
  for (const id of g.ids) out.set(id, count(id))
  return out
}

/** The shared recurrence behind both counters above. */
function reverseCounter(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  startId: NodeId,
  endings: ReadonlySet<NodeId>,
): (id: NodeId) => bigint {
  const memo = new Map<NodeId, bigint>()
  const visiting = new Set<NodeId>()

  const walk = (id: NodeId): bigint => {
    if (id === startId) return 1n
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0n
    visiting.add(id)

    let total = 0n
    for (const src of backwardSources(g, backEdges, id, endings)) total += walk(src)

    visiting.delete(id)
    memo.set(id, total)
    return total
  }

  return walk
}

/**
 * `n` as a percentage of `total`, to one decimal place.
 *
 * The division happens in BigInt so a story with more routes than a double can
 * hold still reports an honest share; only the small result is narrowed. BigInt
 * division truncates, so the tenth is rounded afterwards — otherwise two of
 * three routes reads as `66.6%`, which looks like a rounding bug rather than a
 * third. One decimal, not two: `66.66%` claims a precision nobody needs.
 *
 * Lives here beside `formatCount` rather than in `stats.ts`, because presenting
 * a BigInt route count is this module's job and two callers now ask for it.
 */
export function share(n: bigint, total: bigint): number {
  if (total <= 0n) return 0
  return Math.round(Number((n * 10000n) / total) / 10) / 10
}

/** Format a possibly-enormous count for display. */
export function formatCount(n: bigint): string {
  const s = n.toString()
  if (s.length <= 15) return Number(n).toLocaleString('en-US')
  return `${s[0]}.${s.slice(1, 3)} x 10^${s.length - 1}`
}
