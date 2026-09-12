import type { NodeId, StoryDoc } from '../../types/story'
import { compareStr, nodeLabel } from '../../types/story'
import { findBackEdges } from './acyclic'
import { findComponents } from './components'
import { DEFAULT_CONFIG, isPhantomId } from './constants'
import { countCrossings } from './crossings'
import { deriveGraph, duplicateCodes } from './derive'
import { fnv1a } from './hash'
import { assignLevels } from './layering'
import { buildLayeredGraph, realKey } from './layered'
import { orderLayers } from './ordering'
import { orphanIds } from './reachability'
import { routeEdges } from './routing'
import { assignX, assignY } from './xcoord'
import type {
  Bounds,
  DerivedGraph,
  Diagnostic,
  LayoutConfig,
  LayoutResult,
  LevelBand,
  NodeLayout,
} from './types'

/** How a passage is named inside a diagnostic. Works for phantoms too. */
function label(g: DerivedGraph, id: NodeId): string {
  return nodeLabel(g.codeOf.get(id) ?? '', g.titleOf.get(id) ?? '') || id
}

function round(v: number, precision: number): number {
  const f = 10 ** precision
  return Math.round(v * f) / f
}

/**
 * The single public entry point. Pure, synchronous and clone-friendly: the same
 * document always produces the same drawing, which is what makes the save file
 * idempotent and lets this move into a worker later without a rewrite.
 *
 * Nothing positional is ever persisted — levels, ordering, coordinates and edge
 * paths are all recomputed here. That is also why inserting a node mid-story
 * "auto-refactors" levels: there is nothing to refactor, the levels are simply
 * re-derived.
 */
export function layoutStory(doc: StoryDoc, config?: Partial<LayoutConfig>): LayoutResult {
  const cfg: LayoutConfig = { ...DEFAULT_CONFIG, ...config }
  const diagnostics: Diagnostic[] = []

  const g = deriveGraph(doc)

  for (const dupe of duplicateCodes(doc)) {
    diagnostics.push({
      code: 'duplicate-code',
      severity: 'error',
      // `g.nodes`, not `doc.nodes`: filtering the document would put these ids in
      // array order, and layout has to be identical for any shuffle of the nodes.
      message: `More than one passage uses the code "${dupe}". Links to it are ambiguous.`,
      nodeIds: g.nodes.filter((n) => n.code === dupe).map((n) => n.id),
      edgeIds: [],
    })
  }

  const { backEdges, cycles } = findBackEdges(g, doc.startNodeId)

  for (const cycle of cycles) {
    diagnostics.push({
      code: 'cycle',
      severity: 'info',
      message: `Loop: ${cycle.map((id) => label(g, id)).join(' → ')}`,
      nodeIds: [...cycle],
      edgeIds: [],
    })
  }

  const offsets = new Map<NodeId, number>()
  for (const n of doc.nodes) offsets.set(n.id, n.levelOffset)
  const lv = assignLevels(g, backEdges, (id) => offsets.get(id) ?? 0)

  const { componentOf, count } = findComponents(g)
  const lg = buildLayeredGraph(g, lv, backEdges, componentOf, count, cfg)

  orderLayers(lg, cfg)
  assignX(lg, cfg)
  assignY(lg, cfg)

  const edges = routeEdges(lg, g, cfg)

  const nodes: NodeLayout[] = []
  for (const id of g.ids) {
    const ln = lg.nodes.get(realKey(id))
    if (!ln) continue
    nodes.push({
      id,
      code: g.codeOf.get(id) ?? id,
      title: g.titleOf.get(id) ?? '',
      level: lv.level.get(id) ?? 1,
      layer: ln.layer,
      order: ln.order,
      x: round(ln.x, cfg.coordPrecision),
      y: round(ln.y, cfg.coordPrecision),
      width: ln.width,
      height: ln.height,
      isPhantom: isPhantomId(id),
      minLevel: lv.minLevel.get(id) ?? 1,
      levelOffset: Math.min(1, Math.max(0, Math.trunc(offsets.get(id) ?? 0))),
    })
  }
  nodes.sort((a, b) => compareStr(a.code, b.code) || compareStr(a.id, b.id))

  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  for (const p of g.phantoms) {
    diagnostics.push({
      code: 'dangling-link',
      severity: 'warn',
      message: `No passage has the code "${p.code}".`,
      nodeIds: [p.id],
      edgeIds: g.edges.filter((e) => e.targetId === p.id).map((e) => e.id),
    })
  }

  for (const e of g.edges) {
    if (!e.selfLoop) continue
    diagnostics.push({
      code: 'self-loop',
      severity: 'info',
      message: `"${label(g, e.sourceId)}" links to itself.`,
      nodeIds: [e.sourceId],
      edgeIds: [e.id],
    })
  }

  if (doc.startNodeId) {
    const stranded = orphanIds(g, doc.startNodeId)
    const orphans = g.nodes.filter((n) => stranded.has(n.id))
    if (orphans.length > 0) {
      diagnostics.push({
        code: 'orphan',
        severity: 'info',
        message:
          orphans.length === 1
            ? `"${label(g, orphans[0]!.id)}" is not reachable from the start.`
            : `${orphans.length} passages are not reachable from the start.`,
        nodeIds: orphans.map((n) => n.id),
        edgeIds: [],
      })
    }
  }

  const levels: LevelBand[] = lg.levelOfLayer.map((level, layer) => ({
    level,
    y: round(cfg.margin + layer * cfg.layerSpacing, cfg.coordPrecision),
    height: cfg.nodeHeight,
    count: nodes.filter((n) => n.layer === layer).length,
  }))

  const bounds = boundsOf(nodes, cfg)

  const hashInput = [
    nodes.map((n) => `${n.id}:${n.x}:${n.y}:${n.level}`).join(','),
    edges.map((e) => `${e.edgeId}:${e.d}`).join(','),
  ].join('|')

  return {
    nodes,
    nodeById,
    edges,
    levels,
    bounds,
    diagnostics,
    stats: {
      crossings: countCrossings(lg),
      layers: lg.levelOfLayer.length,
      dummies: lg.keys.length - g.ids.length,
      hash: fnv1a(hashInput),
    },
    graph: g,
    backEdges,
  }
}

function boundsOf(nodes: readonly NodeLayout[], cfg: LayoutConfig): Bounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.width / 2)
    maxX = Math.max(maxX, n.x + n.width / 2)
    minY = Math.min(minY, n.y - n.height / 2)
    maxY = Math.max(maxY, n.y + n.height / 2)
  }
  minX -= cfg.margin
  minY -= cfg.margin
  maxX += cfg.margin
  maxY += cfg.margin
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}
