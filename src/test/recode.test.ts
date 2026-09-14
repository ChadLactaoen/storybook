import { describe, expect, it } from 'vitest'
import { recodeAll } from '../lib/doc/mutations'
import { deriveGraph } from '../lib/graph/derive'
import { layoutStory } from '../lib/graph/layout'
import { planRecode } from '../lib/graph/recode'
import type { RecodeOptions } from '../lib/graph/recode'
import { compareStr, emptyDoc } from '../types/story'
import type { StoryDoc } from '../types/story'
import { docFrom, shuffled } from './helpers'

const DIAMOND = { Start: ['Left', 'Right'], Left: ['End'], Right: ['End'], End: [] }

const LEVEL_NODE: RecodeOptions = { mode: 'levelNode', prefix: '', separator: 'N' }
const NODE: RecodeOptions = { mode: 'node', prefix: 'P', separator: '' }

/** The plan as `{ title: newCode }`, which is how these assertions read best. */
function codes(doc: StoryDoc, opts: RecodeOptions): Record<string, string> {
  const plan = planRecode(layoutStory(doc), opts)
  const out: Record<string, string> = {}
  for (const entry of plan.entries) out[entry.title] = entry.to
  return out
}

describe('level-and-node numbering', () => {
  it('numbers by level, then left to right within it', () => {
    const doc = docFrom(DIAMOND)
    const res = layoutStory(doc)
    const plan = planRecode(res, LEVEL_NODE)

    // Which of Left and Right is `2N1` is the layout's call, not the test's —
    // assert only that the two agree.
    const byId = new Map(res.nodes.map((n) => [n.id, n]))
    const level2 = plan.entries.filter((e) => e.level === 2).sort((a, b) => compareStr(a.to, b.to))
    expect(level2.map((e) => e.to)).toEqual(['2N01', '2N02'])
    expect(byId.get(level2[0]!.id)!.x).toBeLessThan(byId.get(level2[1]!.id)!.x)

    expect(codes(doc, LEVEL_NODE).Start).toBe('1N01')
    expect(codes(doc, LEVEL_NODE).End).toBe('3N01')
  })

  it('honours a custom prefix and separator', () => {
    const doc = docFrom(DIAMOND)
    expect(codes(doc, { mode: 'levelNode', prefix: 'L', separator: 'P' }).End).toBe('L3P01')
    expect(codes(doc, { mode: 'levelNode', prefix: '', separator: '/' }).End).toBe('3/01')
  })

  it('keeps the fields apart even with no separator, because they are padded', () => {
    // Unpadded, level 1 index 11 and level 11 index 1 both read `111`. Fixed
    // widths make every code the same shape, so the two cannot collide.
    const spec: Record<string, string[]> = {}
    for (let i = 1; i <= 11; i++) spec[`C${i}`] = i < 11 ? [`C${i + 1}`] : []
    for (let i = 1; i <= 10; i++) spec[`R${i}`] = []

    const plan = planRecode(layoutStory(docFrom(spec)), {
      mode: 'levelNode',
      prefix: '',
      separator: '',
    })
    expect(plan.error).toBeNull()
    expect(new Set(plan.entries.map((e) => e.to)).size).toBe(plan.entries.length)
  })
})

describe('node numbering', () => {
  it('runs top to bottom, then left to right', () => {
    const doc = docFrom(DIAMOND)
    const plan = planRecode(layoutStory(doc), NODE)
    expect(plan.entries.map((e) => e.to)).toEqual(['P01', 'P02', 'P03', 'P04'])
    expect(plan.entries[0]!.title).toBe('Start')
    expect(plan.entries[3]!.title).toBe('End')
  })

  it('honours a custom prefix, including none at all', () => {
    const doc = docFrom(DIAMOND)
    expect(codes(doc, { mode: 'node', prefix: 'X', separator: '' }).End).toBe('X04')
    expect(codes(doc, { mode: 'node', prefix: '', separator: '' }).End).toBe('04')
  })
})

