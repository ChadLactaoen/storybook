import { alignCandidates } from './candidates'
import { separation } from './constants'
import type { LKey, LNode, LayeredGraph, LayoutConfig } from './types'

/**
 * X-coordinate assignment for one component: Brandes–Köpf.
 *
 * `tidy.ts` draws a story by building a spanning forest and walking it. That
 * forest is where its bias comes from, and the bias is the thing this module
 * exists to remove. Three choices in there all point the same way:
 * `spanningForest` hangs a passage with several parents off its **leftmost**
 * one, `enforceOrder` only ever pushes **right**, and `place` only ever moves a
 * card **right** — `balanced` stopping at the neighbour ahead and `aligned`
 * shoving through it, which is the whole of the difference between those two
 * settings.
 *
 * `tidyComponent` tries to cancel that by averaging a mirrored pass, and on a
 * tree it succeeds exactly. On a merge it cannot, because the mirrored pass
 * builds a *different forest* — rightmost parent rather than leftmost — so it
 * is not the same problem solved the other way round, it is a second problem,
 * and the average is a fixed point of neither. Which side of a drawing comes
 * out well then depends on which side the slack happened to be on, which is why
 * one setting can look right down the left of a story and wrong down the right
 * while the other does the reverse.
 *
 * Two more, independent of direction, decide where a heavily merged passage
 * lands. `recentre` aims a parent at `(min + max) / 2` of its children — the
 * midpoint of the *extremes*, so two far-apart bend points outvote six
 * clustered ones — and it reads forest children only, never parents, so a card
 * at the bottom of a branch has no target at all and simply stays where the
 * walk dropped it.
 *
 * Brandes–Köpf has none of those parts. There is no forest, no sweep direction
 * and no repair pass. Each node is *aligned* with the median of its neighbours
 * on the adjacent layer, aligned nodes form vertical blocks, and the blocks are
 * packed as tightly as the layer order allows. That is run four times — once
 * per (upward, downward) × (leftward, rightward) — and the four answers are
 * combined. The symmetry is structural: no pass is privileged, so no side of
 * the drawing is either.
 *
 * What it buys is what the name says. A child sits *directly under* a parent
 * rather than near the average of several, long edges come out straight, and
 * the answer no longer depends on which half of the canvas a passage is in.
 *
 * What it costs is some width, and — this is the part worth knowing before
 * choosing it — the rule the rest of the drawing code is built around.
 *
 * On width it sits between the other two rather than above them, which is worth
 * saying because the opposite is the natural guess: holding a block vertical
 * needs room, so surely it is the widest. Measured, it is wider than `balanced`
 * on 279 of 300 generated stories, and *narrower* than `aligned` on most — of
 * those 300, `aligned` was the widest on 224 and this on 73. Which of the two
 * is widest depends on the story's shape, so neither can be described as the
 * wide one; only `balanced` is reliably the narrow one.
 *
 * The rule is the real cost. `tidy.ts` puts a parent on **the midpoint of its
 * outermost children**. This puts it on **the median one**. Those agree whenever the children are evenly spread, and part
 * company as soon as they are not: a passage with five choices whose third
 * branch runs wide sits over that third branch here, where `balanced` would
 * centre it over the whole fan. Neither is a mistake — they are answers to
 * different questions, and no assignment gives both, because a parent cannot be
 * vertically above one child and horizontally between all of them at once.
 *
 * So `straight` is not a strictly better `balanced`, and a story with no merges
 * in it is *not* drawn identically: a lopsided fan visibly moves. What it is
 * better at is the thing it was added for — a passage reached from several
 * others, which `tidy.ts` can only hang off one of them and then try to repair.
 * `layout.test.ts` pins both halves of that, the gain and the cost.
 */

interface Oriented {
  /** Layers in this pass's direction: [0] is the one placed first. */
  layers: LKey[][]
  /** Index within its own layer. */
  pos: Map<LKey, number>
  /**
   * Neighbours on the preceding layer, ascending by `pos`.
   *
   * "Preceding" in this pass's direction, so these are a node's parents on a
   * downward pass and its children on an upward one. Duplicates are kept: two
   * links to one passage are two segments, and they pull twice.
   */
  prev: Map<LKey, LKey[]>
}

