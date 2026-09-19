import { describe, expect, it } from 'vitest'
import { layoutStory } from '../lib/graph/layout'
import { countPaths, countPathsAvoiding, countPathsByHits, NO_ENDINGS } from '../lib/graph/paths'
import {
  combineTags,
  computeTagStats,
  tagHits,
  MAX_COMBINED_TAGS,
  TAG_HIT_CAP,
} from '../lib/graph/tags'
import type { StoryDoc } from '../types/story'
import { docFrom, shuffled } from './helpers'

function tagStats(doc: StoryDoc) {
  return computeTagStats(doc, layoutStory(doc))
}

function combine(doc: StoryDoc, tags: string[]) {
  return combineTags(doc, layoutStory(doc), tags)
}

function rowOf(doc: StoryDoc, tag: string) {
  return tagStats(doc).rows.find((r) => r.tag === tag)!
}

function hitsOf(doc: StoryDoc, tag: string) {
  return tagHits(doc, layoutStory(doc), tag)
}

function idOf(doc: StoryDoc, title: string): string {
  return doc.nodes.find((n) => n.title === title)!.id
}

/**
 * Every route the slow way: walk the graph enumerating whole paths, and return
 * how many times each one collects each tag.
 *
 * The oracle exists because the module under test never enumerates a route — it
 * counts complements, cancels subsets and carries a histogram — so a test that
 * reasoned the same way would only prove the reasoning consistent with itself.
 * This walks what a reader walks. It is exponential, so every fixture using it
 * stays small.
 *
 * A count per tag rather than a set: "did this route collect it" is
 * `(count ?? 0) > 0`, so the touching and combining questions read straight off
 * it, while "exactly twice" needs the multiplicity a set throws away.
 */
function routeTags(doc: StoryDoc): Map<string, number>[] {
  const { graph, backEdges } = layoutStory(doc)
  const endings = new Set(doc.nodes.filter((n) => n.isEnding).map((n) => n.id))
  const tagsOf = new Map(doc.nodes.map((n) => [n.id, n.tags]))
  const out: Map<string, number>[] = []
  if (doc.startNodeId === null) return out

  const walk = (id: string, carried: Map<string, number>, seen: Set<string>) => {
    const here = new Map(carried)
    for (const t of tagsOf.get(id) ?? []) here.set(t, (here.get(t) ?? 0) + 1)

    if (endings.has(id)) {
      out.push(here)
      return
    }
    const kids: string[] = []
    for (const eid of graph.outAdj.get(id) ?? []) {
      const e = graph.edgeById.get(eid)!
      if (e.selfLoop || backEdges.has(eid)) continue
      kids.push(e.targetId)
    }
    if (kids.length === 0) {
      out.push(here)
      return
    }
    for (const k of kids) {
      if (seen.has(k)) continue
      walk(k, here, new Set([...seen, k]))
    }
  }

  walk(doc.startNodeId, new Map(), new Set([doc.startNodeId]))
  return out
}

/** What the oracle says, for one tag and for a set. */
function oracle(doc: StoryDoc) {
  const routes = routeTags(doc)
  const got = (r: Map<string, number>, tag: string) => (r.get(tag) ?? 0) > 0
  return {
    total: BigInt(routes.length),
    touching: (tag: string) => BigInt(routes.filter((r) => got(r, tag)).length),
    all: (tags: string[]) => BigInt(routes.filter((r) => tags.every((t) => got(r, t))).length),
    none: (tags: string[]) => BigInt(routes.filter((r) => !tags.some((t) => got(r, t))).length),
    // Saturating at the same place `tagHits` does, so the two are comparable
    // bucket for bucket rather than only in total.
    hits: (tag: string) => {
      const out = new Array<bigint>(TAG_HIT_CAP + 1).fill(0n)
      for (const r of routes) {
        const i = Math.min(r.get(tag) ?? 0, TAG_HIT_CAP)
        out[i] = out[i]! + 1n
      }
      return out
    },
  }
}

const DIAMOND = { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] }

