import { describe, expect, it } from 'vitest'
import { findBackEdges } from '../lib/graph/acyclic'
import { deriveGraph } from '../lib/graph/derive'
import { layoutStory } from '../lib/graph/layout'
import { countPaths } from '../lib/graph/paths'
import { docFrom, shuffled } from './helpers'

const BINARY_3 = {
  Root: ['L', 'R'],
  L: ['LL', 'LR'],
  R: ['RL', 'RR'],
  LL: [],
  LR: [],
  RL: [],
  RR: [],
}

describe('determinism', () => {
  it('ignores the order nodes happen to sit in the array', () => {
    const doc = docFrom(BINARY_3)
    const a = layoutStory(doc)
    const b = layoutStory({ ...doc, nodes: shuffled(doc.nodes) })
    const c = layoutStory({ ...doc, nodes: shuffled(doc.nodes, 999) })
    expect(b.stats.hash).toBe(a.stats.hash)
    expect(c.stats.hash).toBe(a.stats.hash)
    expect(b.nodes).toEqual(a.nodes)
    expect(b.edges).toEqual(a.edges)
  })

  it('is stable across repeated runs of a messier graph', () => {
    const doc = docFrom({
      Start: ['Town', 'Woods', 'Shore'],
      Town: ['Inn', 'Market'],
      Woods: ['Cave', 'Market'],
      Shore: ['Cave'],
      Inn: ['Ending'],
      Market: ['Ending'],
      Cave: ['Ending', 'Start'],
      Ending: [],
    })
    const first = layoutStory(doc)
    for (let i = 0; i < 5; i++) {
      expect(layoutStory({ ...doc, nodes: shuffled(doc.nodes, i + 1) }).stats.hash).toBe(
        first.stats.hash,
      )
    }
  })
})

describe('geometry', () => {
  it('never overlaps two cards on the same level', () => {
    const res = layoutStory(docFrom(BINARY_3))
    const byLayer = new Map<number, typeof res.nodes>()
    for (const n of res.nodes) {
      const list = byLayer.get(n.layer) ?? []
      list.push(n)
      byLayer.set(n.layer, list)
    }
    for (const list of byLayer.values()) {
      const sorted = [...list].sort((a, b) => a.x - b.x)
      for (let i = 0; i + 1 < sorted.length; i++) {
        const gap = sorted[i + 1]!.x - sorted[i]!.x
        expect(gap).toBeGreaterThanOrEqual(sorted[i]!.width - 0.01)
      }
    }
  })

  it('puts every node on a level onto the same horizontal axis', () => {
    const res = layoutStory(docFrom(BINARY_3))
    const yByLevel = new Map<number, number>()
    for (const n of res.nodes) {
      const y = yByLevel.get(n.level)
      if (y === undefined) yByLevel.set(n.level, n.y)
      else expect(n.y).toBe(y)
    }
    expect(yByLevel.size).toBe(3)
  })

  it('centres a parent exactly between its two children', () => {
    const res = layoutStory(docFrom({ One: ['Two', 'Three'], Two: [], Three: [] }))
    const one = res.nodes.find((n) => n.title === 'One')!
    const two = res.nodes.find((n) => n.title === 'Two')!
    const three = res.nodes.find((n) => n.title === 'Three')!
    expect(one.x).toBeCloseTo((two.x + three.x) / 2, 6)
    expect(Math.abs(one.x - two.x)).toBeCloseTo(Math.abs(one.x - three.x), 6)
  })

  it('makes a minimum-spacing two-child fan equilateral', () => {
    const res = layoutStory(docFrom({ One: ['Two', 'Three'], Two: [], Three: [] }))
    const one = res.nodes.find((n) => n.title === 'One')!
    const two = res.nodes.find((n) => n.title === 'Two')!
    const three = res.nodes.find((n) => n.title === 'Three')!
    const siblingSpan = Math.abs(three.x - two.x)
    const edgeLen = Math.hypot(two.x - one.x, two.y - one.y)
    expect(edgeLen).toBeCloseTo(siblingSpan, 0)
  })

  it('gives a long edge a dummy per skipped level so it misses other cards', () => {
    // Start -> Ending skips level 2, where Middle sits.
    const res = layoutStory(
      docFrom({ Start: ['Middle', 'Ending'], Middle: ['Ending'], Ending: [] }),
    )
    expect(res.stats.dummies).toBe(1)
    const long = res.edges.find((e) => e.points.length === 3)
    expect(long).toBeDefined()
    const middle = res.nodes.find((n) => n.title === 'Middle')!
    const waypoint = long!.points[1]!
    expect(Math.abs(waypoint.x - middle.x)).toBeGreaterThan(middle.width / 2)
  })

  it('places disconnected fragments side by side rather than interleaved', () => {
    const res = layoutStory(docFrom({ A: ['B'], B: [], X: ['Y'], Y: [] }))
    const a = res.nodes.find((n) => n.title === 'A')!
    const b = res.nodes.find((n) => n.title === 'B')!
    const x = res.nodes.find((n) => n.title === 'X')!
    const y = res.nodes.find((n) => n.title === 'Y')!
    expect(a.x).toBeCloseTo(b.x, 6)
    expect(x.x).toBeCloseTo(y.x, 6)
    expect(Math.abs(a.x - x.x)).toBeGreaterThan(a.width)
  })
})