/**
 * The four passes, as a transform of the input rather than four routines.
 *
 * `vFlip` reverses the layer order and swaps parents for children; `hFlip`
 * reverses each layer, and the result is negated back at the end. Everything
 * downstream is written once, for one direction, and cannot drift out of
 * agreement with its own mirror — the same reason `tidy.ts` mirrors its input
 * instead of writing a second right-biased pass.
 */
function orient(lg: LayeredGraph, base: LKey[][], vFlip: boolean, hFlip: boolean): Oriented {
  const layers = (vFlip ? [...base].reverse() : base).map((l) => (hFlip ? [...l].reverse() : [...l]))
  const pos = new Map<LKey, number>()
  for (const layer of layers) {
    for (let j = 0; j < layer.length; j++) pos.set(layer[j]!, j)
  }

  const src = vFlip ? lg.segsOut : lg.segsIn
  const prev = new Map<LKey, LKey[]>()
  for (const layer of layers) {
    for (const k of layer) {
      // `pos` is total within a layer and segments only ever join adjacent
      // layers, so this comparator never needs a tiebreak and never leans on
      // sort stability. Equal entries are the duplicate case, and they are
      // interchangeable.
      const ns = [...(src.get(k) ?? [])].sort((a, b) => pos.get(a)! - pos.get(b)!)
      prev.set(k, ns)
    }
  }
  return { layers, pos, prev }
}

const pairKey = (a: LKey, b: LKey) => `${a}\u0000${b}`

/**
 * Type-1 conflicts: a segment between two dummies crossed by a segment that
 * touches a real card.
 *
 * A dummy chain is one long edge in the middle of being drawn, so a run of them
 * wants to come out as a straight line. Where a link to a real passage would
 * cross one, something has to give, and it is the link to the passage — marked
 * here, and then refused as an alignment below. That preference is the reason
 * a long edge threading past a branch draws as a line rather than a kink.
 *
 * Marks are per orientation, because which segments are "inner" and which layer
 * precedes which both change with the pass. Recomputing is a walk of the layer;
 * caching one set and reusing it across the four would attach a guard to the
 * wrong segment, which is the failure that produces a confident-looking drawing
 * of something the story does not say.
 */
function markConflicts(o: Oriented, lg: LayeredGraph): Set<string> {
  const marked = new Set<string>()
  const isDummy = (k: LKey) => lg.nodes.get(k)!.kind === 'dummy'
  const innerPrev = (v: LKey): LKey | null => {
    if (!isDummy(v)) return null
    for (const u of o.prev.get(v)!) if (isDummy(u)) return u
    return null
  }

  for (let i = 1; i < o.layers.length; i++) {
    const upper = o.layers[i - 1]!
    const lower = o.layers[i]!
    let k0 = 0
    let l = 0
    for (let l1 = 0; l1 < lower.length; l1++) {
      const inner = innerPrev(lower[l1]!)
      // Scan forward to the next inner segment, or to the end of the layer.
      // Everything between two of them may only align inside the window those
      // two cut out; anything reaching outside it crosses one.
      if (inner === null && l1 !== lower.length - 1) continue
      const k1 = inner !== null ? o.pos.get(inner)! : upper.length - 1
      for (; l <= l1; l++) {
        const w = lower[l]!
        for (const u of o.prev.get(w)!) {
          const k = o.pos.get(u)!
          if (k < k0 || k > k1) marked.add(pairKey(u, w))
        }
      }
      k0 = k1
    }
  }
  return marked
}

