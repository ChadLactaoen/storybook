import type { LKey, LNode, LayeredGraph, LayoutConfig } from './types'

/**
 * X-coordinate assignment for one component: a bottom-up rigid-subtree pass,
 * Reingold–Tilford adapted to a layered DAG.
 *
 * The rule this exists to hold is "a parent sits exactly between its outermost
 * children". The previous priority-relaxation could only redistribute whatever
 * slack compact packing happened to leave, so a node walled in by a dummy chain
 * — dummies were placed first and froze — could never reach its children's
 * midpoint no matter how far off it was. Here a subtree is positioned as a unit
 * and siblings are pushed apart by exactly the amount needed, so the space is
 * manufactured rather than borrowed, and re-centring a node automatically
 * re-centres every ancestor above it.
 *
 * The guarantee is exact for a tree. It is not, and cannot be, exact once a
 * passage has two parents: such a node hangs off one of them in the layout
 * forest, and `enforceOrder` may then have to slide it to keep the within-layer
 * order `ordering.ts` chose. Merges are common in a story, so treat the rule as
 * "exact for trees, best effort elsewhere".
 */
export function tidyComponent(lg: LayeredGraph, layers: LKey[][], cfg: LayoutConfig): void {
  const left = candidate(lg, layers, cfg, false)
  const right = candidate(lg, layers, cfg, true)

  // Align the two candidates by their extents, then average. Both satisfy the
  // same separation constraints in the same layer order, and a convex
  // combination of two feasible solutions is feasible — so non-overlap survives
  // exactly, with no epsilon. Midpoint-of-extremes is affine and both passes
  // agree on which child is outermost, so a parent centred in both stays exactly
  // centred in the average; only the nodes the two passes disagree about move,
  // and they split the difference.
  const span = (xs: Map<LKey, number>) => {
    let min = Infinity
    let max = -Infinity
    for (const layer of layers) {
      for (const k of layer) {
        const n = lg.nodes.get(k)!
        const x = xs.get(k)!
        min = Math.min(min, x - n.width / 2)
        max = Math.max(max, x + n.width / 2)
      }
    }
    return { min, max, width: max - min }
  }
  const l = span(left)
  const r = span(right)
  if (!Number.isFinite(l.min) || !Number.isFinite(r.min)) return
  // Anchor on the narrower candidate, the way Brandes–Köpf balances its own.
  const narrow = l.width <= r.width ? l : r
  const dl = narrow.min - l.min
  const dr = narrow.max - r.max

  for (const layer of layers) {
    for (const k of layer) {
      lg.nodes.get(k)!.x = (left.get(k)! + dl + (right.get(k)! + dr)) / 2
    }
  }
}

/**
 * One pass, optionally mirrored.
 *
 * The mirrored pass is the same routine fed reversed layers and negated back,
 * rather than a second right-biased implementation — `sep` is symmetric, so
 * symmetry is structural instead of something two code paths have to agree on.
 * It is what places the merge point of a diamond: the forest hangs a two-parent
 * node off its leftmost parent one way round and its rightmost the other, so the
 * average lands it between them.
 */
function candidate(
  lg: LayeredGraph,
  layers: LKey[][],
  cfg: LayoutConfig,
  mirror: boolean,
): Map<LKey, number> {
  sweep(lg, mirror ? layers.map((layer) => [...layer].reverse()) : layers, cfg, mirror)
  const out = new Map<LKey, number>()
  for (const layer of layers) {
    for (const k of layer) out.set(k, mirror ? -lg.nodes.get(k)!.x : lg.nodes.get(k)!.x)
  }
  return out
}

