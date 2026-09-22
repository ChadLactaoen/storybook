import { describe, expect, it } from 'vitest'
import { findBackEdges } from '../lib/graph/acyclic'
import { deriveGraph } from '../lib/graph/derive'
import { layoutStory } from '../lib/graph/layout'
import { countPaths } from '../lib/graph/paths'
import { orphanIds, reachableFrom, strandedBy } from '../lib/graph/reachability'
import { COMPACT_CONFIG, DEFAULT_CONFIG, NODE_GAP } from '../lib/graph/constants'
import { deleteNodes } from '../lib/doc/mutations'
import { docFrom, minCardGap, shuffled } from './helpers'
import { bigStory } from './fixtures/big-story'

/** Deeper and wider trees, to prove the packing claim is not depth-specific. */
const BINARY_4 = {
  Root: ['L', 'R'],
  L: ['LL', 'LR'],
  R: ['RL', 'RR'],
  LL: ['LLa', 'LLb'],
  LR: ['LRa'],
  RL: ['RLa'],
  RR: ['RRa', 'RRb'],
  LLa: [], LLb: [], LRa: [], RLa: [], RRa: [], RRb: [],
}

const WIDE_TREE = {
  Start: ['A', 'B', 'C', 'D', 'E'],
  A: ['A1', 'A2'], B: ['B1'], C: ['C1', 'C2', 'C3'], D: [], E: ['E1'],
  A1: [], A2: [], B1: [], C1: [], C2: [], C3: [], E1: [],
}

