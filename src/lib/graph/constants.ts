import type { LayoutConfig } from './types'

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
  nodeWidth: NODE_W,
  nodeHeight: NODE_H,
  nodeGap: NODE_GAP,
  edgeGap: 18,
  componentGap: 120,
  layerSpacing: LAYER_SPACING,
  margin: 80,
  orderingSweeps: 8,
  relaxIterations: 8,
  transposeMaxLayerWidth: 200,
  coordPrecision: 2,
}

export const PHANTOM_PREFIX = 'phantom:'

export function isPhantomId(id: string): boolean {
  return id.startsWith(PHANTOM_PREFIX)
}