function sweep(lg: LayeredGraph, layers: LKey[][], cfg: LayoutConfig, mirror: boolean): void {
  const sep = (a: LNode, b: LNode) =>
    a.width / 2 + b.width / 2 + (a.kind === 'real' && b.kind === 'real' ? cfg.nodeGap : cfg.edgeGap)

  const { roots, childrenOf } = spanningForest(lg, layers)
  // Root subtrees are packed in the order they are found, so the mirrored pass
  // has to walk them backwards: otherwise the two candidates put a root that is
  // not on the top layer — one carrying `levelOffset`, or an isolated fragment —
  // on opposite sides of the drawing, and averaging two contradictory
  // arrangements lands nodes nowhere near either.
  if (mirror) roots.reverse()

  // Preorder listing: a parent always precedes its children, so walking it
  // backwards visits every child before its parent.
  const preorder: LKey[] = []
  const stack = [...roots]
  while (stack.length > 0) {
    const k = stack.pop()!
    preorder.push(k)
    const kids = childrenOf.get(k)
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!)
  }

  const contourOf = new Map<LKey, Contour>()
  const offsetsOf = new Map<LKey, number[]>()

  for (let i = preorder.length - 1; i >= 0; i--) {
    const key = preorder[i]!
    const node = lg.nodes.get(key)!
    const kids = childrenOf.get(key)

    if (!kids) {
      contourOf.set(key, leafContour(key, node))
      continue
    }

    // The first child's contour becomes the accumulator rather than being copied
    // into a fresh one. That is what keeps a long unbranched passage chain — the
    // shape a linear story has — linear rather than quadratic.
    const acc = contourOf.get(kids[0]!)!
    contourOf.delete(kids[0]!)
    const offsets: number[] = [0]
    for (let j = 1; j < kids.length; j++) {
      const sub = contourOf.get(kids[j]!)!
      const shift = requiredShift(acc, sub, lg, sep)
      absorb(acc, sub, shift, lg)
      contourOf.delete(kids[j]!)
      offsets.push(shift)
    }
    // Every sibling has a node on the layer just below their shared parent, so
    // each shift clears the one before it and the offsets strictly increase:
    // the first is 0 and the last is the widest.
    const mid = offsets[offsets.length - 1]! / 2
    for (let j = 0; j < offsets.length; j++) offsets[j] = offsets[j]! - mid
    acc.dx -= mid
    // The parent sits one layer above the run its children cover.
    grow(acc, Math.min(acc.lo, node.layer), Math.max(acc.hi, node.layer))
    include(acc, key, node, 0, lg)
    offsetsOf.set(key, offsets)
    contourOf.set(key, acc)
  }

  // Pack root subtrees left to right with the same contour walk.
  let packed: Contour | null = null
  const rootX = new Map<LKey, number>()
  for (const root of roots) {
    const sub = contourOf.get(root)!
    if (packed === null) {
      rootX.set(root, 0)
      packed = sub
      continue
    }
    const shift = requiredShift(packed, sub, lg, sep)
    absorb(packed, sub, shift, lg)
    rootX.set(root, shift)
  }

  for (const root of roots) {
    lg.nodes.get(root)!.x = rootX.get(root)!
    const walk: LKey[] = [root]
    while (walk.length > 0) {
      const key = walk.pop()!
      const x = lg.nodes.get(key)!.x
      const kids = childrenOf.get(key)
      if (!kids) continue
      const offsets = offsetsOf.get(key)!
      for (let j = 0; j < kids.length; j++) {
        lg.nodes.get(kids[j]!)!.x = x + offsets[j]!
        walk.push(kids[j]!)
      }
    }
  }

  enforceOrder(lg, layers, sep)
}

/**
 * Restore the within-layer order `ordering.ts` chose, pushing right only.
 *
 * A no-op for a tree, where the forest and the layer order agree. Where they
 * cannot agree — a node with two parents, or a root pushed down a level — this
 * is what keeps minimum separation and the crossing-minimised order intact, at
 * the cost of the centring of whatever it moves.
 */
function enforceOrder(lg: LayeredGraph, layers: LKey[][], sep: (a: LNode, b: LNode) => number): void {
  for (const layer of layers) {
    for (let i = 1; i < layer.length; i++) {
      const left = lg.nodes.get(layer[i - 1]!)!
      const right = lg.nodes.get(layer[i]!)!
      const min = left.x + sep(left, right)
      if (right.x < min) right.x = min
    }
  }
}

/**
 * A canonical spanning forest of the component.
 *
 * A node with several parents can only hang off one of them; it takes the
 * leftmost. Every parent of a node sits on the layer above at a distinct index,
 * so comparing those indices is already a total order — no tiebreak is needed
 * and none is reachable.
 */
function spanningForest(lg: LayeredGraph, layers: LKey[][]) {
  const orderOf = new Map<LKey, number>()
  for (const layer of layers) {
    for (let i = 0; i < layer.length; i++) orderOf.set(layer[i]!, i)
  }

  const roots: LKey[] = []
  const childrenOf = new Map<LKey, LKey[]>()

  // Layers walk top to bottom and left to right, so each parent's children are
  // appended in their own layer order and need no further sorting.
  for (const layer of layers) {
    for (const key of layer) {
      const parents = lg.segsIn.get(key) ?? []
      if (parents.length === 0) {
        roots.push(key)
        continue
      }
      let best = parents[0]!
      let bestRank = orderOf.get(best) ?? Number.MAX_SAFE_INTEGER
      for (let i = 1; i < parents.length; i++) {
        const candidateKey = parents[i]!
        const rank = orderOf.get(candidateKey) ?? Number.MAX_SAFE_INTEGER
        if (rank < bestRank) {
          best = candidateKey
          bestRank = rank
        }
      }
      const kids = childrenOf.get(best)
      if (kids) kids.push(key)
      else childrenOf.set(best, [key])
    }
  }

  return { roots, childrenOf }
}

