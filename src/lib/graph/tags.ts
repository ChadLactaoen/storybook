/**
 * What a tag covers, measured in routes rather than in passages.
 *
 * "Eleven passages are tagged `combat`" is a fact about the document. "Sixty
 * per cent of the routes a reader can take hit combat at least once" is a fact
 * about the story, and it is the one an author is actually asking. This module
 * answers the second.
 *
 * **It cannot be a sum over the tagged passages.** The endings table in
 * `stats.ts` gets to add `to(n)` up across endings because a route stops at
 * exactly one of them — endings partition the routes. Tags do not partition
 * anything: a route down a tagged corridor collects the same tag three times
 * and a per-passage sum counts it three times. The complement is exact instead,
 * and it is one call:
 *
 *   touching(T) = totalRoutes - routes that avoid every passage tagged T
 *
 * The same primitive answers the harder question. For a set of tags, the routes
 * that collect *all* of them — in any order, across any passages, not
 * necessarily the same one — fall out of inclusion–exclusion over which tags a
 * route is allowed to miss. See `combineTags`.
 *
 * **The one sum that is legal here** is the level breakdown on each row. A
 * passage sits on exactly one level, so levels partition the *passages* the way
 * endings partition the routes, and `sum(levels[].passages) === passages`
 * exactly. It answers a different question from the share beside it and the two
 * will not reconcile: three passages on level 4 may lie on one route or on nine
 * hundred. Its denominator is the passages on that level — not
 * `LayoutResult.levels[].count`, which counts phantoms that could never carry a
 * tag.
 *
 * **The other legal sum** is how often one tag is collected. A route passes
 * through a tag's passages exactly one number of times, so "never, once,
 * twice, three or more" partitions the routes the way endings do — the level
 * breakdown above partitions the *passages*, and the two are not the same kind
 * of total — so `sum(buckets) === totalRoutes`, and `buckets[0]` is the same number the
 * complement above computes for "none". See `tagHits`. It is a sum over
 * *routes*, which is why it is sound; the thing this module refuses is a sum
 * over tagged passages.
 *
 * An analysis, not a layout stage: `layoutStory` never calls it, because a tag
 * moves nothing on the canvas. It reads the graph the layout already retains
 * and the fields `DerivedGraph` deliberately does not carry — `tags` is in the
 * document, beside `isEnding` and `slug`, for the same reason they are.
 *
 * **Which way it errs.** The route model drops back edges, so a reader who
 * loops back through a tagged passage and goes on is not a route here. Dropping
 * them can only *remove* collections, never invent one, so the "all of these"
 * count is a lower bound and the "none of these" count is an upper bound. The
 * second is the one that can state something false out loud on a hub-and-spoke
 * story, which is why the panel names the model rather than letting the number
 * speak for itself. `slugs.ts` reached the same fork and wrote the argument.
 *
 * A *count* errs differently again, and it is worth being plain about: "exactly
 * twice" is neither a lower bound nor an upper one. A reader who loops back
 * through a tagged passage collects it a third time, and the route they took is
 * not a route here at all. The buckets are exact about the model and the model
 * is named on screen; they are not a claim about a reader who circles.
 */

import type { NodeId, StoryDoc } from '../../types/story'
import { compareStr } from '../../types/story'
import { countPaths, countPathsAvoiding, countPathsByHits, countPathsToAll, share } from './paths'
import type { LayoutResult } from './types'

/**
 * How many tags may be combined at once.
 *
 * Inclusion–exclusion costs one graph walk per subset, so each tag added
 * doubles the work: ten is a thousand walks and about a third of a second on a
 * large story, and eleven is twice that. The ceiling lives here rather than in
 * the panel because a cap enforced only by a disabled checkbox is a
 * coincidence, not a guarantee.
 */
export const MAX_COMBINED_TAGS = 10

/**
 * A tag's footprint on one level. Only levels it actually reaches get one.
 */
export interface TagLevel {
  level: number
  /** Passages on this level carrying the tag. */
  passages: number
  /**
   * Passages on this level at all — the denominator. Phantoms are excluded: one
   * can never carry a tag, so counting it would understate every share on a
   * level with a broken link. Deliberately not `LayoutResult.levels[].count`,
   * which counts them.
   */
  levelPassages: number
  /** `passages` as a share of `levelPassages`, one decimal. */
  percent: number
  /** Those tagged passages, in `doc.nodes` order — the order `nodeIds` is in. */
  nodeIds: NodeId[]
}