describe('routes touching a tag', () => {
  it('counts the routes through a tagged branch, not the passages carrying it', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['x'] } })
    const s = tagStats(doc)
    expect(s.totalRoutes).toBe(2n)
    expect(rowOf(doc, 'x')).toMatchObject({ passages: 1, routes: 1n, percent: 50 })
  })

  it('counts a route through two passages carrying the same tag exactly once', () => {
    // The trap the complement exists to avoid. `to(n) * from(n)` summed over the
    // tagged passages would say 3 routes out of 2 here; a route that collects
    // `combat` twice is still one route.
    const doc = docFrom(
      { A: ['B', 'E'], B: ['C'], C: ['D'], D: [], E: [] },
      { tags: { B: ['combat'], C: ['combat'] } },
    )
    const s = tagStats(doc)
    expect(s.totalRoutes).toBe(2n)
    expect(rowOf(doc, 'combat').routes).toBe(1n)
    expect(rowOf(doc, 'combat').passages).toBe(2)
  })

  it('reads 100% for a tag on the start passage', () => {
    const doc = docFrom(DIAMOND, { tags: { A: ['prologue'] } })
    expect(rowOf(doc, 'prologue')).toMatchObject({ routes: 2n, percent: 100 })
  })

  it('keeps a registered but unused tag in the table, at zero', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['x'] } })
    doc.tagColors = [...doc.tagColors, { name: 'unused', color: 'none' }]
    expect(rowOf(doc, 'unused')).toMatchObject({ passages: 0, routes: 0n, percent: 0 })
  })

  it('counts a tagged passage that is also a marked ending', () => {
    // The case that fails loudly if `blocked` is ever checked after `endings`:
    // B returns 1n as an ending before anyone notices it is blocked, and the
    // route that stops on the tag gets counted as avoiding it.
    const doc = docFrom(DIAMOND, { tags: { B: ['finale'] }, endings: ['B'] })
    expect(tagStats(doc).totalRoutes).toBe(2n)
    expect(rowOf(doc, 'finale').routes).toBe(1n)
  })

  it('says how many of a tag’s passages no route reaches', () => {
    // Stranded past an ending: seven passages, none of them on a route, is a
    // true and baffling row without this column.
    const doc = docFrom({ A: ['B'], B: ['C'], C: [] }, { tags: { C: ['late'] }, endings: ['B'] })
    expect(rowOf(doc, 'late')).toMatchObject({ passages: 1, offRoute: 1, routes: 0n })
  })

  it('reads zero for a tag reachable only by a back edge or a self-link', () => {
    const doc = docFrom({ A: ['B'], B: ['C'], C: ['B'] }, { tags: { C: ['loop'] } })
    const s = tagStats(doc)
    // C is only ever entered forwards, so it is on the one route; the back edge
    // C -> B is what carries nothing.
    expect(s.totalRoutes).toBe(1n)
    expect(rowOf(doc, 'loop').routes).toBe(1n)

    const selfy = docFrom({ A: ['B'], B: ['B'] }, { tags: { B: ['stuck'] } })
    expect(rowOf(selfy, 'stuck').routes).toBe(1n)
  })

  it('orders by routes, then by name, without leaning on sort stability', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['b', 'a'], A: ['z'] } })
    expect(tagStats(doc).rows.map((r) => r.tag)).toEqual(['z', 'a', 'b'])
  })

  it('agrees with a brute-force walk of every route', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D', 'E'], C: ['E', 'F'], D: [], E: ['G'], F: [], G: [] },
      { tags: { B: ['x'], E: ['y', 'x'], F: ['z'], G: ['y'] } },
    )
    const truth = oracle(doc)
    const s = tagStats(doc)
    expect(s.totalRoutes).toBe(truth.total)
    for (const row of s.rows) expect(row.routes).toBe(truth.touching(row.tag))
  })
})

