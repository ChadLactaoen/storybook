/**
 * What a reader would have collected on the way here.
 *
 * One of the analyses the Sugiyama pipeline never calls, alongside `paths.ts`,
 * `gates.ts`, `stats.ts` and `recode.ts`: nothing here moves a card, and the
 * answer is wanted only when something asks for it.
 *
 * Each passage may carry a short `slug`. The *running slug* of a passage is the
 * slugs of the passages on the route to it, run together — `A -> B -> D` spells
 * `ABD`. Where the routes disagree it says so with `*`: add `A -> C -> D` and D
 * reads `A*D`, because every route to D passes A and D but what happens between
 * them depends on which way the reader went.
 *
 * **A running slug is a pattern, and the one it wants is the most specific
 * pattern every route's spelling matches.** Read `*` as "any stretch, possibly
 * empty": `A*D` is matched by `AD`, by `ACD` and by `AXYD`. So the answer for a
 * passage is the *generalization* of its predecessors' answers, with its own
 * mark appended — which is what `unify` computes, by keeping what two patterns
 * agree on at the front and at the back and starring what is left.
 *
 * **A run is a list of segments, never a string.** A mark is atomic: `Ab` and
 * `Bb` are two different marks that happen to share a letter, and comparing
 * them by character would answer `*b`, inventing a `b` no reader ever wrote
 * down as a mark of its own. Rendering happens once, at the end.
 *
 * Parentheses are the one piece of structure inside a mark. `A(a)` is a stem
 * and a group, and the two are compared independently, so two siblings marked
 * `A(a)` and `A(b)` agree on the stem and differ in the group: `A(*)`. Working
 * on characters got this wrong in a way that was not merely imprecise — it cut
 * between `(` and `)` and produced `*)`, a string with no opening bracket.
 *
 * This was dominator-based first, and the dominators were right about which
 * *passages* every route passes. They were not enough, because a running slug
 * is about what a reader has written down, not about which passages they stood
 * in: two different passages carrying the same mark spell the same thing, and a
 * structural answer cannot see that. Working on the marks recovers it — see
 * `'keeps a mark two different passages agree on'`.
 *
 * It stays the close cousin of `gates.ts`, which proves a related claim from
 * `(if:)` macros rather than from the graph, and the two can disagree in one
 * direction: `gates.ts` can prove a branch *dead*, so the inspector may say
 * "every route here passes P4" while the card still writes `*` for a fork whose
 * other side no reader can take. Both are failing closed in their own
 * direction, and neither is wrong about what it claims.
 *
 * Fail-closed, stated once: **a `*` where a literal was possible costs
 * precision; a literal where the routes differ states something false.** When
 * in doubt, star. Every guard below resolves that way, including the ones that
 * should be unreachable.
 */

import type { NodeId } from '../../types/story'
import { SLUG_AMBIGUOUS } from '../../types/story'
import { isPhantomId } from './constants'
import { backwardSources, forwardTargets, NO_ENDINGS } from './paths'
import type { DerivedGraph, EdgeId } from './types'

/**
 * What stands in for a stretch of route the slugs do not agree on.
 *
 * Re-exported rather than re-declared: `normalizeSlug` strips exactly this
 * character on the way in, and the two must not be able to drift apart.
 */
export const AMBIGUOUS = SLUG_AMBIGUOUS

/**
 * One piece of a running slug.
 *
 * `text` and `group` are both *atomic*: they compare whole, never by character,
 * because each came from one mark an author actually typed. `star` is a stretch
 * the routes do not agree on.
 */
export type Seg =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'group'; readonly value: string }
  | { readonly kind: 'star' }

const STAR: Seg = { kind: 'star' }

/**
 * Split one mark into its stem and its groups: `A(a)` is `A` then `(a)`.
 *
 * Anything that is not a clean, flat, balanced grouping is left alone as one
 * piece of text — an unclosed bracket, a stray `)`, a nested `((a))`. That is
 * the fail-closed direction here: treating a doubtful mark as opaque costs a
 * little precision, while guessing at its structure would let the tool split a
 * mark somewhere the author did not.
 */
