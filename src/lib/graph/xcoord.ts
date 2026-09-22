import { straightComponent } from './straight'
import { tidyComponent } from './tidy'
import type { LayeredGraph, LayoutConfig } from './types'

/**
 * X-coordinate assignment: each component is laid out on its own, then packed
 * left to right.
 *
 * The per-component work lives in one of two modules, and `cfg.packing` picks
 * which. `tidy.ts` is a bottom-up rigid-subtree pass that puts every parent on
 * the midpoint of its outermost children (`balanced` and `aligned` are its two
 * strategies for a parent that cannot reach that midpoint). `straight.ts` is
 * Brandes–Köpf, which aligns each card under the median of its neighbours
 * instead and has no forest and no sweep direction at all.
 *
 * Only the choice lives here, and a fourth mode is an edit to *this* switch as
 * well as to `PACKING_MODES`. The `default` is what makes that so: assigning
 * the mode to `never` there fails to compile the moment the union holds
 * something no case above caught, which is the alternative to a silent `else`
 * that draws the new mode as `balanced` and reports nothing.
 *
 * It throws rather than falling back for the same reason. Reaching it needs a
 * caller that cast past the type, and a drawing that is quietly not the one
 * that was asked for is worse than a stack trace — this is the failure
 * `prefs.ts` validates its stored mode to keep out of here in the first place.
 */
export function assignX(lg: LayeredGraph, cfg: LayoutConfig): void {
  let offset = 0
  for (let c = 0; c < lg.componentCount; c++) {
    const layers = lg.compLayers[c]!
    switch (cfg.packing) {
      case 'straight':
        straightComponent(lg, layers, cfg)
        break
      case 'balanced':
      case 'aligned':
        // The two differ inside `tidy.ts`, at `place`, not here.
        tidyComponent(lg, layers, cfg)
        break
      default: {
        const unhandled: never = cfg.packing
        throw new Error(`no x-coordinate assignment for packing ${String(unhandled)}`)
      }
    }

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