describe('combining tags', () => {
  it('counts routes collecting every selected tag, on different passages', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      { tags: { B: ['sword'], D: ['castle'] } },
    )
    const c = combine(doc, ['sword', 'castle'])
    expect(c.all).toBe(1n)
    expect(c.allPercent).toBe(50)
  })

  it('reads zero when two tags never share a route', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['x'], C: ['y'] } })
    expect(combine(doc, ['x', 'y']).all).toBe(0n)
  })

  it('lets one passage satisfy two of the selected tags', () => {
    const doc = docFrom({ A: ['B'], B: [] }, { tags: { B: ['x', 'y'] } })
    expect(combine(doc, ['x', 'y']).all).toBe(1n)
  })

  it('does not care about the order the tags are given in', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      { tags: { B: ['sword'], D: ['castle'] } },
    )
    expect(combine(doc, ['castle', 'sword'])).toEqual(combine(doc, ['sword', 'castle']))
  })

  it('reconciles: none, plus the routes touching at least one, is every route', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D', 'E'], C: ['E', 'F'], D: [], E: ['G'], F: [], G: [] },
      { tags: { B: ['x'], E: ['y'], F: ['z'] } },
    )
    const truth = oracle(doc)
    const c = combine(doc, ['x', 'y', 'z'])
    expect(c.none).toBe(truth.none(['x', 'y', 'z']))
    expect(c.all).toBe(truth.all(['x', 'y', 'z']))
    expect(c.none + BigInt(routeTags(doc).filter((r) => ['x', 'y', 'z'].some((t) => r.has(t))).length)).toBe(
      c.totalRoutes,
    )
  })

  it('keeps `none` unsigned for an odd number of tags', () => {
    // The full-set term carries (-1)^k. Read off the sum rather than taken on
    // its own, three tags would report a negative count of routes.
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      { tags: { B: ['x'], D: ['y'], C: ['z'] } },
    )
    const c = combine(doc, ['x', 'y', 'z'])
    expect(c.none >= 0n).toBe(true)
    expect(c.none).toBe(oracle(doc).none(['x', 'y', 'z']))
  })

  it('agrees with a brute-force walk on every pair and triple', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D', 'E'], C: ['E', 'F'], D: ['G'], E: ['G'], F: [], G: [] },
      { tags: { B: ['x'], C: ['y'], E: ['z', 'x'], F: ['w'], G: ['y'] } },
    )
    const truth = oracle(doc)
    const names = ['w', 'x', 'y', 'z']
    for (const a of names) {
      for (const b of names) {
        expect(combine(doc, [a, b]).all).toBe(truth.all([a, b]))
        expect(combine(doc, [a, b]).none).toBe(truth.none([a, b]))
        for (const c of names) {
          expect(combine(doc, [a, b, c]).all).toBe(truth.all([a, b, c]))
          expect(combine(doc, [a, b, c]).none).toBe(truth.none([a, b, c]))
        }
      }
    }
  })

  it('matches the single-tag row when only one tag is selected', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['x'] } })
    expect(combine(doc, ['x']).all).toBe(rowOf(doc, 'x').routes)
  })

  it('reads zero, and says which tag is on no passage', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['x'] } })
    const c = combine(doc, ['x', 'ghost'])
    expect(c.all).toBe(0n)
    expect(c.missing).toEqual(['ghost'])
  })

  it('counts passages carrying every tag apart from routes collecting them', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      { tags: { B: ['sword'], D: ['castle'] } },
    )
    // One route collects both; no single passage carries both. Two questions.
    expect(combine(doc, ['sword', 'castle'])).toMatchObject({ all: 1n, passagesAll: 0 })
  })

  it('refuses more tags than it will count, rather than answering about fewer', () => {
    const many = Array.from({ length: MAX_COMBINED_TAGS + 1 }, (_, i) => `t${i}`)
    const doc = docFrom({ A: ['B'], B: [] }, { tags: { B: many } })
    const c = combine(doc, many)
    expect(c.overCap).toBe(true)
    expect(c.all).toBe(0n)
    expect(combine(doc, many.slice(0, MAX_COMBINED_TAGS)).overCap).toBe(false)
  })
})