describe('what a plan reports', () => {
  it('counts only the codes that move', () => {
    // Coded as the scheme would code them, so the plan is the identity.
    const doc = docFrom(DIAMOND, {
      codes: { Start: 'P01', Left: 'P02', Right: 'P03', End: 'P04' },
    })
    const plan = planRecode(layoutStory(doc), NODE)
    expect(plan.entries).toHaveLength(4)
    expect(plan.changed).toBe(0)

    // And the default `P1`..`P4` all move, because the width floor is two.
    expect(planRecode(layoutStory(docFrom(DIAMOND)), NODE).changed).toBe(4)
  })

  it('leaves phantoms out, and lets them consume no index', () => {
    // `Ghost` draws as a card on level 2 beside `Real`, but is not a passage.
    const doc = docFrom({ Start: ['Ghost', 'Real'], Real: [] })
    const plan = planRecode(layoutStory(doc), LEVEL_NODE)
    expect(plan.entries.map((e) => e.title)).toEqual(['Start', 'Real'])
    expect(plan.entries[1]!.to).toBe('2N01')
  })

  it('names a dangling target a new code would capture', () => {
    const doc = docFrom({ Start: ['Real', '2N01'], Real: [] })
    expect(planRecode(layoutStory(doc), LEVEL_NODE).captures).toEqual(['2N01'])
    // A scheme that mints nothing the phantom is called captures nothing.
    expect(planRecode(layoutStory(doc), NODE).captures).toEqual([])
  })

  it('refuses link syntax in the prefix or the separator', () => {
    const res = layoutStory(docFrom(DIAMOND))
    expect(planRecode(res, { mode: 'node', prefix: 'A|', separator: '' }).error).toContain('|')
    expect(planRecode(res, { mode: 'levelNode', prefix: '', separator: '->' }).error).toContain(
      '->',
    )
  })

  it('has nothing to say about an empty story', () => {
    const plan = planRecode(layoutStory(emptyDoc('Empty')), LEVEL_NODE)
    expect(plan.entries).toEqual([])
    expect(plan.error).toBeNull()
  })

  it('ignores the order nodes happen to sit in the array', () => {
    // Layout is shuffle-invariant, and so is anything read off it.
    const doc = docFrom(DIAMOND)
    const a = planRecode(layoutStory(doc), LEVEL_NODE)
    const b = planRecode(layoutStory({ ...doc, nodes: shuffled(doc.nodes) }), LEVEL_NODE)
    expect(b.entries).toEqual(a.entries)
  })
})

describe('padding, and the fixed point it buys', () => {
  /** One pass, as the store does it. */
  function applyOnce(doc: StoryDoc, opts: RecodeOptions): StoryDoc {
    return recodeAll(doc, planRecode(layoutStory(doc), opts).mapping).doc
  }

  /** `n` passages with no links at all, so each is its own component. */
  function loose(n: number): StoryDoc {
    const spec: Record<string, string[]> = {}
    for (let i = 1; i <= n; i++) spec[`T${i}`] = []
    return docFrom(spec)
  }

  it('pads to a floor, so growing past ten does not rewrite every code', () => {
    // Width is taken from the story's size, but never drops below two: nine
    // passages and ten passages are both two digits, so the tenth arriving
    // leaves the nine already written alone.
    expect(Object.values(codes(loose(9), NODE)).sort()).toEqual(
      ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09'],
    )
    const ten = Object.values(codes(loose(10), NODE))
    expect(ten).toContain('P01')
    expect(ten).toContain('P10')

    // A hundred is the next cliff, and no fixed width can remove it.
    const hundred = Object.values(codes(loose(100), NODE))
    expect(hundred).toContain('P001')
    expect(hundred).toContain('P100')
  })

  it('pads the level and the index to their own widths', () => {
    // Eleven passages on one level, and a chain eleven levels deep.
    const spec: Record<string, string[]> = {}
    for (let i = 1; i <= 11; i++) spec[`C${i}`] = i < 11 ? [`C${i + 1}`] : []
    for (let i = 1; i <= 10; i++) spec[`R${i}`] = []
    const out = codes(docFrom(spec), LEVEL_NODE)
    expect(out.C1).toBe('01N01')
    expect(out.C11).toBe('11N01')
  })

  it('settles in one pass, however many components the story is in', () => {
    // The case unpadded numbering cannot reach: past nine components, layout
    // packs them in codepoint order, so `P10` before `P2` chases the numbering
    // around a cycle that has no fixed point.
    for (const n of [3, 9, 10, 11, 12, 25]) {
      for (const opts of [NODE, LEVEL_NODE]) {
        const once = applyOnce(loose(n), opts)
        expect(planRecode(layoutStory(once), opts).changed).toBe(0)
        // And applying again is a no-op, not merely an equal-looking document.
        expect(applyOnce(once, opts)).toBe(once)
      }
    }
  })

  it('settles for a branching story too', () => {
    const doc = docFrom({
      Root: ['A', 'B'],
      A: ['C', 'D', 'E'],
      B: ['F'],
      C: [], D: [], E: [], F: ['G'], G: [],
    })
    for (const opts of [NODE, LEVEL_NODE]) {
      const once = applyOnce(doc, opts)
      expect(planRecode(layoutStory(once), opts).changed).toBe(0)
    }
  })

  it('names an untitled passage by its code, so no preview row is blank', () => {
    const doc = docFrom({ One: [] })
    doc.nodes[0]!.title = ''
    expect(planRecode(layoutStory(doc), NODE).entries[0]!.title).toBe('P1')
  })
})