/** Branch, merge and skip: the shape the packing setting is about. */
const MERGING = {
  Start: ['A', 'B', 'C', 'D'],
  A: ['A1', 'A2'], B: ['B1', 'B2'], C: ['C1', 'C2', 'Merge'], D: ['D1', 'D2'],
  A1: ['A1a'], A2: ['A2a'], B1: ['B1a', 'Merge'], B2: ['B2a'],
  C1: ['C1a'], C2: ['C2a'], D1: ['D1a'], D2: ['D2a'],
  A1a: ['Merge'], A2a: ['End1'], B1a: [], B2a: ['End2'],
  C1a: ['End3'], C2a: [], D1a: ['End4'], D2a: [],
  Merge: [], End1: [], End2: [], End3: [], End4: [],
}

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

  it('carries a passage a sibling link pushed down a level over its own children', () => {
    // Linking two passages that sit on the same level pushes the destination
    // down one, so it acquires a second parent while the first one's edge grows
    // a dummy chain. The forest can hang it off only one of the two, `ordering`
    // puts it somewhere else in the layer, and `enforceOrder` slides it to
    // reconcile them. Sliding the node on its own left everything below it
    // behind: the branch's two endings stayed under an unrelated subtree, a
    // third of the drawing away from the passage they belong to.
    //
    // Only the pushed-down branch is asserted here, and deliberately so. What
    // this one pins is that a slid node keeps its own children; that its
    // *ancestors* follow it is `recentre`'s job, and the test below is the one
    // that holds it.
    const branches = ['A', 'B', 'C', 'D', 'E', 'F']
    const fan = (link: Record<string, string[]>) => {
      // Copied, not aliased: `fan` is called once per direction and a future
      // case that appends a start-level link would corrupt the other run.
      const spec: Record<string, string[]> = { Start: [...branches] }
      for (const b of branches) {
        spec[b] = link[b] ?? [b + '1', b + '2']
        spec[b + '1'] = []
        spec[b + '2'] = []
      }
      return spec
    }

    // Both directions: the leftmost branch reaching the rightmost, and back.
    for (const [from, to] of [['A', 'F'], ['F', 'A']] as const) {
      const doc = docFrom(fan({ [from]: [from + '1', from + '2', to] }))
      const res = layoutStory(doc)
      const at = (title: string) => res.nodes.find((n) => n.title === title)!
      // `to` is the one the link pushed down out of its siblings' level.
      expect(at(to).level).toBe(3)
      expect(at(to).x).toBeCloseTo((at(to + '1').x + at(to + '2').x) / 2, 2)
      expect(minCardGap(res.nodes)).toBeGreaterThanOrEqual(NODE_GAP - 0.01)
      // `minCardGap` only sees real cards, and what this change moves is dummy
      // chains — so check the bend points too, or an edge could come to be
      // drawn straight across a card with every other assertion still green.
      for (const edge of res.edges) {
        for (const p of edge.points.slice(1, -1)) {
          for (const n of res.nodes) {
            if (Math.abs(p.y - n.y) > n.height / 2) continue
            expect(Math.abs(p.x - n.x)).toBeGreaterThan(n.width / 2)
          }
        }
      }
      // The slide reads `childrenOf`, which is built from layer order, so the
      // new path needs the same shuffle-invariance as the rest of layout.
      for (let i = 0; i < 4; i++) {
        expect(layoutStory({ ...doc, nodes: shuffled(doc.nodes, i + 5) }).stats.hash).toBe(
          res.stats.hash,
        )
      }
    }
  })

  it('re-centres every unrelated branch after a three-level merge slides one', () => {
    // A passage reached from three levels at once — N-1, N-2 and N-3 — which is
    // what an author gets from one ordinary link plus two skip links into the
    // same place. The two long edges mint dummy chains across every layer
    // between, `ordering` interleaves them with the real cards, and
    // `enforceOrder` slides whatever it must to put that order back.
    //
    // Each slide carries a subtree. Nothing used to carry the *parents*, so a
    // branch with no connection to the merge at all ended up sitting over one
    // of its children instead of between them: `B` 59 out and `D` 128 out, on a
    // story where neither links to `Merge`. Both directions showed on screen,
    // because the mirrored candidate slides the other way and the two are
    // averaged.
    const base = (): Record<string, string[]> => ({
      Start: ['A', 'B', 'C', 'D'],
      A: ['A1', 'A2'],
      B: ['B1', 'B2'],
      C: ['C1', 'C2'],
      D: ['D1', 'D2'],
      A1: ['A1a'],
      A2: ['A2a'],
      // Level N-2: one dummy on the way down.
      B1: ['B1a', 'Merge'],
      B2: ['B2a'],
      C1: ['C1a'],
      C2: ['C2a'],
      D1: ['D1a'],
      D2: ['D2a'],
      // Level N-1: no dummy at all.
      A1a: ['Merge'],
      A2a: ['End1'],
      B1a: [],
      B2a: ['End2'],
      C1a: ['End3'],
      C2a: [],
      D1a: ['End4'],
      D2a: [],
      Merge: [],
      End1: [],
      End2: [],
      End3: [],
      End4: [],
    })
    // Level N-3: two dummies, crossing both layers between.
    const three = () => ({ ...base(), C: ['C1', 'C2', 'Merge'] })

    const cases: [string, Record<string, string[]>, Record<string, number>][] = [
      // A control, and it earns its place by being the same story one link
      // short: it slides nothing, `place` writes nothing, and it is
      // byte-identical with `recentre` removed. Only the two below fail before
      // the fix.
      ['two parents', base(), {}],
      ['three parents', three(), {}],
      // Nudging any passage in the story down re-layers the chains under it.
      // It is `D1` rather than `Merge` because nudging the merge itself happens
      // to straighten this particular story out, leaving nothing conflicted to
      // measure — the trap `workflow.test.ts`'s complete binary tree fell into,
      // and that `perf.test.ts` was reshaped to avoid.
      ['three parents, nudged', three(), { D1: 1 }],
    ]

    for (const [name, spec, offsets] of cases) {
      const doc = docFrom(spec, { offsets })
      const res = layoutStory(doc)
      const at = (title: string) => res.nodes.find((n) => n.title === title)!
      expect(at('Merge').level, name).toBeGreaterThanOrEqual(5)

      for (const [parent, kids] of Object.entries(spec)) {
        if (kids.length === 0) continue
        // A passage linking straight into the merge is the one case the forest
        // cannot honour — it hangs off a single parent, and the others keep
        // whatever the slide left them. That is "exact for trees, best effort
        // elsewhere", and claiming it here would make this test a lie.
        if (kids.includes('Merge')) continue
        const xs = kids.map((k) => at(k).x)
        expect(at(parent).x, `${name}: ${parent}`).toBeCloseTo(
          (Math.min(...xs) + Math.max(...xs)) / 2,
          2,
        )
      }

      // Centring must not be bought with an overlap, or with an edge drawn
      // across a card — `minCardGap` sees only real cards, and what moves here
      // is largely dummies.
      expect(minCardGap(res.nodes), name).toBeGreaterThanOrEqual(NODE_GAP - 0.01)
      for (const edge of res.edges) {
        for (const p of edge.points.slice(1, -1)) {
          for (const n of res.nodes) {
            if (Math.abs(p.y - n.y) > n.height / 2) continue
            expect(Math.abs(p.x - n.x), name).toBeGreaterThan(n.width / 2)
          }
        }
      }

      // `recentre` reads `childrenOf` and walks layers in order, so it needs
      // the same shuffle-invariance as everything else in the pipeline.
      for (let i = 0; i < 4; i++) {
        expect(layoutStory({ ...doc, nodes: shuffled(doc.nodes, i + 9) }).stats.hash, name).toBe(
          res.stats.hash,
        )
      }
    }

    // The two three-parent cases have to actually reach the code they are
    // about. Crossings are not the test of that — `tidy.ts` records a
    // zero-crossing story that still slides — but they are what makes *this*
    // fixture conflicted, so losing them means it has been reshaped into
    // something else.
    expect(layoutStory(docFrom(three())).stats.crossings).toBeGreaterThan(0)
    expect(layoutStory(docFrom(three(), { offsets: { D1: 1 } })).stats.crossings).toBeGreaterThan(0)
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

  it('holds the geometry invariants on a story-shaped story', () => {
    // Everything else in this block is seven passages wide, and the invariants
    // they assert are the ones that can never legitimately break: cards do not
    // overlap, and a wire is never drawn across a card. Those held on every
    // small fixture while a change to `tidy.ts` redrew a quarter of real
    // stories. This is not a regression test for that change — it passes
    // against the code before it too — it is the floor underneath the next one,
    // on the only fixture in the repo shaped like a draft someone is actually
    // writing, at the size where ordering sweeps, dummy chains, re-merges and
    // back edges all run.
    //
    // Deliberately not a recorded hash. This drawing is *allowed* to change —
    // it improves whenever layout does — so a golden number here would flag an
    // improvement and a regression identically and be updated without being
    // read. `compat.test.ts` pins a hash because its fixture guards the
    // opposite claim, that nothing moved at all.
    const doc = bigStory()
    const res = layoutStory(doc)
    expect(res.stats.crossings).toBeGreaterThan(0)
    expect(res.stats.dummies).toBeGreaterThan(0)

    // `NODE_GAP` is the floor only for two cards that are actually adjacent in
    // their layer. `sep` charges `edgeGap` rather than `nodeGap` beside a
    // dummy, so a wire threading between two cards buys them
    // `2 * edgeGap` of clearance instead — narrower than a card gap, which is
    // the intended trade and the reason a long edge can pass between two
    // passages at all. At this size that case is everywhere. The bound is
    // derived rather than observed — the fixture currently clears it by about
    // twelve units, and sat exactly on it before `recentre` — so do not retune
    // it to whatever the drawing happens to measure today.
    const floor = Math.min(NODE_GAP, 2 * DEFAULT_CONFIG.edgeGap)
    expect(minCardGap(res.nodes)).toBeGreaterThanOrEqual(floor - 0.01)

    // Collected rather than asserted in the loop: this is ~200k pairs, and a
    // list names the offending edge instead of failing on an anonymous pair.
    const across: string[] = []
    for (const edge of res.edges) {
      for (const p of edge.points.slice(1, -1)) {
        for (const n of res.nodes) {
          if (Math.abs(p.y - n.y) > n.height / 2) continue
          if (Math.abs(p.x - n.x) > n.width / 2) continue
          across.push(`${edge.edgeId} crosses ${n.title}`)
        }
      }
    }
    expect(across).toEqual([])
  })

  it('draws a story with no merges identically whichever packing is chosen', () => {
    // The guarantee that makes this a safe setting to offer rather than a
    // gamble: `place` only ever moves a node already off its children's
    // midpoint, and in a tree none ever is. So the two strategies have nothing
    // to disagree about, and a story that never merges cannot be affected by
    // the choice at all. Asserted across depths because the shapes differ —
    // a two-deep fan packs nothing like a four-deep one.
    for (const spec of [BINARY_3, BINARY_4, WIDE_TREE]) {
      const doc = docFrom(spec)
      const balanced = layoutStory(doc, { packing: 'balanced' })
      const aligned = layoutStory(doc, { packing: 'aligned' })
      expect(aligned.stats.hash).toBe(balanced.stats.hash)
      expect(aligned.bounds.maxX - aligned.bounds.minX).toBeCloseTo(
        balanced.bounds.maxX - balanced.bounds.minX,
        6,
      )
    }
  })

  it('does draw a merging story differently, or the setting would be inert', () => {
    // The other half, and the reason the test above is not vacuous. Without
    // this a packing that had quietly stopped doing anything would pass every
    // assertion in the file.
    const doc = docFrom(MERGING)
    const balanced = layoutStory(doc, { packing: 'balanced' })
    const aligned = layoutStory(doc, { packing: 'aligned' })
    expect(aligned.stats.hash).not.toBe(balanced.stats.hash)
    // Aligned reaches slack by shoving, so it can only ever be as wide or wider.
    expect(aligned.bounds.maxX - aligned.bounds.minX).toBeGreaterThan(
      balanced.bounds.maxX - balanced.bounds.minX,
    )
  })

  it('draws compact narrower and shorter without crowding the cards', () => {
    const doc = docFrom(MERGING)
    const roomy = layoutStory(doc)
    const tight = layoutStory(doc, COMPACT_CONFIG)
    expect(tight.bounds.maxX - tight.bounds.minX).toBeLessThan(
      roomy.bounds.maxX - roomy.bounds.minX,
    )
    // Height follows width down, because `layerSpacing` is recomputed from the
    // new sibling spacing rather than kept. Drop that and a compact drawing
    // would be a narrow story stretched tall, and the fan would stop being
    // equilateral.
    expect(tight.bounds.maxY - tight.bounds.minY).toBeLessThan(
      roomy.bounds.maxY - roomy.bounds.minY,
    )
    // Separation is still honoured, at the floor the narrower cards imply —
    // `sep` charges `edgeGap` beside a dummy, so that is the real bound.
    // Read off the config being measured, not the default one. Compact scales
    // `edgeGap` too, and a floor borrowed from the defaults would have hidden
    // exactly the case that matters: a wire threading between two cards costs
    // `2 * edgeGap`, so it only stays free while that is under `nodeGap`.
    expect(2 * COMPACT_CONFIG.edgeGap!).toBeLessThanOrEqual(COMPACT_CONFIG.nodeGap!)
    const floor = Math.min(COMPACT_CONFIG.nodeGap!, 2 * COMPACT_CONFIG.edgeGap!)
    expect(minCardGap(tight.nodes)).toBeGreaterThanOrEqual(floor - 0.01)
    for (const n of tight.nodes) expect(n.width).toBe(COMPACT_CONFIG.nodeWidth)
  })

  it('stays deterministic under every combination, not just the default', () => {
    // Every other determinism test in this file exercises the defaults only, so
    // a strategy that leaned on node order would go unnoticed in three of the
    // four settings a reader can actually pick.
    const doc = docFrom(MERGING)
    for (const packing of ['balanced', 'aligned'] as const) {
      for (const spacing of [{}, COMPACT_CONFIG]) {
        const cfg = { ...spacing, packing }
        const first = layoutStory(doc, cfg)
        for (let i = 0; i < 4; i++) {
          expect(
            layoutStory({ ...doc, nodes: shuffled(doc.nodes, i + 21) }, cfg).stats.hash,
            `${packing} ${spacing === COMPACT_CONFIG ? 'compact' : 'roomy'}`,
          ).toBe(first.stats.hash)
        }
      }
    }
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
    expect(phantom.code).toBe('Missing')
    // The link was written `[[Go to Missing|Missing]]`, so its display text is
    // what the card offers as a name.
    expect(phantom.title).toBe('Go to Missing')
    expect(phantom.level).toBe(2)
    expect(res.edges.find((e) => e.targetId === phantom.id)!.kind).toBe('dangling')
  })
})