describe('how often a route collects a tag', () => {
  it('separates a route collecting a tag twice from one collecting it once', () => {
    // A -> B -> D walks two tagged passages; A -> C -> D walks one. The
    // complement counts both as "touching" and cannot tell them apart.
    const doc = docFrom(DIAMOND, { tags: { B: ['combat'], D: ['combat'] } })
    const h = hitsOf(doc, 'combat')
    expect(h.totalRoutes).toBe(2n)
    expect(h.buckets).toEqual([0n, 1n, 1n, 0n])
    expect(h.percents).toEqual([0, 50, 50, 0])
  })

  it('partitions the routes: the buckets sum to the total', () => {
    // One route per bucket, so the sum is not a coincidence of zeroes.
    const doc = docFrom(
      {
        A: ['Z', 'W', 'X', 'Y'],
        Z: [],
        W: ['W1'],
        W1: [],
        X: ['X1'],
        X1: ['X2'],
        X2: [],
        Y: ['Y1'],
        Y1: ['Y2'],
        Y2: ['Y3'],
        Y3: [],
      },
      { tags: { W: ['t'], X: ['t'], X1: ['t'], Y: ['t'], Y1: ['t'], Y2: ['t'] } },
    )
    const h = hitsOf(doc, 't')
    expect(h.buckets).toEqual([1n, 1n, 1n, 1n])
    expect(h.buckets.reduce((a, b) => a + b, 0n)).toBe(h.totalRoutes)
  })

  it('agrees with the two numbers already on screen', () => {
    // `buckets[0]` is the complement's "none", reached the other way round, and
    // everything above it is the row's touching count. Two counters that
    // disagreed about one story would be worse than either.
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D', 'E'], C: ['E', 'F'], D: [], E: ['G'], F: [], G: [] },
      { tags: { B: ['x'], E: ['x'], F: ['x'], G: ['y'] } },
    )
    const h = hitsOf(doc, 'x')
    expect(h.buckets[0]).toBe(combine(doc, ['x']).none)
    expect(h.totalRoutes - h.buckets[0]!).toBe(rowOf(doc, 'x').routes)
  })

  it('lumps everything past the cap into the top bucket', () => {
    const doc = docFrom(
      { A: ['B'], B: ['C'], C: ['D'], D: ['E'], E: [] },
      { tags: { B: ['t'], C: ['t'], D: ['t'], E: ['t'] } },
    )
    // Four collections, one route, and the top bucket says "three or more".
    expect(hitsOf(doc, 't').buckets).toEqual([0n, 0n, 0n, 1n])
    expect(TAG_HIT_CAP).toBe(3)
  })

  it('counts the tag on a passage that is also a marked ending', () => {
    // The counterpart of the `blocked`-before-`endings` case above: the route
    // stopping on B has collected the tag it stops on, so it belongs at one.
    const doc = docFrom(DIAMOND, { tags: { B: ['finale'] }, endings: ['B'] })
    expect(hitsOf(doc, 'finale').buckets).toEqual([1n, 1n, 0n, 0n])
  })

  it('counts a tag on the start passage on every route', () => {
    const doc = docFrom(DIAMOND, { tags: { A: ['prologue'] } })
    expect(hitsOf(doc, 'prologue').buckets).toEqual([0n, 2n, 0n, 0n])
  })

  it('puts every route at zero for a tag no passage carries', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['x'] } })
    const h = hitsOf(doc, 'unused')
    expect(h.buckets).toEqual([2n, 0n, 0n, 0n])
    expect(h.percents[0]).toBe(100)
  })

  it('counts nothing at all for a story with no start passage', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['x'] } })
    doc.startNodeId = null
    expect(hitsOf(doc, 'x')).toMatchObject({ totalRoutes: 0n, buckets: [0n, 0n, 0n, 0n] })
  })

  it('collects nothing along a back edge or a self-link', () => {
    // The one route is A -> B -> C: two collections going forwards. The back
    // edge C -> B would be a third for a reader who circled, and is not a route.
    const doc = docFrom({ A: ['B'], B: ['C'], C: ['B'] }, { tags: { B: ['loop'], C: ['loop'] } })
    expect(hitsOf(doc, 'loop').buckets).toEqual([0n, 0n, 1n, 0n])
  })

  it('agrees with a brute-force walk of every route', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D', 'E'], C: ['E', 'F'], D: [], E: ['G'], F: [], G: [] },
      { tags: { B: ['x'], E: ['y', 'x'], F: ['z'], G: ['y'] } },
    )
    const truth = oracle(doc)
    for (const tag of ['x', 'y', 'z']) {
      expect(hitsOf(doc, tag).buckets).toEqual(truth.hits(tag))
    }
  })

  it('does not depend on the order the passages are stored in', () => {
    const doc = docFrom(DIAMOND, { tags: { A: ['x'], B: ['x'], C: ['y'], D: ['x', 'y'] } })
    const canonical = ['x', 'y'].map((t) => hitsOf(doc, t).buckets)
    for (const seed of [1, 7, 99]) {
      const mixed = { ...doc, nodes: shuffled(doc.nodes, seed) }
      expect(['x', 'y'].map((t) => hitsOf(mixed, t).buckets)).toEqual(canonical)
    }
  })
})

