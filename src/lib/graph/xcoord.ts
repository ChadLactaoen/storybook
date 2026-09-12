import type { LKey, LNode, LayeredGraph, LayoutConfig } from './types'

/**
 * X-coordinate assignment: compact packing, then priority relaxation.
 *
 * Every move is clamped to the slack available before the first already-placed
 * neighbour, so minimum separation holds after *every* step. Non-overlap is
 * therefore structural, not something the iteration budget has to be trusted to
 * preserve — the budget only affects how symmetric the result gets.
 *
 * Targets are means rather than medians: the mean is what puts a two-child
 * parent exactly between its children, which is the symmetry the spec asks for.
 * Naive push-right collision resolution is deliberately avoided; biasing every
 * collision rightward is precisely what destroys sibling equidistance.
 */
export function assignX(lg: LayeredGraph, cfg: LayoutConfig): void {
  let offset = 0
  for (let c = 0; c < lg.componentCount; c++) {
    const layers = lg.compLayers[c]!
    layoutComponent(lg, layers, cfg)

    let min = Infinity
    let max = -Infinity
    for (const layer of layers) {
      for (const k of layer) {
        const n = lg.nodes.get(k)!
        min = Math.min(min, n.x - n.width / 2)
        max = Math.max(max, n.x + n.width / 2)
      }
    }
    if (!Number.isFinite(min)) continue

    const shift = offset - min
    for (const layer of layers) {
      for (const k of layer) lg.nodes.get(k)!.x += shift
    }
    offset += max - min + cfg.componentGap
  }
}

export function assignY(lg: LayeredGraph, cfg: LayoutConfig): void {
  for (const k of lg.keys) {
    const n = lg.nodes.get(k)!
    n.y = cfg.margin + n.layer * cfg.layerSpacing + cfg.nodeHeight / 2
  }
}

function layoutComponent(lg: LayeredGraph, layers: LKey[][], cfg: LayoutConfig): void {
  const sep = (a: LNode, b: LNode) =>
    a.width / 2 + b.width / 2 + (a.kind === 'real' && b.kind === 'real' ? cfg.nodeGap : cfg.edgeGap)

  // Step A: compact packing.
  for (const layer of layers) {
    for (let i = 0; i < layer.length; i++) {
      const n = lg.nodes.get(layer[i]!)!
      if (i === 0) {
        n.x = n.width / 2
      } else {
        const prev = lg.nodes.get(layer[i - 1]!)!
        n.x = prev.x + sep(prev, n)
      }
    }
  }

  const priority = (n: LNode) =>
    n.kind === 'dummy'
      ? Number.MAX_SAFE_INTEGER
      : (lg.segsIn.get(n.key)?.length ?? 0) + (lg.segsOut.get(n.key)?.length ?? 0)

  const meanOf = (keys: readonly LKey[]): number | null => {
    if (keys.length === 0) return null
    let sum = 0
    for (const k of keys) sum += lg.nodes.get(k)!.x
    return sum / keys.length
  }

  // Step B: relaxation, alternating two complementary passes.
  //
  // Bottom-up centres each parent on the mean of its children. Top-down is the
  // subtle half: it must NOT pull each child toward the parent individually,
  // which collapses siblings onto one point and then lets slack repair fling
  // them apart asymmetrically. Instead it shifts a parent's whole child group
  // rigidly, preserving the spacing the children already agreed on while
  // centring the group under the parent.
  for (let iter = 0; iter < cfg.relaxIterations; iter++) {
    const bottomUp = iter % 2 === 0
    const order = bottomUp
      ? Array.from({ length: layers.length }, (_, i) => layers.length - 1 - i)
      : Array.from({ length: layers.length }, (_, i) => i)

    for (const l of order) {
      const layer = layers[l]!
      if (layer.length === 0) continue

      const targets = new Map<LKey, number>()
      for (const k of layer) {
        const node = lg.nodes.get(k)!
        if (bottomUp) {
          const down = meanOf(lg.segsOut.get(k) ?? [])
          if (down !== null) targets.set(k, down)
        } else {
          const parents = lg.segsIn.get(k) ?? []
          if (parents.length === 0) continue
          let shift = 0
          for (const p of parents) {
            const parent = lg.nodes.get(p)!
            const siblingMean = meanOf(lg.segsOut.get(p) ?? [])
            shift += parent.x - (siblingMean ?? parent.x)
          }
          targets.set(k, node.x + shift / parents.length)
        }
      }

      relaxLayer(lg, layer, targets, sep, priority)
    }
  }
}

function relaxLayer(
  lg: LayeredGraph,
  layer: readonly LKey[],
  targets: ReadonlyMap<LKey, number>,
  sep: (a: LNode, b: LNode) => number,
  priority: (n: LNode) => number,
): void {
  const nodes = layer.map((k) => lg.nodes.get(k)!)
  const n = nodes.length
  const placed = new Array<boolean>(n).fill(false)

  const indices = Array.from({ length: n }, (_, i) => i)
  indices.sort((a, b) => priority(nodes[b]!) - priority(nodes[a]!) || a - b)

  const gapSlack = (j: number) => nodes[j + 1]!.x - nodes[j]!.x - sep(nodes[j]!, nodes[j + 1]!)

  const maxRight = (i: number) => {
    let acc = 0
    for (let j = i; j + 1 < n; j++) {
      acc += gapSlack(j)
      if (placed[j + 1]) return Math.max(0, acc)
    }
    return Infinity
  }

  const maxLeft = (i: number) => {
    let acc = 0
    for (let j = i; j > 0; j--) {
      acc += gapSlack(j - 1)
      if (placed[j - 1]) return Math.max(0, acc)
    }
    return Infinity
  }

  for (const i of indices) {
    const node = nodes[i]!
    const target = targets.get(node.key)
    if (target === undefined) {
      placed[i] = true
      continue
    }

    const delta = target - node.x
    const bounded =
      delta > 0 ? Math.min(delta, maxRight(i)) : Math.max(delta, -maxLeft(i))
    if (bounded !== 0) {
      node.x += bounded
      for (let k = i + 1; k < n; k++) {
        nodes[k]!.x = Math.max(nodes[k]!.x, nodes[k - 1]!.x + sep(nodes[k - 1]!, nodes[k]!))
      }
      for (let k = i - 1; k >= 0; k--) {
        nodes[k]!.x = Math.min(nodes[k]!.x, nodes[k + 1]!.x - sep(nodes[k]!, nodes[k + 1]!))
      }
    }
    placed[i] = true
  }
}