export interface TagRow {
  tag: string
  /** Passages carrying it. The authored question: every passage, on a route or not. */
  passages: number
  /** Those passages, in canonical order. */
  nodeIds: NodeId[]
  /** Of those, how many no route reaches — unreachable, or stranded past an ending. */
  offRoute: number
  /** Routes passing through at least one of them. */
  routes: bigint
  percent: number
  /**
   * Where those passages sit, ascending, and **sparse** — a level the tag misses
   * has no entry at all. Unambiguous because every entry names its own level,
   * and on a deep story the dense form would be mostly zeros.
   *
   * A passage sits on exactly one level, so unlike the route counts beside it
   * this one is a partition: `sum(levels[].passages) === passages`, by
   * construction rather than by two counts agreeing. It is still a different
   * question from `percent` above, and the two do not reconcile — three
   * passages on level 4 may lie on one route or on nine hundred.
   */
  levels: TagLevel[]
}

export interface TagAnalysis {
  totalRoutes: bigint
  /** Busiest tag first. A total order, so the table never reshuffles. */
  rows: TagRow[]
  /** Distinct passages carrying at least one tag. */
  taggedPassages: number
  /** Routes that stop at a broken link — in the denominator, and worth saying so. */
  brokenRoutes: bigint
}

export interface TagCombination {
  /** The tags asked about, in canonical order. */
  tags: string[]
  /** Selected tags that no passage carries — why an answer of zero may be uninteresting. */
  missing: string[]
  /** Routes collecting every one of them somewhere along the way. */
  all: bigint
  allPercent: number
  /** Routes collecting none of them. */
  none: bigint
  nonePercent: number
  /** Passages carrying every one of them at once — a different question, kept apart. */
  passagesAll: number
  totalRoutes: bigint
  /** True when more than `MAX_COMBINED_TAGS` were asked for. Nothing was counted. */
  overCap: boolean
}

/**
 * What the non-empty buckets are called, and — by being counted — how many
 * there are.
 *
 * The cap is read off the labels rather than declared beside them because the
 * two cannot be allowed to drift: a cap raised on its own leaves a bucket with
 * no row to print it in, and the saturating one keeps a name that has quietly
 * become a lie ("three or more" when it now means exactly three). One
 * description, the way `commands.ts` holds one description of a command; the
 * panel renders these and counts nothing itself.
 *
 * Three, because the question an author is asking is "once, twice, or a lot" —
 * past that the distinction stops changing what they would do about it, and an
 * uncapped histogram would be as long as the deepest route in the story. The
 * last label is not "exactly" anything, which is what makes it the saturating
 * bucket.
 */
export const TAG_HIT_LABELS = ['exactly once', 'exactly twice', 'three or more times'] as const

/** How many collections are counted apart before they are lumped together. */
export const TAG_HIT_CAP = TAG_HIT_LABELS.length

/**
 * How often the routes collect one tag.
 *
 * Unlike everything else in this module the buckets partition the routes, so
 * they sum to `totalRoutes` — a route passes through the tag's passages exactly
 * one number of times. `buckets[0]` is the same "routes collecting none" the
 * complement computes, arrived at the other way round, and the two are asserted
 * equal.
 */
export interface TagHits {
  tag: string
  totalRoutes: bigint
  /**
   * Length `TAG_HIT_CAP + 1`: routes collecting the tag zero times, once,
   * twice, then three or more. Sums to `totalRoutes`.
   */
  buckets: bigint[]
  /** Each bucket as a share of `totalRoutes`, one decimal, index for index. */
  percents: number[]
}

/** Every tag the story knows about: in use, plus registered but not yet used. */
function allTagsOf(doc: StoryDoc): string[] {
  const set = new Set<string>()
  for (const n of doc.nodes) for (const t of n.tags) set.add(t)
  for (const t of doc.tagColors) set.add(t.name)
  return [...set].sort(compareStr)
}

/** Tag to the passages carrying it, in `doc.nodes` order, which is canonical. */
function index(doc: StoryDoc): Map<string, NodeId[]> {
  const out = new Map<string, NodeId[]>()
  for (const n of doc.nodes) {
    for (const t of n.tags) {
      const list = out.get(t)
      if (list) list.push(n.id)
      else out.set(t, [n.id])
    }
  }
  return out
}

/**
 * Split a tag's passages across the levels they sit on.
 *
 * One pass over `nodeIds`, so the buckets partition it exactly rather than by
 * two counts agreeing, and the relative order inside a bucket is inherited from
 * it — no new sort over ids, so no new determinism surface. The level list is
 * sorted explicitly, which makes it canonical whatever order the `Map` filled
 * in.
 */