/**
 * The leftmost and rightmost node of a subtree at each layer it covers, with
 * centre x relative to the subtree root.
 *
 * A subtree occupies a contiguous run of layers, so the arrays are dense over
 * `[lo, hi]` and hold only that run — a leaf's is one slot long, not one slot
 * per layer in the story. `dx` is a translation owed to every entry, which is
 * what makes moving a whole subtree O(1) instead of a rewrite of its contour.
 */
interface Contour {
  lo: number
  hi: number
  dx: number
  loKey: LKey[]
  loX: number[]
  hiKey: LKey[]
  hiX: number[]
}

function leafContour(key: LKey, node: LNode): Contour {
  return {
    lo: node.layer,
    hi: node.layer,
    dx: 0,
    loKey: [key],
    loX: [0],
    hiKey: [key],
    hiX: [0],
  }
}

/** How far `next` must move right to clear `acc` on every layer they share. */
function requiredShift(
  acc: Contour,
  next: Contour,
  lg: LayeredGraph,
  sep: (a: LNode, b: LNode) => number,
): number {
  const from = Math.max(acc.lo, next.lo)
  const to = Math.min(acc.hi, next.hi)
  let need = 0
  let found = false
  for (let l = from; l <= to; l++) {
    const right = acc.hiKey[l - acc.lo]
    const left = next.loKey[l - next.lo]
    // Packing two roots that start on different layers can leave a layer
    // covered by the run but occupied by neither; nothing to clear there.
    if (right === undefined || left === undefined) continue
    const want =
      acc.hiX[l - acc.lo]! +
      acc.dx +
      sep(lg.nodes.get(right)!, lg.nodes.get(left)!) -
      (next.loX[l - next.lo]! + next.dx)
    if (!found || want > need) {
      need = want
      found = true
    }
  }
  return found ? need : 0
}

/** Fold `next`, displaced by `shift`, into `acc`. */
function absorb(acc: Contour, next: Contour, shift: number, lg: LayeredGraph): void {
  grow(acc, Math.min(acc.lo, next.lo), Math.max(acc.hi, next.hi))
  for (let l = next.lo; l <= next.hi; l++) {
    const j = l - next.lo
    const lo = next.loKey[j]
    if (lo === undefined) continue
    const hi = next.hiKey[j]!
    include(acc, lo, lg.nodes.get(lo)!, next.loX[j]! + next.dx + shift, lg)
    include(acc, hi, lg.nodes.get(hi)!, next.hiX[j]! + next.dx + shift, lg)
  }
}

/** Widen the covered layer run, keeping existing entries at their layer. */
function grow(acc: Contour, lo: number, hi: number): void {
  if (lo === acc.lo && hi === acc.hi) return
  const size = hi - lo + 1
  const loKey = new Array<LKey>(size)
  const loX = new Array<number>(size)
  const hiKey = new Array<LKey>(size)
  const hiX = new Array<number>(size)
  for (let l = acc.lo; l <= acc.hi; l++) {
    const from = l - acc.lo
    const to = l - lo
    loKey[to] = acc.loKey[from]!
    loX[to] = acc.loX[from]!
    hiKey[to] = acc.hiKey[from]!
    hiX[to] = acc.hiX[from]!
  }
  acc.lo = lo
  acc.hi = hi
  acc.loKey = loKey
  acc.loX = loX
  acc.hiKey = hiKey
  acc.hiX = hiX
}

/**
 * Take in one node sitting at absolute `x`. `acc` must already cover its layer.
 */
function include(acc: Contour, key: LKey, node: LNode, x: number, lg: LayeredGraph): void {
  const j = node.layer - acc.lo
  const stored = x - acc.dx
  const lo = acc.loKey[j]
  if (lo === undefined || stored - node.width / 2 < acc.loX[j]! - lg.nodes.get(lo)!.width / 2) {
    acc.loKey[j] = key
    acc.loX[j] = stored
  }
  const hi = acc.hiKey[j]
  if (hi === undefined || stored + node.width / 2 > acc.hiX[j]! + lg.nodes.get(hi)!.width / 2) {
    acc.hiKey[j] = key
    acc.hiX[j] = stored
  }
}
