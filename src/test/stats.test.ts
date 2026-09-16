import { describe, expect, it } from 'vitest'
import { findBackEdges } from '../lib/graph/acyclic'
import { deriveGraph } from '../lib/graph/derive'
import { layoutStory } from '../lib/graph/layout'
import { countPaths, countPathsTo, countPathsToAll, share } from '../lib/graph/paths'
import { computeStoryStats, wordCount } from '../lib/graph/stats'
import type { StoryDoc } from '../types/story'
import { docFrom } from './helpers'

const BINARY_2 = { Root: ['L', 'R'], L: [], R: [] }

function stats(doc: StoryDoc) {
  return computeStoryStats(doc, layoutStory(doc))
}

function idOf(doc: StoryDoc, title: string): string {
  return doc.nodes.find((n) => n.title === title)!.id
}

/** The raw counters, for the cases that are about `paths.ts` rather than the panel. */
function counts(doc: StoryDoc) {
  const g = deriveGraph(doc)
  const { backEdges } = findBackEdges(g, doc.startNodeId)
  const endings = new Set(doc.nodes.filter((n) => n.isEnding).map((n) => n.id))
  return {
    from: (title: string) => countPaths(g, backEdges, idOf(doc, title), endings),
    to: (title: string) => countPathsTo(g, backEdges, idOf(doc, title), doc.startNodeId, endings),
  }
}

describe('endings terminate routes', () => {
  it('stops a route at a marked ending that still has links leaving it', () => {
    const doc = docFrom({ A: ['B'], B: ['C'], C: [] }, { endings: ['B'] })
    expect(counts(doc).from('A')).toBe(1n)
    expect(stats(doc).endings.rows.map((r) => [r.title, r.routes])).toEqual([['B', 1n]])
  })

  it('reports what the ending orphaned rather than silently losing it', () => {
    const doc = docFrom({ A: ['B'], B: ['C'], C: [] }, { endings: ['B'] })
    expect(stats(doc).lint.strandedBehindEnding.map((e) => e.title)).toEqual(['C'])
    expect(stats(doc).lint.endingsWithLinks.map((e) => e.title)).toEqual(['B'])
  })

  it('counts exactly as before when nothing is marked', () => {
    const doc = docFrom({ A: ['B'], B: ['C'], C: [] })
    expect(counts(doc).from('A')).toBe(1n)
    expect(stats(doc).lint.strandedBehindEnding).toEqual([])
  })

  it('treats a marked start as the whole story', () => {
    const doc = docFrom(BINARY_2, { endings: ['Root'] })
    expect(stats(doc).totalRoutes).toBe(1n)
  })
})

describe('the endings table', () => {
  it('splits a binary tree evenly and needs no reconciling row', () => {
    const s = stats(docFrom(BINARY_2, { endings: ['L', 'R'] }))
    expect(s.totalRoutes).toBe(2n)
    expect(s.endings.rows.map((r) => [r.title, r.routes, r.percent])).toEqual([
      ['L', 1n, 50],
      ['R', 1n, 50],
    ])
    expect(s.endings.unmarkedRoutes).toBe(0n)
  })

  it('reconciles to 100% across the table and the unmarked row', () => {
    const s = stats(docFrom(BINARY_2, { endings: ['L'] }))
    expect(s.endings.rows.map((r) => r.percent)).toEqual([50])
    expect(s.endings.unmarkedRoutes).toBe(1n)
    expect(s.endings.unmarkedPercent).toBe(50)
    expect(s.lint.unmarkedDeadEnds.map((e) => e.title)).toEqual(['R'])
  })

  it('sums both arms of a diamond that rejoins', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      { endings: ['D'] },
    )
    expect(counts(doc).to('D')).toBe(2n)
    expect(stats(doc).endings.rows[0]!.percent).toBe(100)
  })

  it('keeps an unreachable ending in the table, at zero', () => {
    const doc = docFrom({ A: ['B'], B: [], Lost: [] }, { endings: ['B', 'Lost'] })
    expect(stats(doc).endings.rows.map((r) => [r.title, r.routes, r.percent])).toEqual([
      ['B', 1n, 100],
      ['Lost', 0n, 0],
    ])
  })

  it('orders by route count, then title, without leaning on sort stability', () => {
    const doc = docFrom(
      { A: ['B', 'C'], B: ['Z'], C: ['Z'], Y: [], Z: [] },
      { start: 'A', endings: ['Z', 'Y'] },
    )
    expect(stats(doc).endings.rows.map((r) => r.title)).toEqual(['Z', 'Y'])
  })
})