function bucketByLevel(
  nodeIds: readonly NodeId[],
  nodeById: ReadonlyMap<NodeId, { level: number }>,
  levelSize: ReadonlyMap<number, number>,
): TagLevel[] {
  const byLevel = new Map<number, NodeId[]>()
  for (const id of nodeIds) {
    const lv = nodeById.get(id)?.level
    if (lv === undefined) continue
    const list = byLevel.get(lv)
    if (list) list.push(id)
    else byLevel.set(lv, [id])
  }
  return [...byLevel.keys()]
    .sort((a, b) => a - b)
    .map((level) => {
      const ids = byLevel.get(level)!
      const levelPassages = levelSize.get(level) ?? 0
      return {
        level,
        passages: ids.length,
        levelPassages,
        // `share` is the one rounding convention this panel presents — one
        // decimal, zero on an empty total. BigInt is its signature, not a claim
        // that these counts are large.
        percent: share(BigInt(ids.length), BigInt(levelPassages)),
        nodeIds: ids,
      }
    })
}

function endingsOf(doc: StoryDoc): Set<NodeId> {
  const out = new Set<NodeId>()
  for (const n of doc.nodes) if (n.isEnding) out.add(n.id)
  return out
}

/**
 * Every tag in the story, with the passages carrying it and the routes it
 * touches.
 *
 * Unused tags stay in the table at zero, the way `characterUsage` keeps a
 * roster member nobody has written yet: "I made this tag and never used it" is
 * a thing the author wants to see, not a row to hide.
 */
export function computeTagStats(doc: StoryDoc, layout: LayoutResult): TagAnalysis {
  const { graph, backEdges, nodeById } = layout
  const startId = doc.startNodeId
  const endings = endingsOf(doc)
  const byTag = index(doc)

  // How many passages sit on each level: the denominator for every level row
  // below, counted once for the whole table. Walking `doc.nodes` rather than
  // `layout.nodes` is what excludes phantoms — see `TagLevel.levelPassages`.
  const levelSize = new Map<number, number>()
  for (const n of doc.nodes) {
    const lv = nodeById.get(n.id)?.level
    if (lv !== undefined) levelSize.set(lv, (levelSize.get(lv) ?? 0) + 1)
  }

  const totalRoutes = startId === null ? 0n : countPaths(graph, backEdges, startId, endings)
  // One shared pass for the reverse direction, as `stats.ts` does: it answers
  // "does any route reach this passage" for every passage at once.
  const to = countPathsToAll(graph, backEdges, startId, endings)

  let brokenRoutes = 0n
  for (const p of graph.phantoms) brokenRoutes += to.get(p.id) ?? 0n

  const rows: TagRow[] = allTagsOf(doc).map((tag) => {
    const nodeIds = byTag.get(tag) ?? []
    const routes =
      nodeIds.length === 0
        ? 0n
        : totalRoutes - countPathsAvoiding(graph, backEdges, startId, new Set(nodeIds), endings)
    return {
      tag,
      passages: nodeIds.length,
      nodeIds,
      offRoute: nodeIds.filter((id) => (to.get(id) ?? 0n) === 0n && id !== startId).length,
      routes,
      percent: share(routes, totalRoutes),
      levels: bucketByLevel(nodeIds, nodeById, levelSize),
    }
  })

  // Busiest first, then by name. The name tiebreak is what makes it total, so
  // the table never leans on sort stability — the rule layout lives by.
  rows.sort(
    (a, b) => (a.routes === b.routes ? 0 : a.routes > b.routes ? -1 : 1) || compareStr(a.tag, b.tag),
  )

  let taggedPassages = 0
  for (const n of doc.nodes) if (n.tags.length > 0) taggedPassages += 1

  return { totalRoutes, rows, taggedPassages, brokenRoutes }
}

/**
 * How often the routes collect one tag: never, once, twice, or three or more.
 *
 * The complement answers *whether* a route collects a tag and stops there, so
 * a corridor of three tagged passages and a single tagged room read alike —
 * which is the question an author asks about a pacing or a resource tag. One
 * walk carrying a small vector answers it, and because a route collects the tag
 * exactly one number of times the answer is a partition, not an overlapping
 * tally: the buckets sum to `totalRoutes`.
 *
 * A tag no passage carries puts every route in `buckets[0]`, which is true and
 * says so; a story with no start counts nothing at all, as everything here
 * does. Only the panel asks, and only while it is open, so like the rest of
 * this module it is computed on demand and memoized nowhere.
 */
