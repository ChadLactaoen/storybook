import type { LKey, LayeredGraph } from './types'

/**
 * Lining several candidate placements up so they can be combined.
 *
 * Both x-coordinate assignments work the same way at the end: run the placement
 * more than once with the bias pointed in different directions, then combine
 * the answers so that no direction wins. `tidy.ts` runs two passes and averages
 * them; `straight.ts` runs four and takes each card's middle two. What they
 * share is everything *before* the combining — measuring each candidate's
 * extent, choosing which one the others are lined up against, and shifting them
 * onto it — and that part was written out twice before this existed.
 *
 * It is worth one definition rather than two because the combining step's
 * correctness rests on it. Both modules argue that their combination cannot
 * produce an overlap, and both arguments need every candidate to satisfy the
 * same separations in the same layer order; a translation preserves that, and a
 * half-width read differently in one of the two copies would not.
 *
 * `xcoord.ts`'s extent walk is deliberately *not* folded in here. It looks the
 * same and is a different question — where a finished component sits, so the
 * next one can be packed beside it — and it runs once per component rather than
 * once per candidate.
 */

export interface Span {
  min: number
  max: number
  width: number
}

/** The drawing's extent under `xs`, measured from card edges rather than centres. */
export function spanOf(lg: LayeredGraph, keys: readonly LKey[], xs: Map<LKey, number>): Span {
  let min = Infinity
  let max = -Infinity
  for (const k of keys) {
    const half = lg.nodes.get(k)!.width / 2
    const x = xs.get(k)!
    if (x - half < min) min = x - half
    if (x + half > max) max = x + half
  }
  return { min, max, width: max - min }
}

export interface Candidate {
  xs: Map<LKey, number>
  /**
   * Which edge this candidate is lined up by.
   *
   * A pass that packed leftward has its slack on the right, so its left edge is
   * the real one and `min` is what to trust; a rightward pass is the mirror.
   * Anchoring both by the same edge would compare a drawing against its own
   * translation and read the difference as disagreement.
   */
  anchor: 'min' | 'max'
}

/**
 * Shift every candidate onto the narrowest one, in place.
 *
 * The narrowest is the reference because it is the one whose room is real — the
 * others have slack somewhere, and hanging them off the widest would spread
 * that slack through whatever is computed next. A tie keeps the earliest, which
 * is what makes the choice independent of how the candidates were generated.
 *
 * Returns false and touches nothing when a candidate has no finite extent,
 * which is an empty component: there is nothing to line up and the caller
 * should leave the coordinates alone.
 */
export function alignCandidates(
  lg: LayeredGraph,
  keys: readonly LKey[],
  candidates: readonly Candidate[],
): boolean {
  if (keys.length === 0 || candidates.length === 0) return false

  const spans = candidates.map((c) => spanOf(lg, keys, c.xs))
  for (const s of spans) if (!Number.isFinite(s.min) || !Number.isFinite(s.max)) return false

  let narrow = 0
  for (let i = 1; i < spans.length; i++) if (spans[i]!.width < spans[narrow]!.width) narrow = i
  const ref = spans[narrow]!

  for (let i = 0; i < candidates.length; i++) {
    const shift = candidates[i]!.anchor === 'max' ? ref.max - spans[i]!.max : ref.min - spans[i]!.min
    if (shift === 0) continue
    const xs = candidates[i]!.xs
    for (const k of keys) xs.set(k, xs.get(k)! + shift)
  }
  return true
}
