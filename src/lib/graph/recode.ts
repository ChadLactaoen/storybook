import type { NodeId } from '../../types/story'
import { linkSyntaxIn } from '../harlowe/links'
import type { LayoutResult, NodeLayout } from './types'

/**
 * What a batch recode would call every passage.
 *
 * Pure over `LayoutResult`, like `countPaths` and `gatesOf`: a third analysis
 * the pipeline never calls, run only when the author asks for one. The numbering
 * is a fact about the *drawing* — "the first passage on level 3" — and
 * `mutations.ts` may not read layout, so the plan is built here and handed down
 * to `recodeAll` as finished text. Nothing in this module touches a document.
 */

export type RecodeMode = 'levelNode' | 'node'

export interface RecodeOptions {
  mode: RecodeMode
  /** Leading text. Empty for level-and-node, `P` for node, by default. */
  prefix: string
  /** Sits between the level and the index. Level-and-node only. */
  separator: string
}

export interface RecodeEntry {
  id: NodeId
  from: string
  to: string
  title: string
  level: number
}

export interface RecodePlan {
  /** Every real passage, in the order the tree draws them. */
  entries: RecodeEntry[]
  /** id -> new code, exactly what `recodeAll` wants. */
  mapping: Map<NodeId, string>
  /** How many codes actually move. */
  changed: number
  /** Blocks the apply, or null. */
  error: string | null
  /**
   * New codes a link with no passage behind it already names. Applying does not
   * fail — those links stop dangling, which changes the shape of the tree.
   */
  captures: string[]
}

/**
 * Every real passage, in the order the tree draws them: level by level, left to
 * right inside each.
 *
 * `layout.nodes` is sorted by (code, id) for determinism, not by position, so it
 * has to be re-sorted. `order` is the index within the merged layer: gapped where
 * a routing dummy holds a slot, but strictly increasing left to right, so it
 * orders real cards exactly as `x` does without depending on coordinates.
 *
 * Exported because the store reads a finished recode back in this same order,
 * and a second copy of this rule is a second thing to get wrong.
 */
export function drawingOrder(layout: LayoutResult): NodeLayout[] {
  return layout.nodes
    .filter((n) => !n.isPhantom)
    .sort((a, b) => a.level - b.level || a.order - b.order)
}

/**
 * The narrowest a code's number is allowed to be.
 *
 * Width is otherwise taken from the story's size, which means crossing a power
 * of ten rewrites every code in the story: nine passages numbered `P1`..`P9`
 * all churn to `P01`..`P10` the moment a tenth arrives, for a reason that has
 * nothing to do with where any of them sit. A floor of two moves that cliff out
 * to a hundred, which most stories never reach.
 *
 * It cannot be removed entirely — no fixed width covers an unbounded story — so
 * a story that does pass a hundred still churns once. Raise this to 3 to buy
 * another decade of quiet at the cost of `P001` on a five-passage story.
 *
 * Applies to the counter only, never to the level: levels are an order of
 * magnitude smaller, and `01N01` reads far worse than `1N01` buys.
 */
const MIN_NUMBER_WIDTH = 2

/** Left-pad `n` so that every number in the scheme is the same width. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** Digits needed for the largest number a scheme will emit. */
function widthOf(max: number): number {
  return String(Math.max(1, max)).length
}

/**
 * Read a numbering off the tree as drawn.
 *
 * Two schemes, both walking the same order:
 *   levelNode  `<prefix><level><separator><index within the level>`  — `3N1`
 *   node       `<prefix><index in the whole story>`                  — `P4`
 *
 * Levels are the user-facing 1-based ones. Within a level the index runs left to
 * right; the global index runs level by level, left to right inside each.
 *
 * Phantoms consume no index. They draw as cards, so counting them would be
 * defensible, but they are not passages and cannot be recoded — numbering around
 * them would leave permanent gaps in a scheme whose whole point is to be read
 * off the page.
 *
 * **Numbers are padded to a common width, and that is load-bearing.** Canonical
 * node order is *code* order, and layout numbers its components by it, packing
 * them left to right in that order. Unpadded, `P10` sorts before `P2`, so the
 * drawing a numbering was read from is not the drawing it produces: past nine
 * components the assignment and the packing chase each other around a cycle that
 * has no fixed point, and every press of Recode rotates the codes again. Padding
 * makes codepoint order equal drawing order, which makes the numbering a fixed
 * point of its own layout — so one pass settles, and a second press is a no-op.
 *
 * The width comes from the story, under a floor of `MIN_NUMBER_WIDTH` so that
 * growing past ten does not rewrite every code. In level-and-node the level and
 * the index are padded separately, each to its own maximum, so the two fields
 * stay aligned and compare field by field.
 */
export function planRecode(layout: LayoutResult, opts: RecodeOptions): RecodePlan {
  const real = drawingOrder(layout)

  // The index of each passage within its level, and the widths those imply.
  // Computed up front because a code cannot be padded until the widest number in
  // the scheme is known.
  const indexOf: number[] = []
  let maxIndex = 0
  let maxLevel = 0
  {
    let level = 0
    let index = 0
    for (const n of real) {
      // `real` is sorted by level, so a change of level *is* the group break.
      if (n.level !== level) {
        level = n.level
        index = 0
      }
      index += 1
      indexOf.push(index)
      if (index > maxIndex) maxIndex = index
      if (n.level > maxLevel) maxLevel = n.level
    }
  }

  const levelWidth = widthOf(maxLevel)
  const indexWidth = Math.max(
    MIN_NUMBER_WIDTH,
    widthOf(opts.mode === 'node' ? real.length : maxIndex),
  )

  const entries: RecodeEntry[] = []
  const mapping = new Map<NodeId, string>()
  /** new code -> the passage claiming it. */
  const claimed = new Map<string, string>()
  let error: string | null = null
  let changed = 0

  // The prefix and separator are spliced into every inbound link along with the
  // rest of the code, so link punctuation in either would re-point those links.
  const offending = linkSyntaxIn(opts.prefix) ?? linkSyntaxIn(opts.separator)
  if (offending !== null) {
    error =
      `A prefix or separator cannot contain "${offending}" — it is link syntax, ` +
      'and would break every link pointing at a recoded passage.'
  }

  for (let i = 0; i < real.length; i++) {
    const n = real[i]!

    // Trimmed here rather than left to the mutation: `setCode` and `recodeAll`
    // both trim, so an untrimmed preview would show a code the document never
    // receives.
    const to =
      opts.mode === 'node'
        ? `${opts.prefix}${pad(i + 1, indexWidth)}`.trim()
        : `${opts.prefix}${pad(n.level, levelWidth)}${opts.separator}${pad(indexOf[i]!, indexWidth)}`.trim()

    // Fixed widths make the level and index fields unambiguous, so this cannot
    // fire for a plan built here. Kept because the check costs nothing and the
    // failure it guards — two passages given one code — is silent otherwise.
    const name = n.title.length > 0 ? n.title : n.code
    const rival = claimed.get(to)
    if (rival !== undefined && error === null) {
      error = `“${rival}” and “${name}” would both be coded "${to}".`
    }
    claimed.set(to, name)

    entries.push({ id: n.id, from: n.code, to, title: name, level: n.level })
    mapping.set(n.id, to)
    if (to !== n.code) changed += 1
  }

  // A dangling link target a new code would capture: the phantom stops being a
  // phantom and a real edge appears where the author wrote none.
  const captures = layout.nodes
    .filter((n) => n.isPhantom && claimed.has(n.code))
    .map((n) => n.code)

  return { entries, mapping, changed, error, captures }
}