export function tagHits(doc: StoryDoc, layout: LayoutResult, tag: string): TagHits {
  const { graph, backEdges } = layout
  const startId = doc.startNodeId
  const endings = endingsOf(doc)
  const marked = new Set(index(doc).get(tag) ?? [])

  const buckets = countPathsByHits(graph, backEdges, startId, marked, TAG_HIT_CAP, endings)
  // Summed, not counted again: the buckets partition the routes, so a second
  // walk would be a second opinion about a number this one already holds — and
  // the claim above becomes true by construction rather than by two counters
  // agreeing. A story with no start sums to zero, which is the right answer.
  const totalRoutes = buckets.reduce((a, b) => a + b, 0n)

  return {
    tag,
    totalRoutes,
    buckets,
    percents: buckets.map((n) => share(n, totalRoutes)),
  }
}

/**
 * Routes that collect *all* of `tags`, and routes that collect none.
 *
 * Order does not matter, the passages need not be the same one, and one passage
 * carrying two of the selected tags satisfies both.
 *
 * Write `A_i` for the routes visiting at least one passage tagged `T_i`. What
 * the counter can answer directly is the opposite — the routes that avoid a set
 * of passages outright — and a route avoids a union of tagged sets exactly when
 * it misses every one of those tags. So with `avoid(S)` the routes missing
 * every tag in `S`:
 *
 *   |A_1 ∩ … ∩ A_k| = Σ over every subset S of (−1)^|S| · avoid(S)
 *
 * the empty subset contributing all the routes there are. Intermediate terms go
 * negative; the total cannot, and BigInt keeps every step exact.
 *
 * "None of them" is `avoid` of the whole set — already computed as one of the
 * terms, but taken unsigned, because that term carries `(−1)^k` and an odd
 * number of tags would otherwise report a negative count.
 *
 * With no tags at all both answers are every route: a reader trivially collects
 * all of nothing and none of nothing. True, and useless, so the panel does not
 * ask.
 */
export function combineTags(
  doc: StoryDoc,
  layout: LayoutResult,
  tags: readonly string[],
): TagCombination {
  const { graph, backEdges } = layout
  const startId = doc.startNodeId
  const endings = endingsOf(doc)
  const byTag = index(doc)

  // Canonical: the sum is exact in any order, but which terms the prune below
  // skips is not, and this repo iterates reproducibly or not at all.
  const chosen = [...new Set(tags)].sort(compareStr)
  const totalRoutes = startId === null ? 0n : countPaths(graph, backEdges, startId, endings)
  const missing = chosen.filter((t) => (byTag.get(t) ?? []).length === 0)

  let passagesAll = 0
  for (const n of doc.nodes) if (chosen.every((t) => n.tags.includes(t))) passagesAll += 1

  // Refused rather than truncated: analysing nine of the eleven tags asked
  // about and labelling the answer with all eleven is the one outcome worse
  // than no answer.
  if (chosen.length > MAX_COMBINED_TAGS) {
    return {
      tags: chosen,
      missing,
      passagesAll,
      totalRoutes,
      all: 0n,
      allPercent: 0,
      none: 0n,
      nonePercent: 0,
      overCap: true,
    }
  }

  const k = chosen.length
  const sets = chosen.map((t) => byTag.get(t) ?? [])
  const full = (1 << k) - 1

  let all = 0n
  let none = totalRoutes
  // A subset always sorts below its supersets numerically — dropping bits only
  // lowers the value — so ascending order sees every `S` before anything that
  // contains it. That is what lets a zero term prune: no route avoids `S`, so
  // none can avoid more than `S` either.
  const zeros: number[] = []
  for (let mask = 0; mask <= full; mask += 1) {
    if (zeros.some((z) => (mask & z) === z)) {
      if (mask === full) none = 0n
      continue
    }

    const blocked = new Set<NodeId>()
    for (let i = 0; i < k; i += 1) {
      if ((mask & (1 << i)) !== 0) for (const id of sets[i]!) blocked.add(id)
    }

    const avoided =
      mask === 0
        ? totalRoutes
        : countPathsAvoiding(graph, backEdges, startId, blocked, endings)

    if (avoided === 0n) zeros.push(mask)
    if (mask === full) none = avoided

    // Popcount is small enough to count by hand; a parity flag would be one
    // more thing to keep in step with the loop.
    let bits = 0
    for (let i = 0; i < k; i += 1) if ((mask & (1 << i)) !== 0) bits += 1
    all += bits % 2 === 0 ? avoided : -avoided
  }

  return {
    tags: chosen,
    missing,
    passagesAll,
    totalRoutes,
    all,
    allPercent: share(all, totalRoutes),
    none,
    nonePercent: share(none, totalRoutes),
    overCap: false,
  }
}