describe('countPathsToAll', () => {
  /** The property that lets the two coexist: one is the other's one-entry case. */
  function agrees(doc: StoryDoc) {
    const g = deriveGraph(doc)
    const { backEdges } = findBackEdges(g, doc.startNodeId)
    const endings = new Set(doc.nodes.filter((n) => n.isEnding).map((n) => n.id))
    const all = countPathsToAll(g, backEdges, doc.startNodeId, endings)
    // Phantoms included: `g.ids` is every node the graph knows, real or not.
    return g.ids.every(
      (id) => all.get(id) === countPathsTo(g, backEdges, id, doc.startNodeId, endings),
    )
  }

  it('agrees with countPathsTo on every passage', () => {
    expect(agrees(docFrom({ A: ['B', 'C'], B: ['D'], C: ['D'], D: [] }))).toBe(true)
    expect(agrees(docFrom({ A: ['B'], B: [], Orphan: [] }))).toBe(true)
    expect(agrees(docFrom({ Hub: ['Forest'], Forest: ['Cave'], Cave: ['Hub'] }))).toBe(true)
    expect(agrees(docFrom({ A: ['B', 'Ghost'], B: [] }))).toBe(true)
    expect(agrees(docFrom({ A: ['B'], B: ['C'], C: [] }, { endings: ['B'] }))).toBe(true)
  })

  it('answers for phantoms too, so the shares on a level still sum', () => {
    const doc = docFrom({ A: ['B', 'Ghost'], B: [] })
    const g = deriveGraph(doc)
    const { backEdges } = findBackEdges(g, doc.startNodeId)
    const all = countPathsToAll(g, backEdges, doc.startNodeId)
    const ghost = g.ids.find((id) => g.codeOf.get(id) === 'Ghost')!
    expect(all.get(ghost)).toBe(1n)
  })

  it('reports every passage as zero when the story has no start', () => {
    const doc = { ...docFrom({ A: ['B'], B: [] }), startNodeId: null }
    const g = deriveGraph(doc)
    const { backEdges } = findBackEdges(g, doc.startNodeId)
    const all = countPathsToAll(g, backEdges, doc.startNodeId)
    expect([...all.values()].every((v) => v === 0n)).toBe(true)
  })
})

describe('share', () => {
  it('rounds to a tenth rather than truncating', () => {
    expect(share(2n, 3n)).toBe(66.7)
    expect(share(1n, 3n)).toBe(33.3)
  })

  it('stays honest past what a double can hold', () => {
    const huge = 10n ** 40n
    expect(share(huge, huge * 4n)).toBe(25)
  })

  it('reports nothing rather than dividing by zero', () => {
    expect(share(0n, 0n)).toBe(0)
  })
})

describe('countPathsTo', () => {
  it('counts a passage nothing reaches as zero, not one', () => {
    const doc = docFrom({ A: ['B'], B: [], Orphan: [] })
    expect(counts(doc).to('Orphan')).toBe(0n)
  })

  it('terminates on a loop instead of recursing forever', () => {
    const doc = docFrom({ Hub: ['Forest'], Forest: ['Cave'], Cave: ['Hub'] })
    expect(counts(doc).to('Cave')).toBe(1n)
  })

  it('counts the start as one route', () => {
    const doc = docFrom(BINARY_2)
    expect(counts(doc).to('Root')).toBe(1n)
  })
})

