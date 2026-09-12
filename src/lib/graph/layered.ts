import type { NodeId } from '../../types/story'
import type { DerivedGraph, EdgeId, EdgeKind, LKey, LNode, LayeredGraph, LayoutConfig, LevelingResult } from './types'

export function realKey(id: NodeId): LKey {
  return `n:${id}`
}

export function dummyKey(edgeId: EdgeId, layer: number): LKey {
  return `d:${edgeId}:${layer}`
}

/**
 * Build the layered graph, inserting a chain of dummy nodes for every edge that
 * spans more than one level.
 *
 * Dummies are the mechanism behind "links should not travel through unrelated
 * nodes": a dummy occupies a real slot in its layer and is subject to minimum
 * separation, so a long edge is physically forced through an inter-node gap
 * rather than across a card. They also make long edges participate in crossing
 * reduction, which no post-hoc obstacle-avoidance routing could match.
 *
 * Back edges are reversed here so they become ordinary forward chains for the
 * ordering and coordinate phases; routing draws the arrowhead back at the
 * original target.
 */
export function buildLayeredGraph(
  g: DerivedGraph,
  lv: LevelingResult,
  backEdges: ReadonlySet<EdgeId>,
  componentOf: Map<NodeId, number>,
  componentCount: number,
  cfg: LayoutConfig,
): LayeredGraph {
  const layerCount = lv.maxLevel
  const nodes = new Map<LKey, LNode>()
  const keys: LKey[] = []
  const compLayers: LKey[][][] = []
  for (let c = 0; c < componentCount; c++) {
    compLayers.push(Array.from({ length: layerCount }, () => [] as LKey[]))
  }

  const push = (n: LNode) => {
    nodes.set(n.key, n)
    keys.push(n.key)
    compLayers[n.component]![n.layer]!.push(n.key)
  }

  // Real nodes, in canonical order — this seeds every later traversal.
  for (const id of g.ids) {
    const layer = (lv.level.get(id) ?? 1) - 1
    push({
      key: realKey(id),
      kind: 'real',
      nodeId: id,
      edgeId: null,
      layer,
      order: 0,
      width: cfg.nodeWidth,
      height: cfg.nodeHeight,
      x: 0,
      y: 0,
      component: componentOf.get(id) ?? 0,
    })
  }

  const segs: LayeredGraph['segs'] = []
  const chainOf = new Map<EdgeId, LKey[]>()
  const reversed = new Set<EdgeId>()
  const degenerate = new Map<EdgeId, EdgeKind>()

  for (const e of g.edges) {
    if (e.selfLoop) {
      degenerate.set(e.id, 'self')
      chainOf.set(e.id, [])
      continue
    }

    const isBack = backEdges.has(e.id)
    if (isBack) reversed.add(e.id)

    const fromId = isBack ? e.targetId : e.sourceId
    const toId = isBack ? e.sourceId : e.targetId
    const fromLayer = (lv.level.get(fromId) ?? 1) - 1
    const toLayer = (lv.level.get(toId) ?? 1) - 1
    const span = toLayer - fromLayer

    if (span <= 0) {
      // A cycle edge between two nodes that ended up on the same level. Routed
      // as a flat arc above the band rather than forced into the layer machinery.
      degenerate.set(e.id, 'flat')
      chainOf.set(e.id, [])
      continue
    }

    const component = componentOf.get(fromId) ?? 0
    const chain: LKey[] = []
    for (let l = fromLayer + 1; l < toLayer; l++) {
      const key = dummyKey(e.id, l)
      chain.push(key)
      push({
        key,
        kind: 'dummy',
        nodeId: null,
        edgeId: e.id,
        layer: l,
        order: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        component,
      })
    }
    chainOf.set(e.id, chain)

    const path = [realKey(fromId), ...chain, realKey(toId)]
    for (let i = 0; i < path.length - 1; i++) {
      segs.push({ edgeId: e.id, from: path[i]!, to: path[i + 1]! })
    }
  }

  const segsOut = new Map<LKey, LKey[]>()
  const segsIn = new Map<LKey, LKey[]>()
  for (const k of keys) {
    segsOut.set(k, [])
    segsIn.set(k, [])
  }
  for (const s of segs) {
    segsOut.get(s.from)!.push(s.to)
    segsIn.get(s.to)!.push(s.from)
  }

  const lg: LayeredGraph = {
    nodes,
    keys,
    layers: [],
    compLayers,
    segs,
    segsOut,
    segsIn,
    reversed,
    chainOf,
    levelOfLayer: Array.from({ length: layerCount }, (_, i) => i + 1),
    componentCount,
    degenerate,
  }

  syncLayers(lg)
  return lg
}

/**
 * Rebuild the merged `layers` view from `compLayers` and refresh each node's
 * `order`. Call after any phase that permutes within a component.
 */
export function syncLayers(lg: LayeredGraph): void {
  const layerCount = lg.levelOfLayer.length
  lg.layers = Array.from({ length: layerCount }, () => [] as LKey[])
  for (let l = 0; l < layerCount; l++) {
    const merged = lg.layers[l]!
    for (let c = 0; c < lg.componentCount; c++) {
      for (const k of lg.compLayers[c]![l]!) merged.push(k)
    }
    for (let i = 0; i < merged.length; i++) {
      lg.nodes.get(merged[i]!)!.order = i
    }
  }
}