export function segmentsOf(slug: string): Seg[] {
  if (slug.length === 0) return []
  const whole: Seg[] = [{ kind: 'text', value: slug }]

  const out: Seg[] = []
  let text = ''
  let i = 0
  while (i < slug.length) {
    const c = slug[i]!
    if (c === ')') return whole
    if (c !== '(') {
      text += c
      i += 1
      continue
    }
    const close = slug.indexOf(')', i + 1)
    if (close === -1) return whole
    const inner = slug.slice(i + 1, close)
    if (inner.includes('(')) return whole
    if (text.length > 0) {
      out.push({ kind: 'text', value: text })
      text = ''
    }
    out.push({ kind: 'group', value: inner })
    i = close + 1
  }
  if (text.length > 0) out.push({ kind: 'text', value: text })
  return out
}

/** A run as the card and the search box see it. */
export function render(run: readonly Seg[]): string {
  let out = ''
  for (const s of run) {
    out += s.kind === 'star' ? AMBIGUOUS : s.kind === 'group' ? `(${s.value})` : s.value
  }
  return out
}

function same(x: Seg, y: Seg): boolean {
  if (x.kind !== y.kind) return false
  return x.kind === 'star' || x.value === (y as { value: string }).value
}

/** Runs of markers mean one varying stretch, so they are kept as one. */
function collapse(run: readonly Seg[]): Seg[] {
  const out: Seg[] = []
  for (const s of run) {
    if (s.kind === 'star' && out[out.length - 1]?.kind === 'star') continue
    out.push(s)
  }
  return out
}

/** What both analyses read. */
export interface MarkInput {
  backEdges: ReadonlySet<EdgeId>
  endings?: ReadonlySet<NodeId>
  /** A passage's own mark, or `''`. Phantoms have none and must answer `''`. */
  slugOf: (id: NodeId) => string
}

/**
 * What `runningSlugs` reads on top of that.
 *
 * `marksAhead` takes the narrower shape on purpose: it asks which passages have
 * a mark ahead of them, which is not a question about where the story starts.
 * Handing it a `startId` it silently ignored would let a caller believe the
 * answer was start-relative when it never was.
 */
export interface SlugInput extends MarkInput {
  startId: NodeId | null
}

/**
 * Running slugs for every passage a route from the start reaches.
 *
 * A passage that is absent from the result has no route to it at all — an
 * island, a passage reachable only by going back round a loop, or one stranded
 * behind a marked ending — and has nothing to show. That is a different state
 * from being present with an empty string, which means the route here is real
 * and nobody on it has been given a slug yet.
 *
 * Phantoms are excluded. A phantom is a sink with no passage behind it, so it
 * would otherwise render the answer of the passage before it verbatim and put
 * a duplicate route code on the canvas for something that does not exist.
 */
export function runningSlugs(g: DerivedGraph, input: SlugInput): Map<NodeId, string> {
  const { backEdges, startId, endings = NO_ENDINGS, slugOf } = input
  const out = new Map<NodeId, string>()
  if (startId === null || !g.byId.has(startId)) return out

  const next = (id: NodeId) => forwardTargets(g, backEdges, id, endings)
  const prev = (id: NodeId) => backwardSources(g, backEdges, id, endings)
  const slugged = (id: NodeId) => slugOf(id).length > 0

  // 1. What a route from the start actually reaches. Everything below is
  //    restricted to this set, which is what makes the rest of it total: the
  //    route graph is acyclic, so within `reached` the start has no incoming
  //    edge and every other node has at least one.
  const reached = closure([startId], next)

  const taint = loopTaint(g, backEdges, reached, next, prev, slugged)

  // 2. Kahn, seeded from the start. Adjacency is canonical, so the order is
  //    reproducible — though nothing below depends on *which* valid topological
  //    order this is, only that every predecessor is finished before its
  //    successor.
  const indegree = new Map<NodeId, number>()
  for (const id of reached) {
    let n = 0
    for (const p of prev(id)) if (reached.has(p)) n += 1
    indegree.set(id, n)
  }

  const run = new Map<NodeId, Seg[]>()

  /** Append a marker, never doubling one: `**` says nothing `*` does not. */
  const mark = (r: Seg[], on: boolean) => (on ? collapse([...r, STAR]) : r)

  const queue: NodeId[] = [startId]
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!

    if (id === startId) {
      run.set(id, mark(segmentsOf(slugOf(id)), taint.has(id)))
    } else {
      const sources = prev(id).filter((p) => run.has(p))
      // Unreachable inside `reached` is a contradiction, so this is a guard and
      // not a case. Dropping the passage says nothing, which is the safe thing
      // to say.
      if (sources.length === 0) continue

      // Folded in adjacency order, which is canonical. The fold is sound in any
      // order — a generalization of a generalization still generalizes — but
      // *which* one comes out can vary, so the order is pinned rather than
      // incidental.
      let carried = run.get(sources[0]!)!
      for (let i = 1; i < sources.length; i += 1) carried = unify(carried, run.get(sources[i]!)!)

      run.set(id, mark([...carried, ...segmentsOf(slugOf(id))], taint.has(id)))
    }

    for (const t of next(id)) {
      if (!reached.has(t)) continue
      const left = (indegree.get(t) ?? 0) - 1
      indegree.set(t, left)
      if (left === 0) queue.push(t)
    }
  }

  // `g.ids` rather than the traversal order: canonical order in, canonical
  // order out, the rule every map in this layer is built by.
  for (const id of g.ids) {
    if (isPhantomId(id)) continue
    const r = run.get(id)
    if (r !== undefined) out.set(id, render(r))
  }
  return out
}

