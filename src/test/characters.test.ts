import { describe, expect, it } from 'vitest'
import { layoutStory } from '../lib/graph/layout'
import {
  castHits,
  combineCast,
  computeCastStats,
  CAST_HIT_CAP,
  MAX_COMBINED_CHARACTERS,
} from '../lib/graph/characters'
import type { StoryDoc } from '../types/story'
import { emptyCharacter } from '../types/story'
import { docFrom, shuffled } from './helpers'

function castStats(doc: StoryDoc) {
  return computeCastStats(doc, layoutStory(doc))
}

function combine(doc: StoryDoc, names: string[]) {
  return combineCast(doc, layoutStory(doc), names)
}

function rowOf(doc: StoryDoc, name: string) {
  return castStats(doc).rows.find((r) => r.key === name)!
}

function hitsOf(doc: StoryDoc, name: string) {
  return castHits(doc, layoutStory(doc), name)
}

function idOf(doc: StoryDoc, title: string): string {
  return doc.nodes.find((n) => n.title === title)!.id
}

/** Put a character on the roster without casting them into anything. */
function enrol(doc: StoryDoc, name: string): StoryDoc {
  return { ...doc, characters: [...doc.characters, emptyCharacter(name, doc.characters.length)] }
}

/**
 * Every route the slow way: walk the graph enumerating whole paths, and return
 * how many of each character's passages each route goes through.
 *
 * The oracle exists because the module under test never enumerates a route — it
 * counts complements, cancels subsets and carries a histogram — so a test that
 * reasoned the same way would only prove the reasoning consistent with itself.
 * This walks what a reader walks. It is exponential, so every fixture using it
 * stays small.
 *
 * The forward-edge predicate is re-derived inline rather than borrowed from
 * `forwardTargets`, for the same reason: an oracle that called the code under
 * test would agree with it by construction.
 *
 * A count per character rather than a set: "did this route meet them" is
 * `(count ?? 0) > 0`, so the touching and combining questions read straight off
 * it, while "in exactly two passages" needs the multiplicity a set throws away.
 */