describe('countPathsAvoiding', () => {
  it('blocks a passage without inventing a route that stops before it', () => {
    // If `kids` were filtered instead of the walk returning zero at the top, A
    // would end up with no children and `kids.length === 0` means one route
    // ends here — a route that stops in the middle of the story.
    const doc = docFrom({ A: ['B'], B: ['C', 'D'], C: [], D: [] })
    const { graph, backEdges } = layoutStory(doc)
    const blocked = new Set([idOf(doc, 'C'), idOf(doc, 'D')])
    expect(countPathsAvoiding(graph, backEdges, doc.startNodeId, blocked)).toBe(0n)
  })

  it('means exactly countPaths when nothing is blocked', () => {
    const doc = docFrom(DIAMOND)
    const { graph, backEdges } = layoutStory(doc)
    expect(countPathsAvoiding(graph, backEdges, doc.startNodeId, new Set())).toBe(
      countPaths(graph, backEdges, doc.startNodeId!, NO_ENDINGS),
    )
  })

  it('counts zero for a story with no start passage', () => {
    const doc = docFrom(DIAMOND)
    const { graph, backEdges } = layoutStory(doc)
    expect(countPathsAvoiding(graph, backEdges, null, new Set())).toBe(0n)
  })

  it('refuses a cap with no bucket to saturate into', () => {
    const doc = docFrom(DIAMOND)
    const { graph, backEdges } = layoutStory(doc)
    // At cap 0 the only bucket would mean "zero or more", which is every route
    // — the exact opposite of what `[0]` is documented to hold.
    expect(() => countPathsByHits(graph, backEdges, doc.startNodeId, new Set(), 0)).toThrow()
  })

  it('is the histogram’s first bucket, and countPaths is its total', () => {
    // The two counters answer the same story from different directions, and the
    // panel prints both: "none of these" beside "exactly twice".
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: ['E', 'F'], E: [], F: [] },
      { tags: { B: ['t'], D: ['t'] } },
    )
    const { graph, backEdges } = layoutStory(doc)
    const marked = new Set([idOf(doc, 'B'), idOf(doc, 'D')])
    const buckets = countPathsByHits(graph, backEdges, doc.startNodeId, marked, TAG_HIT_CAP)
    expect(buckets[0]).toBe(countPathsAvoiding(graph, backEdges, doc.startNodeId, marked))
    expect(buckets.reduce((a, b) => a + b, 0n)).toBe(
      countPaths(graph, backEdges, doc.startNodeId!, NO_ENDINGS),
    )
  })
})

describe('degenerate stories', () => {
  it('reports zeroes when no passage is the start', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['x'] } })
    doc.startNodeId = null
    const s = tagStats(doc)
    expect(s.totalRoutes).toBe(0n)
    expect(rowOf(doc, 'x')).toMatchObject({ passages: 1, routes: 0n, percent: 0 })
    expect(combine(doc, ['x'])).toMatchObject({ all: 0n, none: 0n })
  })

  it('handles a story with no tags at all', () => {
    const s = tagStats(docFrom(DIAMOND))
    expect(s.rows).toEqual([])
    expect(s.taggedPassages).toBe(0)
  })

  it('handles a single tagged passage', () => {
    const doc = docFrom({ Only: [] }, { tags: { Only: ['x'] } })
    expect(rowOf(doc, 'x')).toMatchObject({ routes: 1n, percent: 100 })
  })

  it('counts the routes that stop at a broken link', () => {
    const doc = docFrom({ A: ['B', 'Ghost'], B: [] }, { tags: { B: ['x'] } })
    const s = tagStats(doc)
    expect(s.totalRoutes).toBe(2n)
    expect(s.brokenRoutes).toBe(1n)
  })
})

/**
 * The level breakdown on each row.
 *
 * No oracle here, unlike the route counts above: these are direct counts over
 * the passages, so a test that counts them directly is checking the answer, not
 * re-deriving the same clever trick. What the assertions have to pin instead is
 * the shape — that the buckets partition the row, that a missed level leaves no
 * entry, and that the denominator is passages rather than cards.
 */