describe('word count', () => {
  it('counts Harlowe link syntax as the tokens it looks like', () => {
    // Two tokens, not one and not zero: the panel says the count is raw source,
    // and this pins that promise so nobody "fixes" it into a half-parser.
    expect(wordCount('[[Go north|P7]]')).toBe(2)
    expect(wordCount('You wake.\n\n[[Go north|P7]]')).toBe(4)
  })

  it('is zero for an empty or whitespace body', () => {
    expect(wordCount('')).toBe(0)
    expect(wordCount('   \n  ')).toBe(0)
  })

  it('totals every body in the story', () => {
    const doc = docFrom({ A: [], B: [] })
    doc.nodes[0]!.body = 'one two three'
    doc.nodes[1]!.body = 'four five'
    expect(stats(doc).words.total).toBe(5)
    expect(stats(doc).words.meanPerPassage).toBe(3)
  })
})

describe('per-playthrough length', () => {
  /** Every route from the start, walked the slow and obvious way. */
  function enumerate(doc: StoryDoc): string[][] {
    const g = deriveGraph(doc)
    const { backEdges } = findBackEdges(g, doc.startNodeId)
    const endings = new Set(doc.nodes.filter((n) => n.isEnding).map((n) => n.id))
    const out: string[][] = []
    const walk = (id: string, acc: string[]) => {
      const path = [...acc, id]
      const kids = endings.has(id)
        ? []
        : (g.outAdj.get(id) ?? [])
            .filter((eid) => {
              const e = g.edgeById.get(eid)!
              return !e.selfLoop && !backEdges.has(eid)
            })
            .map((eid) => g.edgeById.get(eid)!.targetId)
      if (kids.length === 0) out.push(path)
      else for (const k of kids) walk(k, path)
    }
    walk(doc.startNodeId!, [])
    return out
  }

  it('matches a brute-force enumeration of every route', () => {
    const doc = docFrom({ A: ['B', 'C'], B: ['D'], C: ['D', 'E'], D: [], E: [] })
    // Prose is *prepended*, never assigned: the body is what defines the links,
    // so overwriting it would quietly delete the graph and leave every route
    // one passage long — the test would still pass and prove nothing.
    const lengths = [4, 7, 3, 11, 5]
    doc.nodes.forEach((n, i) => (n.body = `${Array(lengths[i]!).fill('w').join(' ')}\n${n.body}`))

    const routes = enumerate(doc)
    const wordsOf = new Map(doc.nodes.map((n) => [n.id, wordCount(n.body)]))
    const totals = routes.map((r) => r.reduce((sum, id) => sum + wordsOf.get(id)!, 0))
    const brute = Math.floor(totals.reduce((a, b) => a + b, 0) / totals.length)

    expect(routes.length).toBe(3)

    const s = stats(doc)
    expect(s.totalRoutes).toBe(BigInt(routes.length))
    expect(s.playthrough.meanWords).toBe(brute)
    expect(s.playthrough.shortestWords).toBe(Math.min(...totals))
    expect(s.playthrough.longestWords).toBe(Math.max(...totals))
  })

  it('ignores prose stranded past an ending', () => {
    const doc = docFrom({ A: ['B'], B: ['C'], C: [] }, { endings: ['B'] })
    doc.nodes.forEach((n) => (n.body = `one two three\n${n.body}`))
    const [a, b] = [wordCount(doc.nodes[0]!.body), wordCount(doc.nodes[1]!.body)]
    // C is past the ending, so its prose is in `words.total` but on no route.
    expect(stats(doc).playthrough.meanWords).toBe(a + b)
    expect(stats(doc).words.total).toBeGreaterThan(a + b)
  })
})