describe('fields outside the layout inputs', () => {
  it('lays out identically whatever the titles are', () => {
    const plain = docFrom(BINARY_3)
    const retitled = {
      ...plain,
      nodes: plain.nodes.map((n) => ({ ...n, title: `renamed ${n.id}` })),
    }
    // Titles are authoring metadata: they must not reach the geometry, or every
    // rename would reflow the board. Codes are the opposite — they are identity,
    // and `lays out identically whatever the codes are` would be a lie now.
    const geometry = (d: typeof plain) =>
      layoutStory(d).nodes.map(({ title, ...rest }) => rest)
    expect(geometry(retitled)).toEqual(geometry(plain))
  })

  it('lays out identically whatever the notes are', () => {
    const plain = docFrom(BINARY_3)
    const noted = {
      ...plain,
      nodes: plain.nodes.map((n, i) => ({ ...n, note: String.fromCharCode(65 + i) })),
    }
    // A note is authoring metadata: it moves nothing. This is the guard on
    // that — put it in `layoutKey` and every keystroke in the field would
    // re-derive the graph, re-parsing every body in the story.
    expect(layoutStory(noted).nodes).toEqual(layoutStory(plain).nodes)
    expect(layoutStory(noted).stats.hash).toBe(layoutStory(plain).stats.hash)
  })

  it('lays out identically whatever the slugs are', () => {
    const plain = docFrom(BINARY_3)
    const slugged = {
      ...plain,
      nodes: plain.nodes.map((n, i) => ({ ...n, slug: String.fromCharCode(65 + i) })),
    }
    // The running slug is derived from the graph, never an input to it. This is
    // the guard against "fixing" a stale running-slug memo by adding `slug` to
    // `layoutKey`: that would work, and it would re-run Sugiyama on every
    // keystroke in a ten-character field. The memo takes its own key instead.
    expect(layoutStory(slugged).nodes).toEqual(layoutStory(plain).nodes)
    expect(layoutStory(slugged).stats.hash).toBe(layoutStory(plain).stats.hash)
  })

  it('lays out identically whatever is marked as an ending', () => {
    const plain = docFrom(BINARY_3)
    const marked = docFrom(BINARY_3, { endings: ['LL', 'RR', 'Root'] })
    // An ending is a claim about the story, not about the drawing. It changes
    // what `countPaths` reports and nothing else; the guard matters because the
    // flag is deliberately absent from `layoutKey`, so if it ever did move a
    // card the canvas would not redraw and the two would silently disagree.
    expect(layoutStory(marked).nodes).toEqual(layoutStory(plain).nodes)
    expect(layoutStory(marked).stats.hash).toBe(layoutStory(plain).stats.hash)
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
