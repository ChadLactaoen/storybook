import type { NodeId } from '../../types/story'
import { compareStr } from '../../types/story'
import type { AcyclicResult, DerivedGraph, EdgeId } from './types'

const WHITE = 0
const GRAY = 1
const BLACK = 2

/**
 * Designate back edges with a canonical depth-first search.
 *
 * Cycles are legitimate in CYOA writing ("return to the hub"), so they are
 * never an error — but *which* edge of a cycle gets called the back edge
 * changes the entire layering, so the traversal order has to be pinned down:
 *
 *   1. the declared start node first, then remaining roots by title,
 *      then any still-unvisited node in canonical order;
 *   2. out-edges in body order.
 *
 * Self-loops are excluded here; they never enter layout at all.
 */
export function findBackEdges(g: DerivedGraph, startNodeId: NodeId | null): AcyclicResult {
  const color = new Map<NodeId, number>()
  for (const id of g.ids) color.set(id, WHITE)

  const backEdges = new Set<EdgeId>()
  const cycles: NodeId[][] = []

  const roots: NodeId[] = []
  const seen = new Set<NodeId>()
  if (startNodeId !== null && color.has(startNodeId)) {
    roots.push(startNodeId)
    seen.add(startNodeId)
  }
  const otherRoots = g.ids.filter(
    (id) => !seen.has(id) && (g.inAdj.get(id)?.length ?? 0) === 0,
  )
  otherRoots.sort((a, b) => compareStr(g.titleOf.get(a)!, g.titleOf.get(b)!) || compareStr(a, b))
  for (const id of otherRoots) {
    roots.push(id)
    seen.add(id)
  }
  // Nodes only reachable from within a cycle have no root; sweep them last.
  for (const id of g.ids) if (!seen.has(id)) roots.push(id)

  // Explicit stack; story graphs can be deep enough to worry about recursion.
  interface Frame {
    id: NodeId
    edges: readonly EdgeId[]
    i: number
  }

  for (const root of roots) {
    if (color.get(root) !== WHITE) continue

    const stack: Frame[] = [{ id: root, edges: g.outAdj.get(root) ?? [], i: 0 }]
    const path: NodeId[] = [root]
    color.set(root, GRAY)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      if (frame.i >= frame.edges.length) {
        color.set(frame.id, BLACK)
        stack.pop()
        path.pop()
        continue
      }

      const edgeId = frame.edges[frame.i++]!
      const edge = g.edgeById.get(edgeId)!
      if (edge.selfLoop) continue

      const next = edge.targetId
      const c = color.get(next)

      if (c === GRAY) {
        backEdges.add(edgeId)
        const at = path.lastIndexOf(next)
        if (at !== -1) cycles.push([...path.slice(at), next])
      } else if (c === WHITE) {
        color.set(next, GRAY)
        path.push(next)
        stack.push({ id: next, edges: g.outAdj.get(next) ?? [], i: 0 })
      }
    }
  }

  return { backEdges, cycles }
}