/**
 * Align each node with the median of its neighbours on the preceding layer, and
 * read the result off as blocks.
 *
 * The median, not the midpoint of the extremes, and that is the substantive
 * difference from `recentre`. Six parents in a cluster and two bend points far
 * out to either side give a midpoint nowhere near any of them; the median is
 * one of the six. An even count has two medians and both are tried, leftmost
 * first — which is exactly the choice `hFlip` reverses, so the pair of passes
 * splits a tie rather than one of them winning it.
 *
 * `r` is what keeps blocks from crossing: a node may only align with a
 * neighbour further along than the last one claimed, so within a layer the
 * blocks stay in the layer's own order. That is what makes the block graph
 * `compact` walks acyclic, and it is the reason this can be a plain sweep with
 * no backtracking.
 *
 * `root` names each block by its first node; `align` is the cycle through it.
 */
function alignBlocks(o: Oriented, marked: Set<string>): Map<LKey, LKey> {
  const root = new Map<LKey, LKey>()
  const align = new Map<LKey, LKey>()
  for (const layer of o.layers) {
    for (const v of layer) {
      root.set(v, v)
      align.set(v, v)
    }
  }

  for (let i = 1; i < o.layers.length; i++) {
    let r = -1
    for (const v of o.layers[i]!) {
      const ns = o.prev.get(v)!
      const d = ns.length
      if (d === 0) continue
      const lo = Math.floor((d + 1) / 2) - 1
      const hi = Math.ceil((d + 1) / 2) - 1
      for (let m = lo; m <= hi; m++) {
        if (align.get(v) !== v) break
        const u = ns[m]!
        if (marked.has(pairKey(u, v))) continue
        const p = o.pos.get(u)!
        if (p <= r) continue
        align.set(u, v)
        root.set(v, root.get(u)!)
        align.set(v, root.get(v)!)
        r = p
      }
    }
  }
  return root
}

/**
 * Pack the blocks as far toward the start of this pass's direction as the layer
 * order allows: a longest-path walk of the graph the separations induce.
 *
 * Every adjacent pair in a layer is one constraint, `x(right) >= x(left) + sep`,
 * and both sides of it are whole blocks — a block moves as a unit or it stops
 * being vertical. Collapsing each constraint onto the blocks it names gives a
 * small weighted DAG, and the leftmost feasible placement is the longest path
 * into each node of it. One Kahn pass, every block finalized exactly when its
 * last predecessor is, so the answer is exact rather than iterated to.
 *
 * This is deliberately *not* the paper's sink-and-shift compaction, which
 * computes the same thing in the same time and is where its published erratum
 * lives — the class shifts do not compose, and a naive reading of it can return
 * a drawing with two cards on top of each other. Stated as a longest path there
 * is nothing to get wrong: the result satisfies every separation by
 * construction, which is a guarantee rather than a thing to go and measure.
 *
 * Extremal placement is the right thing for one pass precisely because there
 * are four of them. Each is pushed hard against its own wall, and `balance`
 * below is what puts the drawing back in the middle. A pass that tried to be
 * even-handed on its own would leave nothing for the other three to disagree
 * with.
 *
 * The guard is for a cycle among the blocks, which `alignBlocks` cannot
 * produce — it refuses any alignment that would put two blocks out of layer
 * order, so the relation is the layer order itself, which is total. It is here
 * because the cost of being wrong about that is overlapping cards, and the cost
 * of checking is one comparison.
 */
