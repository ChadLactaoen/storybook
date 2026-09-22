import { alignCandidates } from './candidates'
import { separation } from './constants'
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
 * "exact for trees, best effort elsewhere". What a slide costs is the slid
 * node's position relative to the parent it does *not* hang off; it carries its
 * own subtree, so nothing below it pays, and `recentre` walks back up so
 * nothing above it pays either.
 *
 * That last part is the whole reason `recentre` exists. A slide moves a node
 * the placement walk had already centred its parent over, and the walk never
 * revisits anyone — so before, an *unrelated* branch beside the merge ended up
 * sitting over its left child rather than between the two, and the error
 * climbed as far as the root. Both directions appear on screen because
 * `tidyComponent` averages a normal and a mirrored pass, and the mirrored one
 * pushes left in real space.
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
  //
  // The lining-up is `candidates.ts`, shared with `straight.ts`, which runs
  // four passes and takes the middle two instead of averaging. The measuring
  // and the anchoring are identical in both and the feasibility argument above
  // is what rests on them, so they are defined once.
  const keys: LKey[] = []
  for (const layer of layers) for (const k of layer) keys.push(k)
  const aligned = alignCandidates(lg, keys, [
    { xs: left, anchor: 'min' },
    { xs: right, anchor: 'max' },
  ])
  if (!aligned) return

  for (const k of keys) lg.nodes.get(k)!.x = (left.get(k)! + right.get(k)!) / 2
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
  const sep = separation(cfg)

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

  enforceOrder(lg, layers, sep, childrenOf)
  recentre(lg, layers, sep, childrenOf, cfg)
}

/**
 * Restore the within-layer order `ordering.ts` chose, pushing right only.
 *
 * A no-op for a tree, where the forest and the layer order agree. Where they
 * cannot agree — a node with two parents, or a root pushed down a level — this
 * is what keeps minimum separation and the crossing-minimised order intact, at
 * the cost of where the node it moves sits relative to its other parent.
 *
 * It moves that node's subtree with it, and that is the whole point. The walk
 * above places a child at `parent.x + offset` and then never revisits it, so
 * sliding a node on its own left everything beneath it behind, still centred on
 * an x its parent had vacated — a branch's endings stranded under an unrelated
 * subtree, with the edges reaching across the drawing to find them. A sibling
 * link is what produces that shape in practice: it pushes its destination down
 * a level, which is exactly how a passage acquires the second parent the forest
 * cannot honour.
 *
 * Translating rigidly is safe because layers are walked top down and every
 * shift is rightward: a descendant moved here is re-checked when its own layer
 * comes up, and can only be pushed further right, never back into the node
 * behind it. A dummy is carried like any other node — declining to would strand
 * the target subtree exactly as this exists to prevent, one layer further down.
 *
 * It does cost width where a slide happens at every layer: a chain in which
 * *every* passage carries a skip link into it draws about 60% wider, because
 * each shift now propagates down the rest of the chain instead of kinking one
 * edge. Measured against the shapes stories actually have — trees, branch and
 * merge, a hub with returns, skip links at any density below every passage —
 * the drawing is unchanged to the pixel.
 */
function enforceOrder(
  lg: LayeredGraph,
  layers: LKey[][],
  sep: (a: LNode, b: LNode) => number,
  childrenOf: Map<LKey, LKey[]>,
): void {
  for (const layer of layers) {
    for (let i = 1; i < layer.length; i++) {
      const left = lg.nodes.get(layer[i - 1]!)!
      const right = lg.nodes.get(layer[i]!)!
      const min = left.x + sep(left, right)
      if (right.x < min) {
        const dx = min - right.x
        // Assigned, not `+= dx`: `tidyComponent` averages two feasible solutions
        // and claims non-overlap survives with no epsilon, which rests on this
        // landing exactly on `min`. Only the descendants take the addition.
        right.x = min
        shiftDescendants(lg, childrenOf, layer[i]!, dx)
      }
    }
  }
}

