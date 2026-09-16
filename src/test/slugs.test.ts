/**
 * Running slugs: what a reader would have collected on the way here.
 *
 * Every test names passages by title and reads the result the same way, so what
 * a shape spells is the whole assertion.
 */

import { describe, expect, it } from 'vitest'
import { findBackEdges } from '../lib/graph/acyclic'
import { deriveGraph } from '../lib/graph/derive'
import { assignLevels } from '../lib/graph/layering'
import { gatesOf } from '../lib/graph/gates'
import { reachableFrom } from '../lib/graph/reachability'
import type { Seg } from '../lib/graph/slugs'
import { marksAhead, render, runningSlugs, segmentsOf, unify } from '../lib/graph/slugs'
import { readStoryMacros } from '../lib/harlowe/macros'
import type { StoryDoc } from '../types/story'
import { docFrom, shuffled } from './helpers'

/** Running slugs, keyed by title. A missing key means no route arrives. */
function runs(doc: StoryDoc): Record<string, string> {
  const g = deriveGraph(doc)
  const { backEdges } = findBackEdges(g, doc.startNodeId)
  const slugOf = new Map(doc.nodes.map((n) => [n.id, n.slug]))
  const endings = new Set(doc.nodes.filter((n) => n.isEnding).map((n) => n.id))

  const out = runningSlugs(g, {
    backEdges,
    startId: doc.startNodeId,
    endings,
    slugOf: (id) => slugOf.get(id) ?? '',
  })

  const titleOf = new Map(doc.nodes.map((n) => [n.id, n.title]))
  const byTitle: Record<string, string> = {}
  for (const [id, r] of out) byTitle[titleOf.get(id) ?? id] = r
  return byTitle
}

/** A slug per passage, named after the passage, so a spelling reads literally. */
const MARKS = { A: 'A', B: 'B', C: 'C', D: 'D', H: 'H', S: 'S', Z: 'Z', M: 'M' }