function compact(
  o: Oriented,
  lg: LayeredGraph,
  root: Map<LKey, LKey>,
  sep: (a: LNode, b: LNode) => number,
): Map<LKey, number> {
  const blocks: LKey[] = []
  const seen = new Set<LKey>()
  for (const layer of o.layers) {
    for (const v of layer) {
      const r = root.get(v)!
      if (seen.has(r)) continue
      seen.add(r)
      blocks.push(r)
    }
  }

  const outOf = new Map<LKey, Map<LKey, number>>()
  const indegree = new Map<LKey, number>()
  for (const b of blocks) {
    outOf.set(b, new Map())
    indegree.set(b, 0)
  }
  for (const layer of o.layers) {
    for (let i = 1; i < layer.length; i++) {
      const left = layer[i - 1]!
      const right = layer[i]!
      const a = root.get(left)!
      const b = root.get(right)!
      // A block holds at most one node per layer, so this is only reachable if
      // the alignment above crossed itself, which `r` prevents.
      if (a === b) continue
      const need = sep(lg.nodes.get(left)!, lg.nodes.get(right)!)
      const edges = outOf.get(a)!
      const had = edges.get(b)
      if (had === undefined) {
        edges.set(b, need)
        indegree.set(b, indegree.get(b)! + 1)
      } else if (need > had) {
        // Two layers can constrain the same pair of blocks by different
        // amounts — a card beside a dummy is charged `edgeGap`, two cards
        // `nodeGap`. The binding one is the widest.
        edges.set(b, need)
      }
    }
  }

  const bx = new Map<LKey, number>()
  for (const b of blocks) bx.set(b, 0)
  // Seeded and extended in block order, which is layer order, which is
  // canonical — so the walk visits the same blocks in the same sequence for any
  // shuffle of the document.
  const queue = blocks.filter((b) => indegree.get(b) === 0)
  for (let head = 0; head < queue.length; head++) {
    const b = queue[head]!
    const x = bx.get(b)!
    for (const [t, need] of outOf.get(b)!) {
      if (bx.get(t)! < x + need) bx.set(t, x + need)
      const left = indegree.get(t)! - 1
      indegree.set(t, left)
      if (left === 0) queue.push(t)
    }
  }

  const out = new Map<LKey, number>()
  for (const layer of o.layers) for (const v of layer) out.set(v, bx.get(root.get(v)!)!)

  if (queue.length < blocks.length) {
    for (const layer of o.layers) {
      for (let i = 1; i < layer.length; i++) {
        const a = lg.nodes.get(layer[i - 1]!)!
        const b = lg.nodes.get(layer[i]!)!
        const min = out.get(layer[i - 1]!)! + sep(a, b)
        if (out.get(layer[i]!)! < min) out.set(layer[i]!, min)
      }
    }
  }
  return out
}

/**
 * Brandes–Köpf for one component. **Not a strictly better `balanced`** — read
 * the module header before choosing it, and `LayoutConfig.packing` for the
 * short version: this puts a parent over its *median* child where `tidy.ts`
 * puts it on the midpoint of its outermost ones, so a lopsided fan moves.
 *
 * Four passes, lined up by `alignCandidates` and then combined by taking each
 * card's middle two. Taking a per-node median of four whole drawings sounds
 * like it should be able to produce an overlap, and cannot. Every pass
 * satisfies the same constraints in the same layer order, so for adjacent `u`
 * and `v` each pass has `x_j(v) >= x_j(u) + sep`. Order statistics are monotone
 * under that kind of pointwise domination: sort both nodes' four values and the
 * k-th of `v` still clears the k-th of `u` by `sep`, so the 2nd and 3rd do, and
 * so does their mean. No epsilon, and nothing to re-check afterwards — the same
 * argument `tidyComponent` makes for its convex combination of two, which is
 * the two-pass case of it.
 */
export function straightComponent(lg: LayeredGraph, base: LKey[][], cfg: LayoutConfig): void {
  const sep = separation(cfg)

  const keys: LKey[] = []
  for (const layer of base) for (const k of layer) keys.push(k)
  if (keys.length === 0) return

  const passes = []
  for (const vFlip of [false, true]) {
    for (const hFlip of [false, true]) {
      const o = orient(lg, base, vFlip, hFlip)
      const xs = compact(o, lg, alignBlocks(o, markConflicts(o, lg)), sep)
      // Negated back into real space, so a pass that packed rightward now has
      // its slack on the left and is anchored by its right edge.
      if (hFlip) for (const k of keys) xs.set(k, -xs.get(k)!)
      passes.push({ xs, anchor: hFlip ? ('max' as const) : ('min' as const) })
    }
  }

  if (!alignCandidates(lg, keys, passes)) return

  const four = new Array<number>(4)
  for (const k of keys) {
    for (let i = 0; i < 4; i++) four[i] = passes[i]!.xs.get(k)!
    four.sort((a, b) => a - b)
    lg.nodes.get(k)!.x = (four[1]! + four[2]!) / 2
  }
}