/**
 * Put every parent back on the midpoint of its outermost children, bottom up.
 *
 * `enforceOrder` moves a node and the subtree under it. It cannot move the
 * node's *parent* — that parent sits on a layer already walked, and pushing it
 * would break the separation just settled there. So the parent keeps the x the
 * placement walk gave it, which was the midpoint of positions its children have
 * since vacated. One slide near the bottom of a deep story therefore leaves
 * every ancestor above it off-centre, and a branch with no connection to the
 * merge that caused the slide drifts with it.
 *
 * Walking deepest layer first is what makes a single pass enough. Children
 * always sit one layer down — segments only ever join adjacent layers — so by
 * the time a layer is reached everything below it is final, and moving it
 * cannot reach back down. The layer above is then read against final positions
 * in its turn.
 *
 * It is a no-op wherever the drawing was already right, and the guarantee is
 * per *layer*, not per story. Straight out of the placement walk a parent sits
 * exactly on `(firstChild.x + lastChild.x) / 2`, so on any layer `enforceOrder`
 * left alone every node already wants precisely where it is and `place` writes
 * nothing at all — which is what keeps this off the drawings that never needed
 * it, `compat.test.ts`'s recorded baseline among them.
 *
 * It is worth saying what that does *not* promise, because the stronger version
 * is tempting and wrong: a story drawn without a single crossing can still
 * slide. `enforceOrder` runs on every component — `orderComponent`'s early
 * return skips the crossing sweeps, not this — and a zero-crossing seed need
 * not agree with the forest anyway, since `spanningForest` hangs a node with
 * two parents off its leftmost one while the seed puts it wherever DFS reached
 * it first. `{ T0: ['T4'], T2: ['T3','T7'], T4: ['T1'], T5: ['T2','T1'] }`
 * draws at zero crossings, slides twice, and is re-centred here.
 *
 * Forest children, not every child in the graph. The forest is the relation the
 * placement walk positioned by, so this is the exact inverse of that walk's own
 * error and nothing else. Reading `segsOut` instead would re-centre parents the
 * walk never claimed to have centred — in a plain diamond it would drag both
 * branches inward onto the merge point — which is a different drawing, not a
 * repair of this one.
 */
function recentre(
  lg: LayeredGraph,
  layers: LKey[][],
  sep: (a: LNode, b: LNode) => number,
  childrenOf: Map<LKey, LKey[]>,
  cfg: LayoutConfig,
): void {
  for (let l = layers.length - 1; l >= 0; l--) {
    const layer = layers[l]!
    if (layer.length === 0) continue

    const want = new Array<number>(layer.length)
    for (let i = 0; i < layer.length; i++) {
      const key = layer[i]!
      const kids = childrenOf.get(key)
      if (kids === undefined || kids.length === 0) {
        // Nothing below to centre on, so it wants to stay exactly where it is.
        want[i] = lg.nodes.get(key)!.x
        continue
      }
      // Seeded from the first child rather than from +/-Infinity: `x < lo` and
      // `x > hi` are both false for a NaN, so sentinels would survive one and
      // `(lo + hi) / 2` would be NaN — which nothing downstream throws on, and
      // which would reach the canvas as `M NaN NaN`.
      let lo = lg.nodes.get(kids[0]!)!.x
      let hi = lo
      for (const k of kids) {
        const x = lg.nodes.get(k)!.x
        if (x < lo) lo = x
        if (x > hi) hi = x
      }
      // Centres, not extents: the placement walk centres on `offsets[last] / 2`,
      // and `offsets` are centre offsets. Measuring the outermost *edges* here
      // would fight it wherever a dummy, which has no width, is outermost.
      want[i] = (lo + hi) / 2
    }

    place(lg, layer, want, sep, cfg)
  }
}

