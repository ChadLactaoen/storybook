import type { NodeId } from '../../types/story'
import type { DerivedGraph, EdgeId, LevelingResult } from './types'

/**
 * Longest-path layering, with the user's level offset folded in as a lower
 * bound on the same recurrence:
 *
 *   minLevel(v) = max(1, max over forward in-neighbours p of level(p) + 1)
 *   level(v)    = minLevel(v) + clamp(levelOffset(v), 0, 1)
 *
 * Longest path (not BFS) is the only assignment that guarantees the document
 * invariant "a node at level N only links to levels >= N+1". BFS collapses the
 * moment a redundant shortcut edge appears: with 1->4, 4->2, 1->3 and *also*
 * 1->2, BFS puts 2 alongside 4 at level 2, making 4->2 an illegal intra-level
 * edge. Longest path keeps 2 at level 3.
 *
 * Folding the offset into the recurrence rather than applying it afterwards is
 * what makes descendants shift down automatically. A purely visual override
 * would be unsound: pushing a node down onto its own child's level produces an
 * intra-level edge the renderer has no story for.
 *
 * Evaluated in topological order, so `minLevel(v)` already reflects every
 * accepted offset above it.
 */
export function assignLevels(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  offsetOf: (id: NodeId) => number,
): LevelingResult {
  const forwardIn = new Map<NodeId, EdgeId[]>()
  const indegree = new Map<NodeId, number>()
  for (const id of g.ids) {
    const ins = (g.inAdj.get(id) ?? []).filter((eid) => {
      const e = g.edgeById.get(eid)!
      return !e.selfLoop && !backEdges.has(eid)
    })
    forwardIn.set(id, ins)
    indegree.set(id, ins.length)
  }

  // Kahn over `g.ids` (canonical order) so the topological order is reproducible.
  const queue: NodeId[] = g.ids.filter((id) => indegree.get(id) === 0)
  const order: NodeId[] = []
  let head = 0

  while (head < queue.length) {
    const id = queue[head++]!
    order.push(id)
    for (const eid of g.outAdj.get(id) ?? []) {
      const e = g.edgeById.get(eid)!
      if (e.selfLoop || backEdges.has(eid)) continue
      const t = e.targetId
      const d = indegree.get(t)! - 1
      indegree.set(t, d)
      if (d === 0) queue.push(t)
    }
  }
  // Back-edge removal makes the graph acyclic, so `order` covers everything;
  // the fallback only guards against a malformed graph.
  if (order.length < g.ids.length) {
    for (const id of g.ids) if (!order.includes(id)) order.push(id)
  }

  const minLevel = new Map<NodeId, number>()
  const level = new Map<NodeId, number>()
  let maxLevel = 1

  for (const id of order) {
    let floor = 1
    for (const eid of forwardIn.get(id) ?? []) {
      const parent = g.edgeById.get(eid)!.sourceId
      const pl = level.get(parent)
      if (pl !== undefined && pl + 1 > floor) floor = pl + 1
    }
    minLevel.set(id, floor)

    const offset = Math.min(1, Math.max(0, Math.trunc(offsetOf(id))))
    const lv = floor + offset
    level.set(id, lv)
    if (lv > maxLevel) maxLevel = lv
  }

  return { level, minLevel, maxLevel }
}