function routeCast(doc: StoryDoc): Map<string, number>[] {
  const { graph, backEdges } = layoutStory(doc)
  const endings = new Set(doc.nodes.filter((n) => n.isEnding).map((n) => n.id))
  const castOf = new Map(doc.nodes.map((n) => [n.id, n.characters.map((c) => c.name)]))
  const out: Map<string, number>[] = []
  if (doc.startNodeId === null) return out

  const walk = (id: string, carried: Map<string, number>, seen: Set<string>) => {
    const here = new Map(carried)
    for (const name of castOf.get(id) ?? []) here.set(name, (here.get(name) ?? 0) + 1)

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

/** What the oracle says, for one character and for a set. */
function oracle(doc: StoryDoc) {
  const routes = routeCast(doc)
  const met = (r: Map<string, number>, name: string) => (r.get(name) ?? 0) > 0
  return {
    total: BigInt(routes.length),
    touching: (name: string) => BigInt(routes.filter((r) => met(r, name)).length),
    all: (names: string[]) => BigInt(routes.filter((r) => names.every((n) => met(r, n))).length),
    none: (names: string[]) => BigInt(routes.filter((r) => !names.some((n) => met(r, n))).length),
    // Saturating at the same place `castHits` does, so the two are comparable
    // bucket for bucket rather than only in total.
    hits: (name: string) => {
      const out = new Array<bigint>(CAST_HIT_CAP + 1).fill(0n)
      for (const r of routes) {
        const i = Math.min(r.get(name) ?? 0, CAST_HIT_CAP)
        out[i] = out[i]! + 1n
      }
      return out
    },
  }
}

const DIAMOND = { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] }

describe('routes meeting a character', () => {
  it('counts the routes through a character’s branch, not the passages casting them', () => {
    const doc = docFrom(DIAMOND, { casts: { B: ['Mira'] } })
    const s = castStats(doc)
    expect(s.totalRoutes).toBe(2n)
    expect(rowOf(doc, 'Mira')).toMatchObject({ passages: 1, routes: 1n, percent: 50 })
  })

  it('counts a route through two of a character’s passages exactly once', () => {
    // The trap the complement exists to avoid. `to(n) * from(n)` summed over
    // Mira's passages would say 3 routes out of 2 here; a route that meets her
    // twice is still one route.
    const doc = docFrom(
      { A: ['B', 'E'], B: ['C'], C: ['D'], D: [], E: [] },
      { casts: { B: ['Mira'], C: ['Mira'] } },
    )
    const s = castStats(doc)
    expect(s.totalRoutes).toBe(2n)
    expect(rowOf(doc, 'Mira').routes).toBe(1n)
    expect(rowOf(doc, 'Mira').passages).toBe(2)
  })

  it('reads 100% for a character cast in the start passage', () => {
    const doc = docFrom(DIAMOND, { casts: { A: ['Narrator'] } })
    expect(rowOf(doc, 'Narrator')).toMatchObject({ routes: 2n, percent: 100 })
  })

  it('keeps a roster member nobody has written yet in the table, at zero', () => {
    const doc = enrol(docFrom(DIAMOND, { casts: { B: ['Mira'] } }), 'Fen')
    expect(rowOf(doc, 'Fen')).toMatchObject({ passages: 0, routes: 0n, percent: 0 })
  })

  it('keeps a character cast without a roster entry, rather than dropping the row', () => {
    // Not something a mutation can produce — `addPassageCharacter` refuses an
    // off-roster name — but a hand-edited save file is not a mutation, and the
    // row the author most needs to see is the one that should not exist.
    const doc = docFrom(DIAMOND, { casts: { B: ['Mira'] } })
    const stray = { ...doc, characters: [] }
    expect(rowOf(stray, 'Mira')).toMatchObject({ passages: 1, routes: 1n })
  })

  it('counts a character cast in a passage that is also a marked ending', () => {
    // The case that fails loudly if `blocked` is ever checked after `endings`:
    // B returns 1n as an ending before anyone notices it is blocked, and the
    // route that stops on Mira gets counted as avoiding her.
    const doc = docFrom(DIAMOND, { casts: { B: ['Mira'] }, endings: ['B'] })
    expect(castStats(doc).totalRoutes).toBe(2n)
    expect(rowOf(doc, 'Mira').routes).toBe(1n)
  })

  it('says how many of a character’s passages no route reaches', () => {
    // Stranded past an ending: seven scenes, none of them on a route, is a true
    // and baffling row without this column.
    const doc = docFrom({ A: ['B'], B: ['C'], C: [] }, { casts: { C: ['Fen'] }, endings: ['B'] })
    expect(rowOf(doc, 'Fen')).toMatchObject({ passages: 1, offRoute: 1, routes: 0n })
  })

  it('reads zero for a character reachable only by a back edge or a self-link', () => {
    const doc = docFrom({ A: ['B'], B: ['C'], C: ['B'] }, { casts: { C: ['Tam'] } })
    // C is only ever entered forwards, so it is on the one route; the back edge
    // C -> B is what carries nothing.
    expect(castStats(doc).totalRoutes).toBe(1n)
    expect(rowOf(doc, 'Tam').routes).toBe(1n)

    const selfy = docFrom({ A: ['B'], B: ['B'] }, { casts: { B: ['Tam'] } })
    expect(rowOf(selfy, 'Tam').routes).toBe(1n)
  })

  it('orders by routes, then by name, and not by the author’s roster order', () => {
    // Roster order decides who is in the table; it does not decide the ranking.
    // `docFrom` enrols in order of first appearance, so the roster here reads
    // Bea, Abe, Zed and the table must not.
    const doc = docFrom(DIAMOND, { casts: { B: ['Bea', 'Abe'], A: ['Zed'] } })
    expect(castStats(doc).rows.map((r) => r.key)).toEqual(['Zed', 'Abe', 'Bea'])
  })

  it('agrees with a brute-force walk of every route', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D', 'E'], C: ['E', 'F'], D: [], E: ['G'], F: [], G: [] },
      { casts: { B: ['Mira'], E: ['Tam', 'Mira'], F: ['Fen'], G: ['Tam'] } },
    )
    const truth = oracle(doc)
    const s = castStats(doc)
    expect(s.totalRoutes).toBe(truth.total)
    for (const row of s.rows) expect(row.routes).toBe(truth.touching(row.key))
  })
})

