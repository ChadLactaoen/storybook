import type { NodeId, StoryDoc, StoryNode } from '../../types/story'
import { compareNodes, compareStr } from '../../types/story'
import { parseLinks } from '../harlowe/links'
import { PHANTOM_PREFIX } from './constants'
import type { DerivedEdge, DerivedGraph, EdgeId, GraphNode, PhantomNode } from './types'

/**
 * Build the edge set by parsing every body. Edges are never stored in the
 * document; body text is the sole source of truth for structure.
 *
 * Link targets that do not resolve become *phantoms*: dashed placeholder cards
 * that participate fully in layout. Deriving never creates real nodes — that is
 * a document mutation triggered by editing a body (see lib/doc/mutations.ts).
 * Keeping the two separate is what lets a deleted-but-still-linked passage stay
 * deleted instead of being resurrected by the next re-derive.
 */
export function deriveGraph(doc: StoryDoc): DerivedGraph {
  const nodes = [...doc.nodes].sort(compareNodes)

  const idByTitle = new Map<string, NodeId>()
  for (const n of nodes) {
    if (!idByTitle.has(n.title)) idByTitle.set(n.title, n.id)
  }

  const phantomByTitle = new Map<string, PhantomNode>()
  const edges: DerivedEdge[] = []

  for (const node of nodes) {
    for (const link of parseLinks(node.body)) {
      let targetId = idByTitle.get(link.target)
      let dangling = false

      if (targetId === undefined) {
        dangling = true
        let phantom = phantomByTitle.get(link.target)
        if (phantom === undefined) {
          phantom = { id: PHANTOM_PREFIX + link.target, title: link.target }
          phantomByTitle.set(link.target, phantom)
        }
        targetId = phantom.id
      }

      edges.push({
        id: `${node.id}|${link.ordinal}`,
        sourceId: node.id,
        targetId,
        targetTitle: link.target,
        label: link.label,
        ordinal: link.ordinal,
        span: link.span,
        dangling,
        selfLoop: targetId === node.id,
      })
    }
  }

  const phantoms = [...phantomByTitle.values()].sort((a, b) =>
    compareStr(a.title, b.title) || compareStr(a.id, b.id),
  )

  const byId = new Map<NodeId, GraphNode>()
  const titleOf = new Map<NodeId, string>()
  const stateOf = new Map<NodeId, StoryNode['state'] | null>()
  const ids: NodeId[] = []

  for (const n of nodes) {
    byId.set(n.id, n)
    titleOf.set(n.id, n.title)
    stateOf.set(n.id, n.state)
    ids.push(n.id)
  }
  for (const p of phantoms) {
    byId.set(p.id, p)
    titleOf.set(p.id, p.title)
    stateOf.set(p.id, null)
    ids.push(p.id)
  }

  const outAdj = new Map<NodeId, EdgeId[]>()
  const inAdj = new Map<NodeId, EdgeId[]>()
  for (const id of ids) {
    outAdj.set(id, [])
    inAdj.set(id, [])
  }

  const edgeById = new Map<EdgeId, DerivedEdge>()
  // `edges` is already in (canonical node order, body order); adjacency
  // inherits that order, which is what makes every later traversal reproducible.
  for (const e of edges) {
    edgeById.set(e.id, e)
    outAdj.get(e.sourceId)!.push(e.id)
    inAdj.get(e.targetId)!.push(e.id)
  }

  return {
    nodes,
    phantoms,
    ids,
    edges,
    edgeById,
    byId,
    outAdj,
    inAdj,
    titleOf,
    stateOf,
  }
}

/** Titles used by more than one node — invalid, but possible in a hand-edited file. */
export function duplicateTitles(doc: StoryDoc): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const n of doc.nodes) {
    if (seen.has(n.title)) dupes.add(n.title)
    seen.add(n.title)
  }
  return [...dupes].sort(compareStr)
}
