import type { NodeId } from '../../types/story'
import type { DerivedGraph } from './types'

/**
 * Weakly-connected components, numbered in canonical order (by the position of
 * their first node in `g.ids`). Each component is laid out independently and
 * then packed left to right, so unrelated subgraphs and stray orphans can never
 * interleave inside a level.
 */
export function findComponents(g: DerivedGraph): {
  componentOf: Map<NodeId, number>
  count: number
} {
  const parent = new Map<NodeId, NodeId>()
  for (const id of g.ids) parent.set(id, id)

  const find = (x: NodeId): NodeId => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    // Path compression.
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }

  for (const e of g.edges) {
    if (e.selfLoop) continue
    const a = find(e.sourceId)
    const b = find(e.targetId)
    if (a !== b) parent.set(a, b)
  }

  const index = new Map<NodeId, number>()
  const componentOf = new Map<NodeId, number>()
  let count = 0
  for (const id of g.ids) {
    const root = find(id)
    let idx = index.get(root)
    if (idx === undefined) {
      idx = count++
      index.set(root, idx)
    }
    componentOf.set(id, idx)
  }

  return { componentOf, count }
}