describe('the route a running slug spells', () => {
  it('runs the marks together along a single route', () => {
    const doc = docFrom({ A: ['B'], B: ['D'], D: [] }, { slugs: MARKS })
    expect(runs(doc)).toEqual({ A: 'A', B: 'AB', D: 'ABD' })
  })

  it('writes a star where the routes disagree', () => {
    // The issue's example. Every route to D passes A and D, so those are stated;
    // which of B or C a reader saw is not something the card can know.
    const doc = docFrom({ A: ['B', 'C'], B: ['D'], C: ['D'], D: [] }, { slugs: MARKS })
    expect(runs(doc).D).toBe('A*D')
  })

  it('says nothing for a passage with no mark', () => {
    // An unslugged passage contributes nothing, which is what lets an author
    // mark only the branch points that matter.
    const doc = docFrom({ A: ['B'], B: ['D'], D: [] }, { slugs: { A: 'A', D: 'D' } })
    expect(runs(doc)).toEqual({ A: 'A', B: 'A', D: 'AD' })
  })

  it('stars a gap when only one side of it is marked', () => {
    // Routes spell `AD` and `ACD`. They disagree, so the card may not claim
    // either — even though the passage that differs is the unmarked one.
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      { slugs: { A: 'A', C: 'C', D: 'D' } },
    )
    expect(runs(doc).D).toBe('A*D')
  })

  it('leaves a gap alone when nothing in it is marked', () => {
    // Both routes spell `AD`, so there is nothing to warn about. This is the
    // case that keeps the feature usable: mark the forks, ignore the corridors.
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      { slugs: { A: 'A', D: 'D' } },
    )
    expect(runs(doc).D).toBe('AD')
  })

  it('collapses adjacent stars, because two say nothing one does not', () => {
    // Two varying gaps with an unmarked passage between them. `A**Z` would
    // suggest the middle were readable.
    const doc = docFrom(
      { A: ['B', 'C'], B: ['M'], C: ['M'], M: ['D', 'S'], D: ['Z'], S: ['Z'], Z: [] },
      { slugs: { A: 'A', B: 'B', C: 'C', D: 'D', S: 'S', Z: 'Z' } },
    )
    expect(runs(doc).M).toBe('A*')
    expect(runs(doc).Z).toBe('A*Z')
  })

  it('stars a gap whose mark sits further up than the passage before it', () => {
    // A shortcut `A -> D` beside the long way round. The predecessor on the
    // long route (C) carries no mark of its own, so what differs was collected
    // further back. Routes spell `AD` and `ABD`.
    const doc = docFrom(
      { A: ['B', 'D'], B: ['C'], C: ['D'], D: [] },
      { slugs: { A: 'A', B: 'B', D: 'D' } },
    )
    expect(runs(doc).D).toBe('A*D')
  })

  it('stars a gap that varies further up than the passage before it', () => {
    // Same shape, but what differs on the long route is itself a fork rather
    // than a single mark, so the marker being folded in is one an earlier
    // passage already wrote rather than a mark of its own.
    const doc = docFrom(
      { A: ['B', 'C', 'D'], B: ['M'], C: ['M'], M: ['D'], D: [] },
      { slugs: { A: 'A', B: 'B', C: 'C', D: 'D' } },
    )
    expect(runs(doc).M).toBe('A*')
    expect(runs(doc).D).toBe('A*D')
  })

  it('keeps a mark two different passages agree on', () => {
    // Two routes in, of different lengths, both ending on a passage marked `D`
    // before they arrive. They are different passages, so nothing structural
    // can tell that both spellings finish `DZ` — only the strings can.
    //
    //   via A:  1 X U    D Z
    //   via B:  1 Y U Yn D Z
    //
    // The most specific true description is `1*U*DZ`: every route spells 1,
    // then something, then U, then something, then D and Z.
    const doc = docFrom(
      {
        S: ['F1', 'F2'],
        F1: ['U'],
        F2: ['U'],
        U: ['A', 'Yn'],
        A: ['C'],
        Yn: ['B'],
        B: ['C'],
        C: [],
      },
      { slugs: { S: '1', F1: 'X', F2: 'Y', U: 'U', A: 'D', Yn: 'Yn', B: 'D', C: 'Z' } },
    )
    const out = runs(doc)
    expect(out.A).toBe('1*UD')
    expect(out.B).toBe('1*UYnD')
    expect(out.C).toBe('1*U*DZ')
  })

  it('never writes two markers in a row, however the routes nest', () => {
    // Varying stretches on both sides of a passage that is itself reached two
    // ways: the head of one answer ends in a marker and the tail of the other
    // begins with one, and they must still fold into a single marker.
    const doc = docFrom(
      {
        A: ['B', 'C'],
        B: ['M'],
        C: ['M'],
        M: ['D', 'E'],
        D: ['N'],
        E: ['N'],
        N: ['P', 'Q'],
        P: ['Z'],
        Q: ['Z'],
        Z: [],
      },
      { slugs: { A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', P: 'P', Q: 'Q', Z: 'Z' } },
    )
    const out = runs(doc)
    expect(out.Z).toBe('A*Z')
    for (const r of Object.values(out)) expect(r).not.toContain('**')
  })

  it('gives each branch of a fork that rejoins nothing its own mark', () => {
    const doc = docFrom({ A: ['B', 'C'], B: [], C: [] }, { slugs: MARKS })
    expect(runs(doc)).toEqual({ A: 'A', B: 'AB', C: 'AC' })
  })
})

describe('loops, which the route model cannot see round', () => {
  // `forwardTargets` drops the back edge, so the route model says S has exactly
  // one spelling. A reader can walk A H C H S and hold `AHCHS`.
  const HUB = { A: ['H'], H: ['C', 'S'], C: ['H'], S: [] }

  it('stars the loop head when a mark sits on the loop', () => {
    const doc = docFrom(HUB, { slugs: MARKS })
    expect(runs(doc).H).toBe('AH*')
    expect(runs(doc).S).toBe('AH*S')
    expect(runs(doc).C).toBe('AH*C')
  })

  it('stars it for the mark on the head, which going round collects twice', () => {
    const doc = docFrom(HUB, { slugs: { A: 'A', H: 'H', S: 'S' } })
    expect(runs(doc).S).toBe('AH*S')
  })

  it('costs nothing when no mark sits on the loop at all', () => {
    // The common case, and the reason this is affordable: a hub story with its
    // marks on the spokes reads exactly as it would without loops.
    const doc = docFrom(HUB, { slugs: { A: 'A', S: 'S' } })
    expect(runs(doc).S).toBe('AS')
  })

  it('ignores a self-link with no mark on it', () => {
    const doc = docFrom({ A: ['B'], B: ['B', 'D'], D: [] }, { slugs: { A: 'A', D: 'D' } })
    expect(runs(doc).D).toBe('AD')
  })
})

