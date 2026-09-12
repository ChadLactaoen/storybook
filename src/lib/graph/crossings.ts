import type { LKey, LayeredGraph } from './types'

/**
 * Bilayer crossing count via the Barth-Juenger-Mutzel accumulator tree,
 * O(E log |south|). Cheap enough to call after every sweep, which is what makes
 * "keep the best ordering seen" affordable.
 */
export function countBilayerCrossings(
  north: readonly LKey[],
  south: readonly LKey[],
  lg: LayeredGraph,
): number {
  const q = south.length
  if (q === 0 || north.length === 0) return 0

  const pos = new Map<LKey, number>()
  for (let i = 0; i < q; i++) pos.set(south[i]!, i)

  const sequence: number[] = []
  for (const n of north) {
    const targets: number[] = []
    for (const t of lg.segsOut.get(n) ?? []) {
      const p = pos.get(t)
      if (p !== undefined) targets.push(p)
    }
    targets.sort((a, b) => a - b)
    for (const t of targets) sequence.push(t)
  }
  if (sequence.length === 0) return 0

  let firstIndex = 1
  while (firstIndex < q) firstIndex *= 2
  const treeSize = 2 * firstIndex - 1
  firstIndex -= 1
  const tree = new Array<number>(treeSize).fill(0)

  let crossings = 0
  for (const k of sequence) {
    let index = k + firstIndex
    tree[index]!++
    while (index > 0) {
      if (index % 2) crossings += tree[index + 1]!
      index = (index - 1) >> 1
      tree[index]!++
    }
  }
  return crossings
}

/** Total crossings across every adjacent layer pair, summed over components. */
export function countCrossings(lg: LayeredGraph): number {
  let total = 0
  for (let c = 0; c < lg.componentCount; c++) {
    const layers = lg.compLayers[c]!
    for (let l = 0; l + 1 < layers.length; l++) {
      total += countBilayerCrossings(layers[l]!, layers[l + 1]!, lg)
    }
  }
  return total
}
