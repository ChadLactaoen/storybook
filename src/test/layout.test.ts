import { describe, expect, it } from 'vitest'
import { findBackEdges } from '../lib/graph/acyclic'
import { deriveGraph } from '../lib/graph/derive'
import { layoutStory } from '../lib/graph/layout'
import { countPaths } from '../lib/graph/paths'
import { orphanIds, reachableFrom, strandedBy } from '../lib/graph/reachability'
import { NODE_GAP } from '../lib/graph/constants'
import { deleteNodes } from '../lib/doc/mutations'
import { docFrom, minCardGap, shuffled } from './helpers'

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
    expect(minCardGap(res.nodes)).toBeGreaterThanOrEqual(NODE_GAP - 0.01)
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

  it('centres every parent between its outermost children', () => {
    // Branches of unequal depth: the old packing left Start 64 units off, because
    // relaxation could only use slack that compact packing happened to leave.
    const spec: Record<string, string[]> = {
      Start: ['Market', 'Docks', 'Temple', 'Gate'],
      Market: ['Haggle', 'Steal'],
      Docks: [],
      Temple: ['Pray'],
      Pray: ['Vision', 'Silence'],
      Gate: [],
      Haggle: [],
      Steal: [],
      Vision: [],
      Silence: [],
    }
    const res = layoutStory(docFrom(spec))
    const xOf = (title: string) => res.nodes.find((n) => n.title === title)!.x
    for (const [parent, kids] of Object.entries(spec)) {
      if (kids.length === 0) continue
      const xs = kids.map(xOf)
      expect(xOf(parent)).toBeCloseTo((Math.min(...xs) + Math.max(...xs)) / 2, 2)
    }
  })

  it('centres a parent whose children sit beside a long edge', () => {
    // Skip-level edges drop dummy nodes into the layers below. Those used to be
    // placed first and freeze, walling in any card beside them.
    const spec: Record<string, string[]> = {
      Start: ['Wear', 'Drink', 'Camp'],
      Wear: ['WearIt', 'DontWearIt'],
      Drink: ['Coffee', 'Tea'],
      WearIt: ['Camp'],
      DontWearIt: [],
      Coffee: [],
      Tea: [],
      Camp: [],
    }
    const res = layoutStory(docFrom(spec))
    const at = (title: string) => res.nodes.find((n) => n.title === title)!
    expect(res.stats.dummies).toBeGreaterThan(0)
    expect(Math.abs(at('Wear').x - at('WearIt').x)).toBeCloseTo(
      Math.abs(at('Wear').x - at('DontWearIt').x),
      2,
    )
    expect(Math.abs(at('Drink').x - at('Coffee').x)).toBeCloseTo(
      Math.abs(at('Drink').x - at('Tea').x),
      2,
    )
  })

  it('puts the merge point of a diamond between its two parents', () => {
    // Both choices lead to the same passage — the commonest non-tree shape a
    // story produces. The merge can only hang off one parent in the layout
    // forest, so it is the mirrored second pass that pulls it back to the middle.
    const res = layoutStory(docFrom({ A: ['B', 'C'], B: ['D'], C: ['D'], D: [] }))
    const at = (title: string) => res.nodes.find((n) => n.title === title)!.x
    expect(at('D')).toBeCloseTo((at('B') + at('C')) / 2, 2)
    expect(at('A')).toBeCloseTo((at('B') + at('C')) / 2, 2)
  })

  it('puts a three-child parent on the middle child rather than on the mean', () => {
    const res = layoutStory(docFrom({ P: ['A', 'B', 'C'], A: [], B: [], C: [] }))
    const at = (title: string) => res.nodes.find((n) => n.title === title)!.x
    expect(at('P')).toBeCloseTo(at('B'), 2)
    expect(at('P')).toBeCloseTo((at('A') + at('C')) / 2, 2)
  })

  it('centres parents when a passage has been nudged down a level', () => {
    // `levelOffset` is the one positional field in the document, and it can make
    // a passage with no parents start below the top layer. Such a root is packed
    // beside whole subtrees rather than inside one, which the mirrored pass has
    // to agree about — otherwise the two candidates put it on opposite sides and
    // averaging lands everything between two contradictory arrangements.
    const res = layoutStory(
      docFrom(
        { Start: ['Mid', 'Other'], Mid: ['End'], Other: [], End: [], Side: ['End'] },
        { offsets: { Side: 1 } },
      ),
    )
    const at = (title: string) => res.nodes.find((n) => n.title === title)!.x
    expect(at('Start')).toBeCloseTo((at('Mid') + at('Other')) / 2, 2)
    expect(minCardGap(res.nodes)).toBeGreaterThanOrEqual(NODE_GAP - 0.01)
  })

  it('keeps cards clear of one another on a wide uneven tree', () => {
    const res = layoutStory(
      docFrom({
        Start: ['One', 'Two', 'Three'],
        One: ['OneA', 'OneB'],
        Two: ['TwoA'],
        Three: ['ThreeA', 'ThreeB', 'ThreeC'],
        OneA: ['Deep'],
        OneB: [], TwoA: [], ThreeA: [], ThreeB: [], ThreeC: [], Deep: [],
      }),
    )
    expect(minCardGap(res.nodes)).toBeGreaterThanOrEqual(NODE_GAP - 0.01)
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

describe('reachability', () => {
  const titles = (doc: ReturnType<typeof docFrom>, ids: Set<string>) =>
    doc.nodes.filter((n) => ids.has(n.id)).map((n) => n.title)

  it('walks a cycle without looping forever', () => {
    // Back edges are normal in CYOA writing, so the walk has to tolerate them.
    const doc = docFrom({ A: ['B'], B: ['C'], C: ['A'] })
    const reached = reachableFrom(deriveGraph(doc), doc.startNodeId!)
    expect(titles(doc, reached).sort()).toEqual(['A', 'B', 'C'])
  })

  it('does not count a phantom as an orphan', () => {
    const doc = docFrom({ A: ['Ghost'] })
    expect(orphanIds(deriveGraph(doc), doc.startNodeId)).toEqual(new Set())
  })

  it('has no orphans when the story has no start', () => {
    const doc = docFrom({ A: [], B: [] })
    expect(orphanIds(deriveGraph(doc), null)).toEqual(new Set())
  })

  it('names the tail a deleted middle passage would strand', () => {
    const doc = docFrom({ A: ['B'], B: ['C'], C: [] })
    const after = deleteNodes(doc, [doc.nodes[1]!.id])
    expect(strandedBy(doc, after).map((n) => n.title)).toEqual(['C'])
  })

  it('ignores a passage that was already unreachable', () => {
    // Blocking on a pre-existing orphan would make a broken story uneditable.
    const doc = docFrom({ A: ['B'], B: [], C: [] })
    const after = deleteNodes(doc, [doc.nodes[1]!.id])
    expect(strandedBy(doc, after)).toEqual([])
  })

  it('strands nothing when the whole subtree goes together', () => {
    const doc = docFrom({ A: ['B'], B: ['C', 'D'], C: [], D: [] })
    const ids = doc.nodes.filter((n) => n.title !== 'A').map((n) => n.id)
    expect(strandedBy(doc, deleteNodes(doc, ids))).toEqual([])
  })
})