describe('path counting', () => {
  function paths(spec: Record<string, string[]>, from?: string) {
    const doc = docFrom(spec)
    const g = deriveGraph(doc)
    const { backEdges } = findBackEdges(g, doc.startNodeId)
    const title = from ?? Object.keys(spec)[0]!
    const id = doc.nodes.find((n) => n.title === title)!.id
    return countPaths(g, backEdges, id)
  }

  it('counts the leaves of a perfect binary tree', () => {
    expect(paths(BINARY_3)).toBe(4n)
  })

  it('counts a lone passage as one path', () => {
    expect(paths({ Only: [] })).toBe(1n)
  })

  it('counts both arms of a diamond that rejoins', () => {
    expect(paths({ A: ['B', 'C'], B: ['D'], C: ['D'], D: [] })).toBe(2n)
  })

  it('multiplies through a chain of choices', () => {
    expect(
      paths({ A: ['B', 'C'], B: ['D', 'E'], C: ['D', 'E'], D: ['F', 'G'], E: ['F', 'G'], F: [], G: [] }),
    ).toBe(8n)
  })

  it('counts from any node, not just the start', () => {
    expect(paths(BINARY_3, 'L')).toBe(2n)
  })

  it('terminates on a loop instead of recursing forever', () => {
    expect(paths({ Hub: ['Forest'], Forest: ['Cave'], Cave: ['Hub'] })).toBe(1n)
  })
})

describe('cycle and phantom edges', () => {
  it('marks the loop-closing edge as a back edge, arrowhead still at its target', () => {
    const doc = docFrom({ Hub: ['Forest'], Forest: ['Hub', 'Missing'] })
    const res = layoutStory(doc)

    const hub = res.nodes.find((n) => n.title === 'Hub')!
    const forest = res.nodes.find((n) => n.title === 'Forest')!

    const back = res.edges.find((e) => e.sourceId === forest.id && e.targetId === hub.id)!
    expect(back.kind).toBe('back')
    // Drawn from Forest up to Hub, so the arrow points where the author linked.
    expect(back.points[0]!.y).toBeGreaterThan(back.points[back.points.length - 1]!.y)

    const forward = res.edges.find((e) => e.sourceId === hub.id && e.targetId === forest.id)!
    expect(forward.kind).toBe('normal')
  })

  it('gives an unresolved link a phantom target on the next level', () => {
    const res = layoutStory(docFrom({ Hub: ['Missing'] }))
    const phantom = res.nodes.find((n) => n.isPhantom)!
    expect(phantom.title).toBe('Missing')
    expect(phantom.level).toBe(2)
    expect(res.edges.find((e) => e.targetId === phantom.id)!.kind).toBe('dangling')
  })
})

describe('fields outside the layout inputs', () => {
  it('lays out identically whatever the codes are', () => {
    const plain = docFrom(BINARY_3)
    const coded = docFrom(BINARY_3, {
      codes: Object.fromEntries(Object.keys(BINARY_3).map((t, i) => [t, `C${i}`])),
    })
    // Codes are authoring metadata: they must not reach the geometry, or every
    // code edit would reflow the board.
    expect(layoutStory(coded).nodes).toEqual(layoutStory(plain).nodes)
  })
})
