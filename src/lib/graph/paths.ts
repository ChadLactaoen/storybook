import type { NodeId } from '../../types/story'
import type { DerivedGraph, EdgeId } from './types'

/**
 * Count distinct story paths from `startId` down to any ending.
 *
 *   paths(n) = 1 when n has no forward out-edges, else the sum over children.
 *
 * BigInt because the count is exponential in practice — a story with 40 binary
 * choices overflows a double long before it overflows the author's patience.
 * Back edges are excluded, so the traversal terminates.
 */
export function countPaths(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  startId: NodeId,
): bigint {
  const memo = new Map<NodeId, bigint>()
  const visiting = new Set<NodeId>()

  const walk = (id: NodeId): bigint => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0n
    visiting.add(id)

    let total = 0n
    let children = 0
    for (const eid of g.outAdj.get(id) ?? []) {
      const e = g.edgeById.get(eid)!
      if (e.selfLoop || backEdges.has(eid)) continue
      children++
      total += walk(e.targetId)
    }

    const result = children === 0 ? 1n : total
    visiting.delete(id)
    memo.set(id, result)
    return result
  }

  return walk(startId)
}

/** Format a possibly-enormous count for display. */
export function formatCount(n: bigint): string {
  const s = n.toString()
  if (s.length <= 15) return Number(n).toLocaleString('en-US')
  return `${s[0]}.${s.slice(1, 3)} x 10^${s.length - 1}`
}
