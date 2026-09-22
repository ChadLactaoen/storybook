import type { LNode, LayoutConfig } from './types'

export const NODE_W = 200
export const NODE_H = 96
export const NODE_GAP = 56

/**
 * Sibling center spacing at minimum separation.
 * With layer spacing H and sibling spacing S, a two-child fan has edge length
 * sqrt(H^2 + S^2/4); setting that equal to S gives H = S * sqrt(3)/2, so a
 * minimum-spacing fan is geometrically equilateral.
 *
 * The factor is a literal rather than `Math.sqrt(3)/2`: only `Math.sqrt` is
 * exactly rounded by the spec, and keeping transcendentals out of the layout
 * path entirely is the simpler rule to enforce.
 */
export const SIBLING_SPACING = NODE_W + NODE_GAP // 256
export const EQUILATERAL_FACTOR = 0.8660254037844386
export const LAYER_SPACING = Math.round(EQUILATERAL_FACTOR * SIBLING_SPACING) // 222

export const DEFAULT_CONFIG: LayoutConfig = {
  packing: 'balanced',
  nodeWidth: NODE_W,
  nodeHeight: NODE_H,
  nodeGap: NODE_GAP,
  edgeGap: 18,
  componentGap: 120,
  layerSpacing: LAYER_SPACING,
  margin: 80,
  orderingSweeps: 8,
  transposeMaxLayerWidth: 200,
  coordPrecision: 2,
}

/**
 * Tighter cards and gaps, for fitting more of a story on screen.
 *
 * Only the three numbers that decide how much room a card takes: the packing
 * strategy is a separate setting, because how much fits on screen and where a
 * parent sits are different questions, and one of them does nothing at all to a
 * story with no merges.
 *
 * `layerSpacing` is recomputed rather than kept, or the drawing would keep its
 * full height while narrowing and a fan would stop being equilateral — the
 * property `EQUILATERAL_FACTOR` exists to hold. Height follows width down.
 *
 * Card text is unaffected by this and must stay that way: the title clamps to
 * two lines and chips clip, so nothing here can change geometry by being long.
 */
export const COMPACT_W = 150
export const COMPACT_GAP = 24
/**
 * Scaled with the rest, and it has to be. `sep` charges `edgeGap` beside a
 * dummy, so two cards with a wire threading between them cost
 * `nodeWidth + 2 * edgeGap` against `nodeWidth + nodeGap` for two that are
 * simply adjacent. The wire is only free to pass while `2 * edgeGap <= nodeGap`
 * — true at the defaults (36 against 56) and the whole reason a long edge can
 * go between two passages rather than around them. Left at 18 here it would be
 * 36 against 24, so every long edge would *widen* a compact drawing instead of
 * fitting inside a gap it already had.
 */
export const COMPACT_EDGE_GAP = 10

export const COMPACT_CONFIG: Omit<Partial<LayoutConfig>, 'packing'> = {
  nodeWidth: COMPACT_W,
  nodeGap: COMPACT_GAP,
  edgeGap: COMPACT_EDGE_GAP,
  layerSpacing: Math.round(EQUILATERAL_FACTOR * (COMPACT_W + COMPACT_GAP)),
}

/**
 * How far apart two things in the same layer must sit, centre to centre.
 *
 * The one definition, because there are now two modules placing cards and a
 * separation both of them agree on is the whole of what "no overlap" means. Two
 * copies of this is the drift `forwardTargets` documents in CLAUDE.md — change
 * how a card beside a dummy is charged in one and the other keeps the old rule,
 * and only the packing mode that happened to be tested draws correctly.
 *
 * A dummy has no width and is charged `edgeGap` rather than `nodeGap`, which is
 * what lets a long link pass *between* two cards instead of around them — see
 * `COMPACT_EDGE_GAP` for the `2 * edgeGap <= nodeGap` invariant that keeps it
 * free.
 */
export function separation(cfg: LayoutConfig): (a: LNode, b: LNode) => number {
  return (a, b) =>
    a.width / 2 + b.width / 2 + (a.kind === 'real' && b.kind === 'real' ? cfg.nodeGap : cfg.edgeGap)
}

export const PHANTOM_PREFIX = 'phantom:'

export function isPhantomId(id: string): boolean {
  return id.startsWith(PHANTOM_PREFIX)
}
