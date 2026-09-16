import type { NodeId } from '../../types/story'
import type { DerivedGraph, EdgeId } from './types'

/** No passage marked as an ending — the shape every call had before endings existed. */
const NO_ENDINGS: ReadonlySet<NodeId> = new Set()

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
  const memo = new Map<NodeId, bigint>()
  const visiting = new Set<NodeId>()

  const walk = (id: NodeId): bigint => {
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

  return walk(startId)
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
  if (startId === null) return 0n
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

  return walk(targetId)
}

/** Format a possibly-enormous count for display. */
export function formatCount(n: bigint): string {
  const s = n.toString()
  if (s.length <= 15) return Number(n).toLocaleString('en-US')
  return `${s[0]}.${s.slice(1, 3)} x 10^${s.length - 1}`
}
