import { syncLayers } from './layered'
import { countBilayerCrossings } from './crossings'
import type { LKey, LayeredGraph, LayoutConfig } from './types'

/**
 * Within-layer ordering: a DFS-preorder seed followed by alternating weighted
 * median sweeps with transposition, keeping the best ordering seen.
 *
 * Everything here is deterministic by construction: a fixed sweep budget (no
 * convergence or time-based exit), total comparators that never lean on sort
 * stability, and a strict `<` when accepting a new best so the earliest best
 * wins ties.
 */
export function orderLayers(lg: LayeredGraph, cfg: LayoutConfig): void {
  for (let c = 0; c < lg.componentCount; c++) {
    orderComponent(lg, lg.compLayers[c]!, cfg)
  }
  syncLayers(lg)
}

/**
 * Seed with a depth-first preorder. DFS rather than BFS because it lays
 * subtrees out contiguously, which is a far better starting point for the
 * tree-shaped graphs stories actually produce and cuts the sweeps needed.
 */
function seedByDfs(lg: LayeredGraph, layers: LKey[][]): void {
  const visitIndex = new Map<LKey, number>()
  let counter = 0

  const roots: LKey[] = []
  const seen = new Set<LKey>()
  for (const layer of layers) {
    for (const k of layer) {
      if ((lg.segsIn.get(k) ?? []).length === 0 && !seen.has(k)) {
        roots.push(k)
        seen.add(k)
      }
    }
  }
  for (const layer of layers) for (const k of layer) if (!seen.has(k)) roots.push(k)

  for (const root of roots) {
    if (visitIndex.has(root)) continue
    const stack: LKey[] = [root]
    while (stack.length > 0) {
      const k = stack.pop()!
      if (visitIndex.has(k)) continue
      visitIndex.set(k, counter++)
      const outs = lg.segsOut.get(k) ?? []
      // Reversed onto the stack so children are visited in segment order.
      for (let i = outs.length - 1; i >= 0; i--) stack.push(outs[i]!)
    }
  }

  for (const layer of layers) {
    const fallback = new Map<LKey, number>()
    layer.forEach((k, i) => fallback.set(k, i))
    layer.sort((a, b) => {
      const va = visitIndex.get(a) ?? Number.MAX_SAFE_INTEGER
      const vb = visitIndex.get(b) ?? Number.MAX_SAFE_INTEGER
      return va - vb || fallback.get(a)! - fallback.get(b)!
    })
  }
}

function orderComponent(lg: LayeredGraph, layers: LKey[][], cfg: LayoutConfig): void {
  if (layers.length === 0) return
  seedByDfs(lg, layers)

  const crossingsOf = () => {
    let total = 0
    for (let l = 0; l + 1 < layers.length; l++) {
      total += countBilayerCrossings(layers[l]!, layers[l + 1]!, lg)
    }
    return total
  }

  let best = layers.map((l) => [...l])
  let bestCrossings = crossingsOf()
  if (bestCrossings === 0) return

  for (let sweep = 0; sweep < cfg.orderingSweeps; sweep++) {
    wmedian(lg, layers, sweep % 2 === 0 ? 'down' : 'up')
    transpose(lg, layers, cfg)
    const c = crossingsOf()
    if (c < bestCrossings) {
      bestCrossings = c
      best = layers.map((l) => [...l])
      if (c === 0) break
    }
  }

  for (let l = 0; l < layers.length; l++) layers[l] = best[l]!
}

function positionsOf(layer: readonly LKey[]): Map<LKey, number> {
  const pos = new Map<LKey, number>()
  for (let i = 0; i < layer.length; i++) pos.set(layer[i]!, i)
  return pos
}

function wmedian(lg: LayeredGraph, layers: LKey[][], direction: 'down' | 'up'): void {
  const range =
    direction === 'down'
      ? Array.from({ length: layers.length - 1 }, (_, i) => i + 1)
      : Array.from({ length: layers.length - 1 }, (_, i) => layers.length - 2 - i)

  for (const l of range) {
    const fixed = layers[direction === 'down' ? l - 1 : l + 1]!
    const pos = positionsOf(fixed)
    const adj = direction === 'down' ? lg.segsIn : lg.segsOut

    const median = new Map<LKey, number>()
    for (const k of layers[l]!) {
      const ps: number[] = []
      for (const n of adj.get(k) ?? []) {
        const p = pos.get(n)
        if (p !== undefined) ps.push(p)
      }
      ps.sort((a, b) => a - b)
      median.set(k, medianValue(ps))
    }
    sortByMedian(layers[l]!, median)
  }
}

/** Gansner et al.'s weighted median; -1 means "no neighbours, hold position". */
function medianValue(ps: readonly number[]): number {
  const m = ps.length
  if (m === 0) return -1
  if (m % 2 === 1) return ps[(m - 1) >> 1]!
  if (m === 2) return (ps[0]! + ps[1]!) / 2
  const left = ps[m / 2 - 1]! - ps[0]!
  const right = ps[m - 1]! - ps[m / 2]!
  if (left + right === 0) return (ps[m / 2 - 1]! + ps[m / 2]!) / 2
  return (ps[m / 2 - 1]! * right + ps[m / 2]! * left) / (left + right)
}

/**
 * Permute only the nodes that have a median, among the slots they already
 * occupy; nodes with no neighbours keep their exact index. The comparator falls
 * back to the previous index, which is unique within a layer, so it is a total
 * order and never depends on sort stability.
 */
function sortByMedian(layer: LKey[], median: Map<LKey, number>): void {
  const prevIndex = positionsOf(layer)
  const movable = layer.filter((k) => median.get(k)! >= 0)
  movable.sort(
    (a, b) => median.get(a)! - median.get(b)! || prevIndex.get(a)! - prevIndex.get(b)!,
  )

  const out = new Array<LKey | null>(layer.length).fill(null)
  for (let i = 0; i < layer.length; i++) {
    const k = layer[i]!
    if (median.get(k)! < 0) out[i] = k
  }
  let m = 0
  for (let i = 0; i < out.length; i++) {
    if (out[i] === null) out[i] = movable[m++]!
  }
  for (let i = 0; i < layer.length; i++) layer[i] = out[i]!
}

/** Adjacent swaps that strictly reduce local crossings, to a fixed pass cap. */
function transpose(lg: LayeredGraph, layers: LKey[][], cfg: LayoutConfig): void {
  const widest = layers.reduce((m, l) => Math.max(m, l.length), 0)
  // The first thing that blows up on a pathological story; degrade to slightly
  // more crossings rather than to a frozen tab.
  if (widest > cfg.transposeMaxLayerWidth) return

  for (let pass = 0; pass < 4; pass++) {
    let improved = false
    for (let l = 0; l < layers.length; l++) {
      const layer = layers[l]!
      for (let i = 0; i + 1 < layer.length; i++) {
        const before = localCrossings(lg, layers, l)
        ;[layer[i], layer[i + 1]] = [layer[i + 1]!, layer[i]!]
        const after = localCrossings(lg, layers, l)
        if (after < before) {
          improved = true
        } else {
          ;[layer[i], layer[i + 1]] = [layer[i + 1]!, layer[i]!]
        }
      }
    }
    if (!improved) break
  }
}

function localCrossings(lg: LayeredGraph, layers: LKey[][], l: number): number {
  let total = 0
  if (l > 0) total += countBilayerCrossings(layers[l - 1]!, layers[l]!, lg)
  if (l + 1 < layers.length) total += countBilayerCrossings(layers[l]!, layers[l + 1]!, lg)
  return total
}