describe('passages no route reaches', () => {
  it('leaves out an island', () => {
    const doc = docFrom({ A: ['B'], B: [], X: ['Y'], Y: [] }, { slugs: { A: 'A', X: 'X' } })
    const out = runs(doc)
    expect(out.A).toBe('A')
    expect(out.X).toBeUndefined()
    expect(out.Y).toBeUndefined()
  })

  it('leaves out what is stranded behind an ending', () => {
    const doc = docFrom({ A: ['B'], B: ['D'], D: [] }, { slugs: MARKS, endings: ['B'] })
    const out = runs(doc)
    expect(out.B).toBe('AB')
    expect(out.D).toBeUndefined()
  })

  it('leaves out the whole story when the start is itself an ending', () => {
    // In-model correct and visually startling: routes stop before they begin.
    const doc = docFrom({ A: ['B'], B: [] }, { slugs: MARKS, endings: ['A'] })
    expect(runs(doc)).toEqual({ A: 'A' })
  })

  it('handles a passage that links into the start', () => {
    // Puts the start at level 2, so a node it cannot reach is ordered ahead of
    // it. The start is claimed before anything counts predecessors, or the
    // traversal would never begin.
    const doc = docFrom({ A: ['B'], B: [], X: ['A'] }, { slugs: { A: 'A', B: 'B', X: 'X' } })
    const out = runs(doc)
    expect(out.A).toBe('A')
    expect(out.B).toBe('AB')
    expect(out.X).toBeUndefined()
  })

  it('returns nothing at all when there is no start passage', () => {
    const doc = docFrom({ A: ['B'], B: [] }, { slugs: MARKS })
    expect(runs({ ...doc, startNodeId: null })).toEqual({})
  })

  it('leaves out a phantom, which has no passage to mark', () => {
    // It has a card and a place on the canvas, but rendering the answer of
    // the passage before it would put a route code on something that does
    // not exist.
    const doc = docFrom({ A: ['Ghost'] }, { slugs: { A: 'A' } })
    expect(runs(doc)).toEqual({ A: 'A' })
  })
})

describe('what a running slug does not claim', () => {
  it('stars a fork that `gates` can prove nobody takes', () => {
    // The two analyses answer the same question from different evidence, and
    // they are allowed to disagree in this direction: `gates` reads the macros
    // and knows the branch is dead, the slug reads the graph and sees a fork.
    // Both are failing closed — a star costs precision, and `gates` saying
    // nothing costs precision. Neither states anything false.
    const base = docFrom({ A: ['B', 'C'], B: ['D'], C: ['D'], D: [] }, { slugs: MARKS })
    const doc: StoryDoc = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.title === 'A' ? { ...n, body: '[[On|P2]]\n(if:$never is "x")[[On|P3]]' } : n,
      ),
    }

    const g = deriveGraph(doc)
    const { backEdges } = findBackEdges(g, doc.startNodeId)
    const offsets = new Map(doc.nodes.map((n) => [n.id, n.levelOffset]))
    const lv = assignLevels(g, backEdges, (id) => offsets.get(id) ?? 0)
    const { guardOf, assignersOf, opaqueVars } = readStoryMacros(doc.nodes)
    const gates = gatesOf(g, {
      backEdges,
      levelOf: lv.level,
      guardOf,
      assignersOf,
      opaqueVars,
      isAncestor: (gate, node) => reachableFrom(g, gate).has(node),
    })

    const cId = doc.nodes.find((n) => n.title === 'C')!.id
    expect(gates.get(cId)!.dead).toBe(true)
    expect(runs(doc).D).toBe('A*D')
  })

  it('is allowed to collide between passages', () => {
    // All three spell `A`, and that is right: a running slug names the route so
    // far, not the passage standing at the end of it. `code` is the identity.
    const doc = docFrom({ A: ['B'], B: ['D'], D: [] }, { slugs: { A: 'A' } })
    expect(runs(doc)).toEqual({ A: 'A', B: 'A', D: 'A' })
  })
})