describe('combining characters', () => {
  it('counts routes meeting every selected character, in different passages', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      { casts: { B: ['Mira'], D: ['Tam'] } },
    )
    const c = combine(doc, ['Mira', 'Tam'])
    expect(c.all).toBe(1n)
    expect(c.allPercent).toBe(50)
  })

  it('reads zero when two characters never share a route', () => {
    const doc = docFrom(DIAMOND, { casts: { B: ['Mira'], C: ['Tam'] } })
    expect(combine(doc, ['Mira', 'Tam']).all).toBe(0n)
  })

  it('lets one passage satisfy two of the selected characters', () => {
    const doc = docFrom({ A: ['B'], B: [] }, { casts: { B: ['Mira', 'Tam'] } })
    expect(combine(doc, ['Mira', 'Tam']).all).toBe(1n)
  })

  it('does not care about the order the names are given in', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      { casts: { B: ['Mira'], D: ['Tam'] } },
    )
    expect(combine(doc, ['Tam', 'Mira'])).toEqual(combine(doc, ['Mira', 'Tam']))
  })

  it('reconciles: none, plus the routes meeting at least one, is every route', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D', 'E'], C: ['E', 'F'], D: [], E: ['G'], F: [], G: [] },
      { casts: { B: ['Mira'], E: ['Tam'], F: ['Fen'] } },
    )
    const names = ['Mira', 'Tam', 'Fen']
    const truth = oracle(doc)
    const c = combine(doc, names)
    expect(c.none).toBe(truth.none(names))
    expect(c.all).toBe(truth.all(names))
    const met = routeCast(doc).filter((r) => names.some((n) => r.has(n))).length
    expect(c.none + BigInt(met)).toBe(c.totalRoutes)
  })

  it('keeps `none` unsigned for an odd number of characters', () => {
    // The full-set term carries (-1)^k. Read off the sum rather than taken on
    // its own, three names would report a negative count of routes.
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      { casts: { B: ['Mira'], D: ['Tam'], C: ['Fen'] } },
    )
    const c = combine(doc, ['Mira', 'Tam', 'Fen'])
    expect(c.none >= 0n).toBe(true)
    expect(c.none).toBe(oracle(doc).none(['Mira', 'Tam', 'Fen']))
  })

  it('agrees with a brute-force walk on every pair and triple', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D', 'E'], C: ['E', 'F'], D: ['G'], E: ['G'], F: [], G: [] },
      { casts: { B: ['Mira'], C: ['Tam'], E: ['Fen', 'Mira'], F: ['Vey'], G: ['Tam'] } },
    )
    const truth = oracle(doc)
    const names = ['Fen', 'Mira', 'Tam', 'Vey']
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

  it('matches the single-character row when only one is selected', () => {
    const doc = docFrom(DIAMOND, { casts: { B: ['Mira'] } })
    expect(combine(doc, ['Mira']).all).toBe(rowOf(doc, 'Mira').routes)
  })

  it('reads zero, and says which character is in no passage', () => {
    const doc = enrol(docFrom(DIAMOND, { casts: { B: ['Mira'] } }), 'Fen')
    const c = combine(doc, ['Mira', 'Fen'])
    expect(c.all).toBe(0n)
    expect(c.missing).toEqual(['Fen'])
  })

  it('counts passages sharing a scene apart from routes meeting both', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      { casts: { B: ['Mira'], D: ['Tam'] } },
    )
    // One route meets both; no single scene holds both. Two questions, and the
    // panel prints them on separate rows for exactly this reason.
    expect(combine(doc, ['Mira', 'Tam'])).toMatchObject({ all: 1n, passagesAll: 0 })
  })

  it('refuses more characters than it will count, rather than answering about fewer', () => {
    const many = Array.from({ length: MAX_COMBINED_CHARACTERS + 1 }, (_, i) => `C${i}`)
    const doc = docFrom({ A: ['B'], B: [] }, { casts: { B: many } })
    const c = combine(doc, many)
    expect(c.overCap).toBe(true)
    expect(c.all).toBe(0n)
    expect(combine(doc, many.slice(0, MAX_COMBINED_CHARACTERS)).overCap).toBe(false)
  })
})