/**
 * Pull a layer toward `want`, as far as its own order and separations allow.
 *
 * Two strategies, and `LayoutConfig.packing` picks between them. They differ
 * only in what a node may do when the neighbour ahead is in its way:
 * `balanced` stops there, `aligned` shoves it along. Everything below describes
 * `balanced`, which is the default and the one whose guarantees hold; the
 * `aligned` branch at the top of the function states where it departs from
 * them, and it departs from most of them.
 *
 * `balanced`: one sweep, right to left, moving a node only rightward and never past its
 * target. Right to left so that each node is clamped against the neighbour it
 * could collide with *after* that neighbour has been handled, which lets a run
 * of nodes all wanting the same way clear its own path. No epsilon is involved
 * and nothing needs rechecking afterwards: moving a node right can only widen
 * the gap to the neighbour on its left.
 *
 * Rightward only, and that is structural rather than lucky. `enforceOrder`
 * pushes right and carries the whole forest subtree, so a slid parent and its
 * children move by one delta and the parent's target moves with it; a child
 * gains ground on its parent only by being slid again at its own layer, which
 * moves the target further right still. `recentre` then only ever moves nodes
 * right itself, so the property survives as it climbs. A left sweep was written
 * for symmetry and instrumented: it was wanted 0 times in some 10,500
 * opportunities across the 224-passage fixture and 400 random stories, so it
 * was deleted rather than left as a path no test could reach. Teach
 * `enforceOrder` a leftward push — the obvious answer to the width it costs —
 * and this needs one back, clamped against `i - 1` instead.
 *
 * The restriction is the point, and it is why this is not a least-squares
 * projection of the whole layer. Projecting minimises the layer's *total* error
 * and will happily drag a node that was sitting exactly on its children's
 * midpoint several units off it to buy a larger correction next door. But the
 * rule being kept is per-parent, not aggregate: a card that was right and is
 * now wrong is a new defect, however small, and trading one for another is not
 * a repair. Here a node is touched only when it is already off its target, and
 * never moved past that target.
 *
 * Which is a claim about one layer against fixed children, and not one about
 * the drawing — do not read it as the stronger thing. Re-centring a layer moves
 * the children the layer above is measured against, so a parent `enforceOrder`
 * happened to leave on its old midpoint can find the midpoint has moved out
 * from under it, and be blocked from following. Worse, `tidyComponent` averages
 * two candidates whose forests disagree — `spanningForest` hangs a two-parent
 * node off its leftmost parent one way round and its rightmost the other — so
 * each candidate is re-centred against a different relation and the average is
 * a fixed point of neither.
 *
 * So this is a quality trade, not a pure win, and the numbers only mean
 * anything with the metric named. Counting passages on the 224-passage fixture
 * whose children *all* have exactly one parent — the only ones for which the
 * forest and the graph agree, so the only ones where "off its midpoint" is
 * unambiguous — the worst improves from 384 units to 256 while the count of
 * them rises from seven to eight. Sampling the drawn curves rather than the
 * waypoints, wires passing through a card they do not belong to go from 31 to
 * 35. Both are worth paying here: what they buy is that no branch *unrelated*
 * to a merge drifts any more, which is the defect authors actually see and
 * report. The leftovers are held by a neighbour with nowhere to go, which is
 * why one pass is already a fixed point — running it four times is
 * byte-identical — and why no iteration budget would buy anything.
 *
 * Pulling one way is a bias, and the same one the rest of this module has: the
 * mirrored candidate runs over a reversed layer, so "right" there is left in
 * real space and `tidyComponent` averages the disagreement, exactly as it does
 * for the merge point of a diamond.
 */
function place(
  lg: LayeredGraph,
  layer: readonly LKey[],
  want: readonly number[],
  sep: (a: LNode, b: LNode) => number,
  cfg: LayoutConfig,
): void {
  const n = layer.length

  // `aligned`: a node takes the further of its own target and whatever the
  // neighbour behind it now demands, so it shoves the run ahead rather than
  // stopping at it. See the note above `place` for what that costs.
  if (cfg.packing === 'aligned') {
    for (let i = 0; i < n; i++) {
      const node = lg.nodes.get(layer[i]!)!
      let target = want[i]!
      if (i > 0) {
        const left = lg.nodes.get(layer[i - 1]!)!
        const floor = left.x + sep(left, node)
        if (floor > target) target = floor
      }
      if (target > node.x) node.x = target
    }
    return
  }

  for (let i = n - 1; i >= 0; i--) {
    const node = lg.nodes.get(layer[i]!)!
    if (want[i]! <= node.x) continue
    if (i === n - 1) {
      node.x = want[i]!
      continue
    }
    const right = lg.nodes.get(layer[i + 1]!)!
    node.x = Math.min(want[i]!, right.x - sep(node, right))
  }
}

/** Translate everything hanging off `key` in the forest, but not `key` itself. */
function shiftDescendants(
  lg: LayeredGraph,
  childrenOf: Map<LKey, LKey[]>,
  key: LKey,
  dx: number,
): void {
  const stack: LKey[] = [...(childrenOf.get(key) ?? [])]
  while (stack.length > 0) {
    const k = stack.pop()!
    lg.nodes.get(k)!.x += dx
    const kids = childrenOf.get(k)
    if (kids) for (const c of kids) stack.push(c)
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