/**
 * The most specific pattern matched by everything either pattern matches.
 *
 * Keep the segments they agree on at the front, keep the ones they agree on at
 * the back, and reconcile what is left between:
 *
 * ```
 * unify([1][*][U][D], [1][*][U][Yn][D])
 *   front [1][*][U]     (D and Yn part company)
 *   back  [D]           (U and n part company)
 *   left  [] and [Yn]   ->  *
 *   =>    [1][*][U][*][D]
 * ```
 *
 * **Why the back half earns its keep.** Two different passages can carry the
 * same mark, and then two routes really do spell the same thing at the end even
 * though they stood in different places to do it. A dominator-based answer
 * cannot see that — it reasons about passages — and gave up the shared `D`
 * above. This keeps it.
 *
 * **Why the middle is reconciled position by position when it can be.** Marks
 * line up one-to-one when the two sides have the same number left over, and
 * then each pair can be answered on its own: `A(a)` against `B(b)` is a stem
 * that differs and a group that differs, which is `*(*)` and not the blunter
 * `*`. When the counts differ there is no alignment to trust, and a single
 * marker is the honest answer.
 *
 * Sound because `*` matches any stretch **including an empty one**, which is
 * already what the rest of this module means by it: `A*D` is how two routes
 * spelling `AD` and `ACD` are described. A segment survives here only where
 * both sides already had it, so by induction a literal in a running slug is a
 * mark every route to that passage collects, in that order. Over-starring costs
 * precision; that is the direction this is allowed to err in.
 */
export function unify(a: readonly Seg[], b: readonly Seg[]): Seg[] {
  const limit = Math.min(a.length, b.length)

  let front = 0
  while (front < limit && same(a[front]!, b[front]!)) front += 1

  // Bounded by what the front has not already claimed, so the two halves can
  // never overlap and quote the same mark twice.
  let back = 0
  while (back < limit - front && same(a[a.length - 1 - back]!, b[b.length - 1 - back]!)) back += 1

  const midA = a.slice(front, a.length - back)
  const midB = b.slice(front, b.length - back)
  const middle =
    midA.length === midB.length ? midA.map((seg, i) => meet(seg, midB[i]!)) : [STAR]

  return collapse([...a.slice(0, front), ...middle, ...a.slice(a.length - back)])
}

/**
 * Two marks in the same place, reconciled.
 *
 * Groups are the only structure a mark has, so two of them answer with a group
 * — `(a)` against `(b)` is `(*)`, which still says "there was a group here, and
 * it varied". Anything else falls back to a plain marker.
 */
function meet(x: Seg, y: Seg): Seg {
  if (same(x, y)) return x
  if (x.kind === 'group' && y.kind === 'group') return { kind: 'group', value: AMBIGUOUS }
  return STAR
}