describe('unify, which is where the marks are decided', () => {
  /** A run is a list of marks; `*` stands for one a previous fold already left. */
  const runOf = (...marks: string[]): Seg[] =>
    marks.flatMap((m) => (m === '*' ? [{ kind: 'star' } as Seg] : segmentsOf(m)))

  it.each([
    ['identical patterns are left alone', ['A', '*', 'D'], ['A', '*', 'D'], 'A*D'],
    ['a plain difference stars', ['A', 'B'], ['A', 'C'], 'A*'],
    ['a shared tail survives a differing middle', ['1', '*', 'U', 'D'], ['1', '*', 'U', 'Yn', 'D'], '1*U*D'],
    ['markers on both sides of the join fold into one', ['A', '*', 'B', '*', 'C'], ['A', '*', 'X', '*', 'C'], 'A*C'],
    ['a marker absorbs what follows it', ['A', '*'], ['A', '*', 'B'], 'A*'],
    ['a literal generalizes to a marker', ['A', '*', 'B'], ['A', 'B'], 'A*B'],
    ['the halves may not quote the same mark twice', ['A', 'A'], ['A'], 'A*'],
    ['a shared tail with nothing shared in front', ['X', 'Y'], ['Y'], '*Y'],
    ['nothing in common at all', ['A', '*'], ['B', '*'], '*'],
    ['an empty run against a mark', [], ['A'], '*'],

    // A mark is atomic. Compared by character, `Ab` against `Bb` answers `*b`,
    // which invents a `b` no reader ever wrote down as a mark of its own.
    ['a mark is atomic, however its letters line up', ['Ab'], ['Bb'], '*'],
    ['two marks are not one, however they concatenate', ['A', 'B'], ['AB'], '*'],
  ])('%s', (_label, a, b, want) => {
    expect(render(unify(runOf(...a), runOf(...b)))).toBe(want)
    // Order cannot matter: a generalization is symmetric.
    expect(render(unify(runOf(...b), runOf(...a)))).toBe(want)
  })

  it('never returns a doubled marker', () => {
    const runs = [[], ['A'], ['A', '*'], ['*', 'A'], ['A', '*', 'B'], ['A', 'B'], ['*'],
      ['A', '*', 'B', '*', 'C'], ['A', 'A'], ['Yn', '*', 'D'], ['A(a)'], ['A(a)', '*']]
    for (const a of runs) {
      for (const b of runs) expect(render(unify(runOf(...a), runOf(...b)))).not.toContain('**')
    }
  })
})