describe('shapes the numbering has to survive', () => {
  it('numbers a passage the author pushed down at the level it landed on', () => {
    // `levelOffset` is the one positional field in the document, and layout
    // folds it in as a lower bound — so the number has to come from the level
    // the card ended up on, not the one its links imply.
    const doc = docFrom({ Start: ['A', 'B'], A: [], B: [] }, { offsets: { A: 1 } })
    const out = codes(doc, LEVEL_NODE)
    expect(out.Start).toBe('1N01')
    expect(out.B).toBe('2N01')
    // A was nudged from level 2 down to level 3, and is numbered there.
    expect(out.A).toBe('3N01')
  })

  it('numbers a story with a loop in it', () => {
    // Back edges are normal in CYOA writing. They are excluded from layering,
    // so every passage still has exactly one level to be numbered at.
    const doc = docFrom({ Start: ['Middle'], Middle: ['End'], End: ['Start'] })
    const out = codes(doc, LEVEL_NODE)
    expect([out.Start, out.Middle, out.End]).toEqual(['1N01', '2N01', '3N01'])
    const once = recodeAll(doc, planRecode(layoutStory(doc), LEVEL_NODE).mapping).doc
    expect(deriveGraph(once).phantoms).toHaveLength(0)
    expect(planRecode(layoutStory(once), LEVEL_NODE).changed).toBe(0)
  })

  it('numbers a self-linking passage once, not twice', () => {
    const doc = docFrom({ Start: ['Start', 'End'], End: [] })
    const plan = planRecode(layoutStory(doc), NODE)
    expect(plan.entries).toHaveLength(2)
  })
})

describe('a document carrying a duplicate code', () => {
  it('moves the links the way deriveGraph already reads them', () => {
    // Links to `A3` resolve to whichever passage is first in canonical order.
    // The rewrite has to agree, or the codes get repaired and the story quietly
    // re-plumbed to the other passage.
    const doc = docFrom({ One: [], Two: [], Src: ['A3'] }, { codes: { One: 'A3', Two: 'A3' } })
    const before = deriveGraph(doc)
    const target = before.edges[0]!.targetId

    const ids = new Map(doc.nodes.map((n) => [n.title, n.id]))
    const { doc: next, error } = recodeAll(
      doc,
      new Map([[ids.get('One')!, 'N1'], [ids.get('Two')!, 'N2']]),
    )
    expect(error).toBeNull()
    expect(deriveGraph(next).edges[0]!.targetId).toBe(target)
    expect(deriveGraph(next).phantoms).toHaveLength(0)
  })
})
