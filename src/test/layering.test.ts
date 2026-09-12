import { describe, expect, it } from 'vitest'
import { findBackEdges } from '../lib/graph/acyclic'
import { deriveGraph } from '../lib/graph/derive'
import { assignLevels } from '../lib/graph/layering'
import type { StoryDoc } from '../types/story'
import { docFrom, levelsByTitle } from './helpers'

function levels(doc: StoryDoc) {
  const g = deriveGraph(doc)
  const { backEdges } = findBackEdges(g, doc.startNodeId)
  const offsets = new Map(doc.nodes.map((n) => [n.id, n.levelOffset]))
  const res = assignLevels(g, backEdges, (id) => offsets.get(id) ?? 0)
  return { g, res, byTitle: levelsByTitle(doc, res.level) }
}

describe('longest-path layering', () => {
  it('places two children of a root on the same level', () => {
    const { byTitle } = levels(docFrom({ One: ['Two', 'Three'], Two: [], Three: [] }))
    expect(byTitle).toEqual({ One: 1, Two: 2, Three: 2 })
  })

  it('re-levels descendants when a node is inserted mid-story', () => {
    // The spec's worked example: 1 -> 4 -> 2 and 1 -> 3.
    const { byTitle } = levels(
      docFrom({ One: ['Four', 'Three'], Four: ['Two'], Two: [], Three: [] }),
    )
    expect(byTitle).toEqual({ One: 1, Four: 2, Three: 2, Two: 3 })
  })

  it('survives a redundant shortcut edge, where BFS would not', () => {
    // Adding 1 -> 2 alongside 1 -> 4 -> 2 must not pull Two up to level 2,
    // which would make Four -> Two an illegal intra-level edge.
    const { byTitle } = levels(
      docFrom({ One: ['Four', 'Three', 'Two'], Four: ['Two'], Two: [], Three: [] }),
    )
    expect(byTitle).toEqual({ One: 1, Four: 2, Three: 2, Two: 3 })
  })

  it('never lets an edge run backwards or within a level', () => {
    const doc = docFrom({
      One: ['Four', 'Three', 'Two'],
      Four: ['Two', 'Five'],
      Three: ['Five'],
      Two: ['Five'],
      Five: [],
    })
    const { g, res } = levels(doc)
    for (const e of g.edges) {
      if (e.selfLoop) continue
      expect(res.level.get(e.targetId)!).toBeGreaterThan(res.level.get(e.sourceId)!)
    }
  })
})

describe('level offset', () => {
  it('pushes a node down one level and reports the structural floor', () => {
    const doc = docFrom(
      { One: ['Four', 'Three'], Four: ['Two'], Two: [], Three: [] },
      { offsets: { Three: 1 } },
    )
    const { byTitle, res } = levels(doc)
    // Three joins Two on level 3; Four is left alone on level 2.
    expect(byTitle).toEqual({ One: 1, Four: 2, Three: 3, Two: 3 })

    const three = doc.nodes.find((n) => n.title === 'Three')!
    expect(res.minLevel.get(three.id)).toBe(2)
  })

  it('propagates to descendants rather than creating an intra-level edge', () => {
    const doc = docFrom({ One: ['Two'], Two: ['Three'], Three: [] }, { offsets: { Two: 1 } })
    const { byTitle } = levels(doc)
    expect(byTitle).toEqual({ One: 1, Two: 3, Three: 4 })
  })

  it('clamps an out-of-range offset instead of drawing something invalid', () => {
    const doc = docFrom({ One: ['Two'], Two: [] }, { offsets: { Two: 7 } })
    const { byTitle } = levels(doc)
    expect(byTitle).toEqual({ One: 1, Two: 3 })
  })
})

describe('cycles', () => {
  it('keeps a hub loop drawable and marks exactly one edge as the back edge', () => {
    const doc = docFrom({ Hub: ['Forest'], Forest: ['Cave'], Cave: ['Hub'] })
    const g = deriveGraph(doc)
    const { backEdges, cycles } = findBackEdges(g, doc.startNodeId)
    expect(backEdges.size).toBe(1)
    expect(cycles.length).toBe(1)

    const offsets = new Map(doc.nodes.map((n) => [n.id, n.levelOffset]))
    const res = assignLevels(g, backEdges, (id) => offsets.get(id) ?? 0)
    expect(levelsByTitle(doc, res.level)).toEqual({ Hub: 1, Forest: 2, Cave: 3 })
  })

  it('ignores self-loops entirely', () => {
    const doc = docFrom({ One: ['One', 'Two'], Two: [] })
    const g = deriveGraph(doc)
    const { backEdges } = findBackEdges(g, doc.startNodeId)
    expect(backEdges.size).toBe(0)
    expect(g.edges.filter((e) => e.selfLoop)).toHaveLength(1)
  })
})

describe('dangling links', () => {
  it('resolves an unknown target to a phantom that still gets a level', () => {
    const doc = docFrom({ One: ['Ghost'] })
    const g = deriveGraph(doc)
    expect(g.phantoms.map((p) => p.code)).toEqual(['Ghost'])
    const { backEdges } = findBackEdges(g, doc.startNodeId)
    const res = assignLevels(g, backEdges, () => 0)
    expect(res.level.get(g.phantoms[0]!.id)).toBe(2)
  })
})