describe('how much of a character a route gets', () => {
  it('separates a route meeting a character twice from one meeting them once', () => {
    // A -> B -> D walks two of Mira's passages; A -> C -> D walks one. The
    // complement counts both as "meeting" and cannot tell them apart.
    const doc = docFrom(DIAMOND, { casts: { B: ['Mira'], D: ['Mira'] } })
    const h = hitsOf(doc, 'Mira')
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
      {
        casts: {
          W: ['Mira'],
          X: ['Mira'],
          X1: ['Mira'],
          Y: ['Mira'],
          Y1: ['Mira'],
          Y2: ['Mira'],
        },
      },
    )
    const h = hitsOf(doc, 'Mira')
    expect(h.buckets).toEqual([1n, 1n, 1n, 1n])
    expect(h.buckets.reduce((a, b) => a + b, 0n)).toBe(h.totalRoutes)
  })

  it('agrees with the two numbers already on screen', () => {
    // `buckets[0]` is the complement's "none", reached the other way round, and
    // everything above it is the row's route count. Two counters that disagreed
    // about one story would be worse than either.
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D', 'E'], C: ['E', 'F'], D: [], E: ['G'], F: [], G: [] },
      { casts: { B: ['Mira'], E: ['Mira'], F: ['Mira'], G: ['Tam'] } },
    )
    const h = hitsOf(doc, 'Mira')
    expect(h.buckets[0]).toBe(combine(doc, ['Mira']).none)
    expect(h.totalRoutes - h.buckets[0]!).toBe(rowOf(doc, 'Mira').routes)
  })

  it('lumps everything past the cap into the top bucket', () => {
    const doc = docFrom(
      { A: ['B'], B: ['C'], C: ['D'], D: ['E'], E: [] },
      { casts: { B: ['Mira'], C: ['Mira'], D: ['Mira'], E: ['Mira'] } },
    )
    // Four scenes, one route, and the top bucket says "three or more passages".
    expect(hitsOf(doc, 'Mira').buckets).toEqual([0n, 0n, 0n, 1n])
    expect(CAST_HIT_CAP).toBe(3)
  })

  it('counts the character on a passage that is also a marked ending', () => {
    // The counterpart of the `blocked`-before-`endings` case above: the route
    // stopping on B has met the character it stops on, so it belongs at one.
    const doc = docFrom(DIAMOND, { casts: { B: ['Mira'] }, endings: ['B'] })
    expect(hitsOf(doc, 'Mira').buckets).toEqual([1n, 1n, 0n, 0n])
  })

  it('counts a character in the start passage on every route', () => {
    const doc = docFrom(DIAMOND, { casts: { A: ['Narrator'] } })
    expect(hitsOf(doc, 'Narrator').buckets).toEqual([0n, 2n, 0n, 0n])
  })

  it('puts every route at zero for a character no passage casts', () => {
    const doc = enrol(docFrom(DIAMOND, { casts: { B: ['Mira'] } }), 'Fen')
    const h = hitsOf(doc, 'Fen')
    expect(h.buckets).toEqual([2n, 0n, 0n, 0n])
    expect(h.percents[0]).toBe(100)
  })

  it('counts nothing at all for a story with no start passage', () => {
    const doc = docFrom(DIAMOND, { casts: { B: ['Mira'] } })
    doc.startNodeId = null
    expect(hitsOf(doc, 'Mira')).toMatchObject({ totalRoutes: 0n, buckets: [0n, 0n, 0n, 0n] })
  })

  it('meets nobody along a back edge or a self-link', () => {
    // The one route is A -> B -> C: two scenes going forwards. The back edge
    // C -> B would be a third for a reader who circled, and is not a route.
    const doc = docFrom(
      { A: ['B'], B: ['C'], C: ['B'] },
      { casts: { B: ['Mira'], C: ['Mira'] } },
    )
    expect(hitsOf(doc, 'Mira').buckets).toEqual([0n, 0n, 1n, 0n])
  })

  it('agrees with a brute-force walk of every route', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D', 'E'], C: ['E', 'F'], D: [], E: ['G'], F: [], G: [] },
      { casts: { B: ['Mira'], E: ['Tam', 'Mira'], F: ['Fen'], G: ['Tam'] } },
    )
    const truth = oracle(doc)
    for (const name of ['Mira', 'Tam', 'Fen']) {
      expect(hitsOf(doc, name).buckets).toEqual(truth.hits(name))
    }
  })

  it('does not depend on the order the passages are stored in', () => {
    const doc = docFrom(DIAMOND, {
      casts: { A: ['Mira'], B: ['Mira'], C: ['Tam'], D: ['Mira', 'Tam'] },
    })
    const canonical = ['Mira', 'Tam'].map((n) => hitsOf(doc, n).buckets)
    for (const seed of [1, 7, 99]) {
      const mixed = { ...doc, nodes: shuffled(doc.nodes, seed) }
      expect(['Mira', 'Tam'].map((n) => hitsOf(mixed, n).buckets)).toEqual(canonical)
    }
  })
})

