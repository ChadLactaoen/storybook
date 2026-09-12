import type { NodeId, StoryDoc, StoryNode } from '../../types/story'
import { compareNodes, compareStr } from '../../types/story'
import { parseLinks } from '../harlowe/links'
import { PHANTOM_PREFIX } from './constants'
import type { DerivedEdge, DerivedGraph, EdgeId, GraphNode, PhantomNode } from './types'

/**
 * Build the edge set by parsing every body. Edges are never stored in the
 * document; body text is the sole source of truth for structure.
 *
 * Links resolve against `StoryNode.code`, never the title: a title is cosmetic
 * and two passages may share one. Targets that resolve to nothing become
 * *phantoms*: dashed placeholder cards that participate fully in layout.
 * Deriving never creates real nodes — that is a document mutation triggered by
 * editing a body (see lib/doc/mutations.ts). Keeping the two separate is what
 * lets a deleted-but-still-linked passage stay deleted instead of being
 * resurrected by the next re-derive.
 */
export function deriveGraph(doc: StoryDoc): DerivedGraph {
  const nodes = [...doc.nodes].sort(compareNodes)

  // Built from the canonically sorted nodes rather than `doc.nodes`, so that
  // "first wins" means "first in canonical order". A hand-edited file carrying
  // a duplicate code would otherwise resolve its links one way or the other
  // depending on array order, and layout would stop being shuffle-invariant.
  const idByCode = new Map<string, NodeId>()
  for (const n of nodes) {
    if (n.code.length > 0 && !idByCode.has(n.code)) idByCode.set(n.code, n.id)
  }

  const phantomByCode = new Map<string, PhantomNode>()
  const edges: DerivedEdge[] = []

  for (const node of nodes) {
    for (const link of parseLinks(node.body)) {
      let targetId = idByCode.get(link.target)
      let dangling = false

      if (targetId === undefined) {
        dangling = true
        let phantom = phantomByCode.get(link.target)
        if (phantom === undefined) {
          // The first link to reach a phantom names it. Last-wins would make the
          // card's caption change whenever an unrelated passage was edited.
          phantom = { id: PHANTOM_PREFIX + link.target, code: link.target, label: link.label }
          phantomByCode.set(link.target, phantom)
        }
        targetId = phantom.id
      }

      edges.push({
        id: `${node.id}|${link.ordinal}`,
        sourceId: node.id,
        targetId,
        targetCode: link.target,
        label: link.label,
        ordinal: link.ordinal,
        span: link.span,
        dangling,
        selfLoop: targetId === node.id,
      })
    }
  }

  const phantoms = [...phantomByCode.values()].sort((a, b) =>
    compareStr(a.code, b.code) || compareStr(a.id, b.id),
  )

  const byId = new Map<NodeId, GraphNode>()
  const codeOf = new Map<NodeId, string>()
  const titleOf = new Map<NodeId, string>()
  const stateOf = new Map<NodeId, StoryNode['state'] | null>()
  const ids: NodeId[] = []

  for (const n of nodes) {
    byId.set(n.id, n)
    codeOf.set(n.id, n.code)
    titleOf.set(n.id, n.title)
    stateOf.set(n.id, n.state)
    ids.push(n.id)
  }
  for (const p of phantoms) {
    byId.set(p.id, p)
    codeOf.set(p.id, p.code)
    // A phantom has no title, only the display text some link proposed for it.
    titleOf.set(p.id, p.label ?? '')
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
    codeOf,
    titleOf,
    stateOf,
  }
}

/** Codes used by more than one node — invalid, but possible in a hand-edited file. */
export function duplicateCodes(doc: StoryDoc): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const n of doc.nodes) {
    if (n.code.length === 0) continue
    if (seen.has(n.code)) dupes.add(n.code)
    seen.add(n.code)
  }
  return [...dupes].sort(compareStr)
}