describe('levels', () => {
  /** A -> B -> C -> D, so the levels are 1, 2, 3, 4. */
  const CHAIN = { A: ['B'], B: ['C'], C: ['D'], D: [] }

  const shape = (doc: StoryDoc, tag: string) =>
    rowOf(doc, tag).levels.map((l) => [l.level, l.passages, l.levelPassages, l.percent])

  it('splits a tag across the levels its passages sit on', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['x'], C: ['x'], D: ['x'] } })
    // Diamond levels: A 1, B and C 2, D 3.
    expect(shape(doc, 'x')).toEqual([
      [2, 2, 2, 100],
      [3, 1, 1, 100],
    ])
  })

  it('partitions the row: the buckets hold every passage exactly once', () => {
    const doc = docFrom(DIAMOND, { tags: { A: ['x'], B: ['x'], D: ['x', 'y'] } })
    for (const row of tagStats(doc).rows) {
      const sum = row.levels.reduce((n, l) => n + l.passages, 0)
      expect(sum).toBe(row.passages)
      expect(row.levels.flatMap((l) => l.nodeIds).sort()).toEqual([...row.nodeIds].sort())
    }
  })

  it('leaves no entry for a level the tag misses', () => {
    const doc = docFrom(CHAIN, { tags: { A: ['t'], C: ['t'] } })
    // Level 2 is occupied — by B, which is not tagged — so the gap is the
    // tag's, not the story's, and it shows up as an absent row rather than a zero.
    expect(shape(doc, 't')).toEqual([
      [1, 1, 1, 100],
      [3, 1, 1, 100],
    ])
  })

  it('measures a share against the other passages on that level', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['x'] } })
    expect(rowOf(doc, 'x').levels).toEqual([
      { level: 2, passages: 1, levelPassages: 2, percent: 50, nodeIds: [idOf(doc, 'B')] },
    ])
  })

  it('keeps phantoms out of the denominator', () => {
    const doc = docFrom({ A: ['B', 'Ghost'], B: [] }, { tags: { B: ['t'] } })
    // `Ghost` has a card and a level beside B, but it is not a passage and could
    // never carry a tag — counting it would read B's tag as half of its level.
    const lv = layoutStory(doc)
    expect(lv.nodeById.get(idOf(doc, 'B'))!.level).toBe(2)
    expect(lv.levels[1]!.count).toBe(2)
    expect(shape(doc, 't')).toEqual([[2, 1, 1, 100]])
  })

  it('follows a passage nudged down a level, denominator and all', () => {
    // A fan, so the three children share a level and nothing follows one down.
    const FAN = { A: ['B', 'C', 'D'], B: [], C: [], D: [] }
    const flat = docFrom(FAN, { tags: { B: ['x'], C: ['x'] } })
    expect(shape(flat, 'x')).toEqual([[2, 2, 3, 66.7]])

    // `levelOffset` is the one positional field in the document, so it is the
    // one edit that can move a row here without the prose changing.
    const nudged = docFrom(FAN, { tags: { B: ['x'], C: ['x'] }, offsets: { B: 1 } })
    expect(shape(nudged, 'x')).toEqual([
      [2, 1, 2, 50],
      [3, 1, 1, 100],
    ])
  })

  it('gives an unused tag no levels at all', () => {
    const doc = docFrom(DIAMOND, { tags: { B: ['x'] } })
    doc.tagColors = [...doc.tagColors, { name: 'ghosttag', color: 'none' }]
    expect(rowOf(doc, 'ghosttag')).toMatchObject({ passages: 0, levels: [] })
  })

  it('reads the same however the node array is ordered', () => {
    const doc = docFrom(DIAMOND, { tags: { A: ['x'], B: ['x'], C: ['y'], D: ['x', 'y'] } })
    const canonical = tagStats(doc).rows.map((r) => [r.tag, shape(doc, r.tag)])
    for (const seed of [1, 7, 99]) {
      const mixed = { ...doc, nodes: shuffled(doc.nodes, seed) }
      expect(tagStats(mixed).rows.map((r) => [r.tag, shape(mixed, r.tag)])).toEqual(canonical)
    }
  })
})