describe('degenerate stories', () => {
  it('reports zeroes when no passage is the start', () => {
    const doc = docFrom(DIAMOND, { casts: { B: ['Mira'] } })
    doc.startNodeId = null
    const s = castStats(doc)
    expect(s.totalRoutes).toBe(0n)
    expect(rowOf(doc, 'Mira')).toMatchObject({ passages: 1, routes: 0n, percent: 0 })
    expect(combine(doc, ['Mira'])).toMatchObject({ all: 0n, none: 0n })
  })

  it('handles a story with no cast at all', () => {
    const s = castStats(docFrom(DIAMOND))
    expect(s.rows).toEqual([])
    expect(s.coveredPassages).toBe(0)
  })

  it('handles a single passage with one character', () => {
    const doc = docFrom({ Only: [] }, { casts: { Only: ['Mira'] } })
    expect(rowOf(doc, 'Mira')).toMatchObject({ routes: 1n, percent: 100 })
  })

  it('counts the routes that stop at a broken link', () => {
    const doc = docFrom({ A: ['B', 'Ghost'], B: [] }, { casts: { B: ['Mira'] } })
    const s = castStats(doc)
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

  const shape = (doc: StoryDoc, name: string) =>
    rowOf(doc, name).levels.map((l) => [l.level, l.passages, l.levelPassages, l.percent])

  it('splits a character across the levels their passages sit on', () => {
    const doc = docFrom(DIAMOND, { casts: { B: ['Mira'], C: ['Mira'], D: ['Mira'] } })
    // Diamond levels: A 1, B and C 2, D 3.
    expect(shape(doc, 'Mira')).toEqual([
      [2, 2, 2, 100],
      [3, 1, 1, 100],
    ])
  })

  it('partitions the row: the buckets hold every passage exactly once', () => {
    const doc = docFrom(DIAMOND, { casts: { A: ['Mira'], B: ['Mira'], D: ['Mira', 'Tam'] } })
    for (const row of castStats(doc).rows) {
      const sum = row.levels.reduce((n, l) => n + l.passages, 0)
      expect(sum).toBe(row.passages)
      expect(row.levels.flatMap((l) => l.nodeIds).sort()).toEqual([...row.nodeIds].sort())
    }
  })

  it('leaves no entry for a level the character misses', () => {
    const doc = docFrom(CHAIN, { casts: { A: ['Mira'], C: ['Mira'] } })
    // Level 2 is occupied — by B, which Mira is not in — so the gap is hers, not
    // the story's, and it shows up as an absent row rather than a zero.
    expect(shape(doc, 'Mira')).toEqual([
      [1, 1, 1, 100],
      [3, 1, 1, 100],
    ])
  })

  it('measures a share against the other passages on that level', () => {
    const doc = docFrom(DIAMOND, { casts: { B: ['Mira'] } })
    expect(rowOf(doc, 'Mira').levels).toEqual([
      { level: 2, passages: 1, levelPassages: 2, percent: 50, nodeIds: [idOf(doc, 'B')] },
    ])
  })

  it('keeps phantoms out of the denominator', () => {
    const doc = docFrom({ A: ['B', 'Ghost'], B: [] }, { casts: { B: ['Mira'] } })
    // `Ghost` has a card and a level beside B, but it is not a passage and could
    // never hold a cast — counting it would read Mira as half of her level.
    const lv = layoutStory(doc)
    expect(lv.nodeById.get(idOf(doc, 'B'))!.level).toBe(2)
    expect(lv.levels[1]!.count).toBe(2)
    expect(shape(doc, 'Mira')).toEqual([[2, 1, 1, 100]])
  })

  it('follows a passage nudged down a level, denominator and all', () => {
    // A fan, so the three children share a level and nothing follows one down.
    const FAN = { A: ['B', 'C', 'D'], B: [], C: [], D: [] }
    const flat = docFrom(FAN, { casts: { B: ['Mira'], C: ['Mira'] } })
    expect(shape(flat, 'Mira')).toEqual([[2, 2, 3, 66.7]])

    // `levelOffset` is the one positional field in the document, so it is the
    // one edit that can move a row here without the prose changing.
    const nudged = docFrom(FAN, { casts: { B: ['Mira'], C: ['Mira'] }, offsets: { B: 1 } })
    expect(shape(nudged, 'Mira')).toEqual([
      [2, 1, 2, 50],
      [3, 1, 1, 100],
    ])
  })

  it('gives an uncast roster member no levels at all', () => {
    const doc = enrol(docFrom(DIAMOND, { casts: { B: ['Mira'] } }), 'Fen')
    expect(rowOf(doc, 'Fen')).toMatchObject({ passages: 0, levels: [] })
  })

  it('reads the same however the node array is ordered', () => {
    const doc = docFrom(DIAMOND, {
      casts: { A: ['Mira'], B: ['Mira'], C: ['Tam'], D: ['Mira', 'Tam'] },
    })
    const canonical = castStats(doc).rows.map((r) => [r.key, shape(doc, r.key)])
    for (const seed of [1, 7, 99]) {
      const mixed = { ...doc, nodes: shuffled(doc.nodes, seed) }
      expect(castStats(mixed).rows.map((r) => [r.key, shape(mixed, r.key)])).toEqual(canonical)
    }
  })
})
