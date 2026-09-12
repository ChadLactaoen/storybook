import { tidyComponent } from './tidy'
import type { LayeredGraph, LayoutConfig } from './types'

/**
 * X-coordinate assignment: each component is laid out on its own, then packed
 * left to right.
 *
 * The per-component work lives in `tidy.ts` — a bottom-up rigid-subtree pass
 * that puts every parent on the midpoint of its outermost children.
 */
export function assignX(lg: LayeredGraph, cfg: LayoutConfig): void {
  let offset = 0
  for (let c = 0; c < lg.componentCount; c++) {
    const layers = lg.compLayers[c]!
    tidyComponent(lg, layers, cfg)

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