describe('lint', () => {
  it('names a broken link and how many point at it', () => {
    const doc = docFrom({ A: ['Ghost'], B: ['Ghost'] })
    const s = stats(doc)
    expect(s.lint.brokenLinks.map((e) => [e.code, e.detail])).toEqual([['Ghost', '2 links']])
  })

  it('names a passage with no route from the start', () => {
    const doc = docFrom({ A: ['B'], B: [], Island: [] })
    expect(stats(doc).lint.unreachable.map((e) => e.title)).toEqual(['Island'])
  })

  it('does not accuse a passage reachable only around a loop', () => {
    const doc = docFrom({ Hub: ['Forest'], Forest: ['Cave'], Cave: ['Hub'] })
    expect(stats(doc).lint.unreachable).toEqual([])
  })

  it('lists every dead end nobody marked', () => {
    const doc = docFrom(BINARY_2, { endings: ['L'] })
    expect(stats(doc).lint.unmarkedDeadEnds.map((e) => e.title)).toEqual(['R'])
  })

  // The lint asks whether the author wrote a link; the counters ask where a
  // route can go. A back edge is a link and not a route edge, so reading the
  // first question off the second accuses the commonest shape in the form.
  it('does not accuse a passage whose only link goes back to a hub', () => {
    const doc = docFrom({ Hub: ['Forest'], Forest: ['Cave'], Cave: ['Hub'] })
    expect(stats(doc).lint.unmarkedDeadEnds).toEqual([])
  })

  it('still names a passage that links nowhere at all', () => {
    const doc = docFrom({ Hub: ['Forest', 'Attic'], Forest: ['Cave'], Cave: ['Hub'], Attic: [] })
    expect(stats(doc).lint.unmarkedDeadEnds.map((e) => e.title)).toEqual(['Attic'])
  })
})

describe('completion and shape', () => {
  it('splits progress by passage and by prose', () => {
    const doc = docFrom({ A: ['B'], B: [] })
    doc.nodes[0]!.state = 'Done'
    doc.nodes[0]!.body = 'one two'
    doc.nodes[1]!.body = 'three four five six seven eight'
    const s = stats(doc)
    expect(s.completion.passagePercentDone).toBe(50)
    expect(s.completion.wordPercentDone).toBe(25)
  })

  it('counts choice points and route lengths in passages', () => {
    const s = stats(docFrom({ A: ['B', 'C'], B: ['D'], C: [], D: [] }))
    expect(s.shape.choicePoints).toBe(1)
    expect(s.shape.shortestRoutePassages).toBe(2)
    expect(s.shape.longestRoutePassages).toBe(3)
  })

  // "Links per passage" is read as how many links the author wrote, so it
  // counts every one of them: three passages round a loop are three links, not
  // the two the route model walks.
  it('counts a back edge as a link the author wrote', () => {
    const s = stats(docFrom({ Hub: ['Forest'], Forest: ['Cave'], Cave: ['Hub'] }))
    expect(s.shape.meanBranching).toBe(1)
  })

  it('counts a link to a code no passage has', () => {
    expect(stats(docFrom({ A: ['Ghost'] })).shape.meanBranching).toBe(1)
  })

  // Ticking a box must not restate how many links are written: marking an
  // ending changes which routes exist, not the prose.
  it('leaves the link counts alone when a passage is marked as an Ending', () => {
    const spec = { A: ['B', 'C'], B: ['D', 'E'], C: [], D: [], E: [] }
    const plain = stats(docFrom(spec)).shape
    const marked = stats(docFrom(spec, { endings: ['B'] })).shape
    expect(marked.meanBranching).toBe(plain.meanBranching)
    expect(marked.choicePoints).toBe(plain.choicePoints)
  })
})

describe('degenerate stories', () => {
  it('handles a story with no start passage', () => {
    const doc = docFrom({ A: [] })
    doc.startNodeId = null
    const s = stats(doc)
    expect(s.totalRoutes).toBe(0n)
    expect(s.endings.rows).toEqual([])
    expect(s.playthrough.meanWords).toBe(0)
  })

  it('handles a single passage', () => {
    const s = stats(docFrom({ Only: [] }, { endings: ['Only'] }))
    expect(s.totalRoutes).toBe(1n)
    expect(s.endings.rows[0]!.percent).toBe(100)
    expect(s.endings.unmarkedRoutes).toBe(0n)
  })
})