describe('parentheses, which group part of a mark', () => {
  const runOf = (...marks: string[]): Seg[] => marks.flatMap(segmentsOf)

  it('splits a mark into its stem and its groups', () => {
    expect(segmentsOf('A(a)')).toEqual([
      { kind: 'text', value: 'A' },
      { kind: 'group', value: 'a' },
    ])
    expect(segmentsOf('A')).toEqual([{ kind: 'text', value: 'A' }])
    expect(segmentsOf('(a)')).toEqual([{ kind: 'group', value: 'a' }])
    expect(segmentsOf('')).toEqual([])
  })

  it.each([
    ['an unclosed bracket', 'A(a'],
    ['a stray close', 'Aa)'],
    ['a nested group', 'A((a))'],
    ['a close before an open', 'A)a('],
  ])('leaves %s alone as one opaque mark', (_label, slug) => {
    // Fail-closed: guessing at the structure would let the tool split a mark
    // somewhere the author did not, and an opaque mark only costs precision.
    expect(segmentsOf(slug)).toEqual([{ kind: 'text', value: slug }])
  })

  it.each([
    ['the group differs, the stem does not', 'A(a)', 'A(b)', 'A(*)'],
    ['the stem differs, the group does not', 'A(a)', 'B(a)', '*(a)'],
    ['both differ, and both keep their shape', 'A(a)', 'B(b)', '*(*)'],
    ['a shared letter in the stem counts for nothing', 'Ab(a)', 'Bb(a)', '*(a)'],
    ['nor does a stem of the same length', 'Aa(a)', 'Bb(a)', '*(a)'],
  ])('%s: %s vs %s', (_label, a, b, want) => {
    expect(render(unify(runOf(a), runOf(b)))).toBe(want)
    expect(render(unify(runOf(b), runOf(a)))).toBe(want)
  })

  it('carries the reported shapes through a real fork', () => {
    // Two siblings, each marked, rejoining on a passage marked `C`.
    const spec = { S: ['A', 'B'], A: ['C'], B: ['C'], C: [] }
    const at = (a: string, b: string) =>
      runs(docFrom(spec, { slugs: { A: a, B: b, C: 'C' } })).C

    expect(at('A(a)', 'A(b)')).toBe('A(*)C')
    expect(at('A(a)', 'B(a)')).toBe('*(a)C')
    expect(at('A(a)', 'B(b)')).toBe('*(*)C')
    expect(at('Ab(a)', 'Bb(a)')).toBe('*(a)C')
    expect(at('Aa(a)', 'Bb(a)')).toBe('*(a)C')
  })
})

describe('where a running slug is worth showing', () => {
  function live(doc: Parameters<typeof runs>[0]): string[] {
    const g = deriveGraph(doc)
    const { backEdges } = findBackEdges(g, doc.startNodeId)
    const slugOf = new Map(doc.nodes.map((n) => [n.id, n.slug]))
    const endings = new Set(doc.nodes.filter((n) => n.isEnding).map((n) => n.id))
    const out = marksAhead(g, { backEdges, endings, slugOf: (id) => slugOf.get(id) ?? '' })
    return doc.nodes
      .filter((n) => out.has(n.id))
      .map((n) => n.title)
      .sort()
  }

  it('drops the tail once nothing below carries a mark', () => {
    // S is marked and D is marked, so B and C are still on the way somewhere.
    // E and F will spell `AD` for ever, and their cards say nothing.
    const doc = docFrom(
      { S: ['B'], B: ['C'], C: ['D'], D: ['E'], E: ['F'], F: [] },
      { slugs: { S: 'A', D: 'D' } },
    )
    expect(live(doc)).toEqual(['B', 'C', 'D', 'S'])
    // The code itself is unchanged — the search box and the inspector still
    // have it, which is the point of keeping this a separate question.
    expect(runs(doc).F).toBe('AD')
  })

  it('keeps only the marked passage when it is the last one marked', () => {
    const doc = docFrom({ S: ['B'], B: ['C'], C: [] }, { slugs: { S: 'A' } })
    expect(live(doc)).toEqual(['S'])
    expect(runs(doc).C).toBe('A')
  })

  it('says nothing anywhere when the story has no marks at all', () => {
    const doc = docFrom({ S: ['B'], B: [] })
    expect(live(doc)).toEqual([])
  })

  it('does not let a mark stranded past an ending keep a tail alive', () => {
    // No route reaches D, so nothing on the way to it is on the way anywhere.
    const doc = docFrom({ S: ['B'], B: ['D'], D: [] }, { slugs: { D: 'D' }, endings: ['B'] })
    expect(live(doc)).toEqual(['D'])
  })
})

describe('determinism', () => {
  it('spells the same however the nodes are ordered', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['M'], C: ['M'], M: ['D', 'S'], D: ['Z'], S: ['Z'], Z: [] },
      { slugs: MARKS },
    )
    const base = runs(doc)
    for (let i = 0; i < 4; i += 1) {
      expect(runs({ ...doc, nodes: shuffled(doc.nodes, i + 7) })).toEqual(base)
    }
  })
})