/**
 * Passages whose running slug is still going somewhere.
 *
 * A passage that carries no mark, and has no descendant that carries one
 * either, will spell exactly what its parent spelled and will go on doing so
 * for the whole tail below it. The code is finished; repeating it down a
 * corridor of cards is noise.
 *
 * This is a question about *display*, not about the code. `runningSlugs` keeps
 * telling the truth for every passage a route reaches, because the search box
 * has to find a passage by the code that reaches it whether or not its card
 * shows one, and the inspector has to be able to say what it is.
 *
 * Computed by walking *backwards* from every marked passage, which is the same
 * question asked the cheap way round: a passage can reach a mark exactly when a
 * mark can be reached from it. Route edges, so a mark stranded past an ending
 * keeps nothing alive.
 */
export function marksAhead(g: DerivedGraph, input: MarkInput): Set<NodeId> {
  const { backEdges, endings = NO_ENDINGS, slugOf } = input
  const marked = g.ids.filter((id) => slugOf(id).length > 0)
  return closure(marked, (id) => backwardSources(g, backEdges, id, endings))
}

/**
 * Loop heads whose cycle a reader could come round carrying a slug.
 *
 * `forwardTargets` drops back edges, so the route model says `A -> H -> C -> H`
 * plus `H -> S` gives S exactly one spelling, `AHS`. A reader can walk
 * `A H C H S` and hold `AHCHS`. A path *count* under a declared model is one
 * kind of claim; a running slug purports to describe what somebody has in hand,
 * which is a stronger one, and CLAUDE.md is explicit that hub-and-spoke is
 * legitimate writing rather than an edge case.
 *
 * So a loop head is marked, and everything downstream of it inherits a `*`
 * through the answer they are built from. A loop with no slug anywhere on it
 * — the common case — marks nothing and costs nothing.
 *
 * The head's own slug counts: going round re-collects it, which is a difference
 * like any other.
 */
function loopTaint(
  g: DerivedGraph,
  backEdges: ReadonlySet<EdgeId>,
  reached: ReadonlySet<NodeId>,
  next: (id: NodeId) => NodeId[],
  prev: (id: NodeId) => NodeId[],
  slugged: (id: NodeId) => boolean,
): Set<NodeId> {
  const out = new Set<NodeId>()
  // Nothing anywhere carries a mark, so no loop can be carrying one round. The
  // docstring's promise that an unmarked loop costs nothing is only true with
  // this here: `out.has(head)` below skips repeats of a head that has *already*
  // been marked, which is exactly the case that never happens when there is
  // nothing to mark — so a hub with a hundred spokes back to it would otherwise
  // pay two full traversals a hundred times over, on a per-keystroke path.
  if (!g.ids.some(slugged)) return out

  // Memoized per head for the same reason: spokes returning to one hub all name
  // the same target, and what lies ahead of it does not change between them.
  const aheadOf = new Map<NodeId, Set<NodeId>>()
  const ahead = (id: NodeId): Set<NodeId> => {
    let seen = aheadOf.get(id)
    if (!seen) {
      seen = closure([id], next)
      aheadOf.set(id, seen)
    }
    return seen
  }

  for (const eid of backEdges) {
    const e = g.edgeById.get(eid)
    if (!e) continue
    const head = e.targetId
    if (!reached.has(head) || out.has(head)) continue

    if (e.selfLoop) {
      if (slugged(head)) out.add(head)
      continue
    }
    if (!reached.has(e.sourceId)) continue

    // The loop body is what lies on a route out of the head and back to the
    // edge's source. If routes cannot get round — an ending cuts the way, say —
    // then no reader can either, and there is nothing to mark.
    const forward = ahead(head)
    if (!forward.has(e.sourceId)) continue
    const behind = closure([e.sourceId], prev)
    for (const v of forward) {
      if (behind.has(v) && slugged(v)) {
        out.add(head)
        break
      }
    }
  }
  return out
}

/** Everything reachable from `seeds` under `step`. Iterative; `seen` guards it. */
function closure(seeds: readonly NodeId[], step: (id: NodeId) => NodeId[]): Set<NodeId> {
  const seen = new Set<NodeId>(seeds)
  const stack = [...seeds]
  while (stack.length > 0) {
    for (const t of step(stack.pop()!)) {
      if (seen.has(t)) continue
      seen.add(t)
      stack.push(t)
    }
  }
  return seen
}
