/**
 * Who can you still get to from the start?
 *
 * Pure analysis over a derived graph: no layout, no store, no document edits.
 * `layout` uses it for the `orphan` diagnostic, and the store uses it to refuse
 * a delete that would cut a surviving passage off from the start.
 */

import type { NodeId, StoryDoc, StoryNode } from '../../types/story'
import { compareNodes } from '../../types/story'
import { deriveGraph } from './derive'
import type { DerivedGraph } from './types'

/**
 * Every id reachable by following links from `startId`, including it.
 *
 * The `seen` set is also the cycle guard — back edges are normal in CYOA
 * writing, so the walk has to tolerate them rather than treat them as errors.
 */
export function reachableFrom(g: DerivedGraph, startId: NodeId): Set<NodeId> {
  const seen = new Set<NodeId>([startId])
  const stack = [startId]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const eid of g.outAdj.get(id) ?? []) {
      const t = g.edgeById.get(eid)!.targetId
      if (!seen.has(t)) {
        seen.add(t)
        stack.push(t)
      }
    }
  }
  return seen
}

/**
 * Real passages with no route from the start. Phantoms are excluded by
 * construction — `g.nodes` holds only passages that exist in the document.
 *
 * A story with no start has no orphans: there is nothing to be unreachable
 * from, and reporting every passage would be noise.
 */
export function orphanIds(g: DerivedGraph, startId: NodeId | null): Set<NodeId> {
  if (startId === null) return new Set<NodeId>()
  const reachable = reachableFrom(g, startId)
  return new Set(g.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id))
}

/**
 * Passages that survive in `after` but lose their route from the start.
 *
 * Orphans of `before` are diffed out: a passage that was already unreachable is
 * not made worse by the edit, and blocking on it would make a broken story
 * uneditable. Returned in canonical order so the warning text is deterministic.
 *
 * `beforeGraph` is a parameter so a caller holding a derived graph for the
 * current document (the store does) need not build a second one.
 */
export function strandedBy(
  before: StoryDoc,
  after: StoryDoc,
  beforeGraph: DerivedGraph = deriveGraph(before),
): StoryNode[] {
  const was = orphanIds(beforeGraph, before.startNodeId)
  const now = orphanIds(deriveGraph(after), after.startNodeId)
  return after.nodes.filter((n) => now.has(n.id) && !was.has(n.id)).sort(compareNodes)
}
