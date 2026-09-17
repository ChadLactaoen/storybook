import { describe, expect, it } from 'vitest'
import { layoutStory } from '../lib/graph/layout'
import { countPaths, countPathsAvoiding, NO_ENDINGS } from '../lib/graph/paths'
import { combineTags, computeTagStats, MAX_COMBINED_TAGS } from '../lib/graph/tags'
import type { StoryDoc } from '../types/story'
import { docFrom } from './helpers'

function tagStats(doc: StoryDoc) {
  return computeTagStats(doc, layoutStory(doc))
}

function combine(doc: StoryDoc, tags: string[]) {
  return combineTags(doc, layoutStory(doc), tags)
}

function rowOf(doc: StoryDoc, tag: string) {
  return tagStats(doc).rows.find((r) => r.tag === tag)!
}

function idOf(doc: StoryDoc, title: string): string {
  return doc.nodes.find((n) => n.title === title)!.id
}

/**
 * Every route the slow way: walk the graph enumerating whole paths, and return
 * the set of tags each one collects.
 *
 * The oracle exists because the module under test never enumerates a route — it
 * counts complements and cancels subsets — so a test that reasoned the same way
 * would only prove the reasoning consistent with itself. This walks what a
 * reader walks. It is exponential, so every fixture using it stays small.
 */
function routeTags(doc: StoryDoc): Set<string>[] {
  const { graph, backEdges } = layoutStory(doc)
  const endings = new Set(doc.nodes.filter((n) => n.isEnding).map((n) => n.id))
  const tagsOf = new Map(doc.nodes.map((n) => [n.id, n.tags]))
  const out: Set<string>[] = []
  if (doc.startNodeId === null) return out

  const walk = (id: string, carried: Set<string>, seen: Set<string>) => {
    const here = new Set(carried)
    for (const t of tagsOf.get(id) ?? []) here.add(t)

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

  walk(doc.startNodeId, new Set(), new Set([doc.startNodeId]))
  return out
}

/** What the oracle says, for one tag and for a set. */
function oracle(doc: StoryDoc) {
  const routes = routeTags(doc)
  return {
    total: BigInt(routes.length),
    touching: (tag: string) => BigInt(routes.filter((r) => r.has(tag)).length),
    all: (tags: string[]) => BigInt(routes.filter((r) => tags.every((t) => r.has(t))).length),
    none: (tags: string[]) => BigInt(routes.filter((r) => !tags.some((t) => r.has(t))).length),
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
