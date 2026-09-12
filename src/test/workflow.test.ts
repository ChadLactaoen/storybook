import { beforeEach, describe, expect, it } from 'vitest'
import { serializeDoc } from '../lib/doc/serialize'
import { layoutStory } from '../lib/graph/layout'
import * as store from '../stores/story'

/**
 * Walks the scenarios from the spec through the real store, exercising the same
 * code paths the UI calls.
 */

function idOf(title: string): string {
  const n = store.state.doc.nodes.find((x) => x.title === title)
  if (!n) throw new Error(`no passage titled ${title}`)
  return n.id
}

function levelOf(title: string): number {
  return store.layout.value.nodeById.get(idOf(title))!.level
}

function xOf(title: string): number {
  return store.layout.value.nodeById.get(idOf(title))!.x
}

function yOf(title: string): number {
  return store.layout.value.nodeById.get(idOf(title))!.y
}

beforeEach(() => {
  store.newStory('Spec Walkthrough')
  store.rename(idOf('Start'), 'One')
  store.editBody(idOf('One'), '')
})

describe('the spec walkthrough', () => {
  it('auto-creates linked passages and puts siblings on one axis', () => {
    store.editBody(idOf('One'), '[[Go|Two]]\n[[Stay|Three]]')

    expect(store.state.doc.nodes.map((n) => n.title).sort()).toEqual(['One', 'Three', 'Two'])
    expect(levelOf('One')).toBe(1)
    expect(levelOf('Two')).toBe(2)
    expect(levelOf('Three')).toBe(2)
    expect(yOf('Two')).toBe(yOf('Three'))
    // Equidistant from the parent, per the equilateral-fan rule.
    expect(Math.abs(xOf('One') - xOf('Two'))).toBeCloseTo(Math.abs(xOf('One') - xOf('Three')), 6)
  })

  it('re-levels a descendant when a passage is inserted above it', () => {
    store.editBody(idOf('One'), '[[Go|Two]]\n[[Stay|Three]]')
    // Rewire One -> Four -> Two, keeping One -> Three.
    store.editBody(idOf('One'), '[[Go|Four]]\n[[Stay|Three]]')
    store.editBody(idOf('Four'), '[[On|Two]]')

    expect(levelOf('Four')).toBe(2)
    expect(levelOf('Three')).toBe(2)
    expect(levelOf('Two')).toBe(3)
  })

  it('lets Three be nudged onto Two’s axis, leaving Four alone on its level', () => {
    store.editBody(idOf('One'), '[[Go|Four]]\n[[Stay|Three]]')
    store.editBody(idOf('Four'), '[[On|Two]]')

    store.changeLevelOffset(idOf('Three'), 1)

    expect(levelOf('Three')).toBe(3)
    expect(levelOf('Two')).toBe(3)
    expect(yOf('Three')).toBe(yOf('Two'))
    expect(levelOf('Four')).toBe(2)
    expect(yOf('Four')).not.toBe(yOf('Three'))
  })

  it('reports the floor that blocks moving a passage up a level', () => {
    store.editBody(idOf('One'), '[[Go|Four]]\n[[Stay|Three]]')
    store.editBody(idOf('Four'), '[[On|Two]]')
    store.select(idOf('Three'))

    // Three sits at its floor, pinned by One at level 1: there is no level to
    // move up to, and the UI can name the parent responsible.
    expect(store.selectedLayout.value!.minLevel).toBe(2)
    expect(store.blockingParent.value?.title).toBe('One')
  })

  it('counts unique paths for a perfect binary tree', () => {
    store.editBody(idOf('One'), '[[a|L]]\n[[b|R]]')
    store.editBody(idOf('L'), '[[a|LL]]\n[[b|LR]]')
    store.editBody(idOf('R'), '[[a|RL]]\n[[b|RR]]')

    expect(store.state.doc.nodes).toHaveLength(7)
    expect(store.pathsFrom(idOf('One'))).toBe(4n)
    expect(store.pathsFrom(idOf('L'))).toBe(2n)
  })

  it('renames through every parent and refuses a collision', () => {
    store.editBody(idOf('One'), '[[Go north|Cave]]')
    store.editBody(idOf('Cave'), '')
    store.addPassage()
    const otherId = store.state.selectedId!
    store.rename(otherId, 'Side Room')
    store.editBody(otherId, '[[Also here->Cave]]')

    expect(store.rename(idOf('Cave'), 'Grotto')).toBeNull()
    expect(store.state.doc.nodes.find((n) => n.title === 'One')!.body).toBe('[[Go north|Grotto]]')
    expect(store.state.doc.nodes.find((n) => n.title === 'Side Room')!.body).toBe(
      '[[Also here->Grotto]]',
    )
    // No phantom appeared, so every link still resolves.
    expect(store.layout.value.graph.phantoms).toHaveLength(0)

    const before = serializeDoc(store.state.doc)
    expect(store.rename(idOf('Grotto'), 'One')).toBe('A passage named "One" already exists.')
    expect(serializeDoc(store.state.doc)).toBe(before)
  })

  it('undoes a rename cascade in one step', () => {
    store.editBody(idOf('One'), '[[Go north|Cave]]')
    const before = serializeDoc(store.state.doc)
    store.rename(idOf('Cave'), 'Grotto')
    store.undo()
    expect(serializeDoc(store.state.doc)).toBe(before)
  })

  it('leaves prose alone on delete and surfaces a phantom instead', () => {
    store.editBody(idOf('One'), '[[Go north|Cave]]')
    store.removePassage(idOf('Cave'))

    expect(store.state.doc.nodes.map((n) => n.title)).toEqual(['One'])
    expect(store.state.doc.nodes[0]!.body).toBe('[[Go north|Cave]]')

    const phantom = store.layout.value.nodes.find((n) => n.isPhantom)
    expect(phantom?.title).toBe('Cave')
    expect(phantom?.level).toBe(2)

    // ...and the phantom can be turned back into a real passage.
    store.createFromPhantom('Cave')
    expect(store.layout.value.nodes.some((n) => n.isPhantom)).toBe(false)
  })

  it('keeps tags global, reusable and recolourable across passages', () => {
    store.editBody(idOf('One'), '[[Go|Two]]')
    store.tagAdd(idOf('One'), 'exposition')
    expect(store.tags.value).toContain('exposition')

    // The same tag is now offerable on another passage without retyping.
    store.tagAdd(idOf('Two'), 'exposition')
    store.tagRecolor('exposition', 'purple')

    expect(store.tagColors.value.get('exposition')).toBe('purple')
    expect(store.state.doc.nodes.every((n) => n.tags.includes('exposition'))).toBe(true)
  })

  it('filters by search, tag and state together', () => {
    store.editBody(idOf('One'), '[[Go|Two]]\n[[Stay|Three]]')
    store.tagAdd(idOf('Two'), 'combat')
    store.changeState(idOf('Two'), 'Done')

    // Search covers prose as well as titles, so match on something only
    // Three's own card carries.
    store.editBody(idOf('Three'), 'A quiet clearing.')
    store.state.search = 'clearing'
    expect([...store.matches.value!]).toEqual([idOf('Three')])

    store.state.search = ''
    store.state.tagFilter = ['combat']
    expect([...store.matches.value!]).toEqual([idOf('Two')])

    store.state.tagFilter = []
    store.state.stateFilter = ['Done']
    expect([...store.matches.value!]).toEqual([idOf('Two')])

    store.state.stateFilter = []
    expect(store.matches.value).toBeNull()
  })

  it('renders identically after a save/load round trip', () => {
    store.editBody(idOf('One'), '[[Go|Two]]\n[[Stay|Three]]')
    store.editBody(idOf('Two'), '[[On|Four]]')
    store.changeLevelOffset(idOf('Three'), 1)
    store.tagAdd(idOf('Two'), 'combat')

    const json = serializeDoc(store.state.doc)
    const before = store.layout.value.stats.hash

    store.loadStory(json)
    expect(store.layout.value.stats.hash).toBe(before)
    // And the file itself is stable, so re-saving never churns it.
    expect(serializeDoc(store.state.doc)).toBe(json)
  })
})

describe('importing a foreign save file', () => {
  it('clamps an absolute level that no structure could satisfy', () => {
    store.loadStory(
      JSON.stringify({
        storyTitle: 'Hand edited',
        startNodeId: '1',
        nodes: [
          { id: '1', title: 'One', body: '[[Go|Two]]' },
          { id: '2', title: 'Two', body: '', level: 9 },
        ],
      }),
    )

    // Two can only sit at level 2 or 3; 9 is reported and clamped.
    expect(levelOf('Two')).toBe(3)
    expect(store.state.warnings.join(' ')).toContain('asked for level 9')
  })
})

describe('a larger story', () => {
  it('lays out a few hundred passages without overlapping anything', () => {
    const nodes = []
    for (let i = 1; i <= 255; i++) {
      const kids = [2 * i, 2 * i + 1].filter((k) => k <= 255)
      nodes.push({
        id: String(i),
        title: `P${i}`,
        body: kids.map((k) => `[[go|P${k}]]`).join('\n'),
        tags: [],
        state: 'TODO',
        levelOffset: 0,
      })
    }
    const doc = {
      version: 1 as const,
      storyTitle: 'Big',
      startNodeId: '1',
      nodes,
      tagColors: [],
      nextId: 256,
    }

    const started = Date.now()
    const res = layoutStory(doc as never)
    expect(Date.now() - started).toBeLessThan(2000)

    expect(res.stats.layers).toBe(8)
    const byLayer = new Map<number, typeof res.nodes>()
    for (const n of res.nodes) {
      const list = byLayer.get(n.layer) ?? []
      list.push(n)
      byLayer.set(n.layer, list)
    }
    for (const list of byLayer.values()) {
      const sorted = [...list].sort((a, b) => a.x - b.x)
      for (let i = 0; i + 1 < sorted.length; i++) {
        expect(sorted[i + 1]!.x - sorted[i]!.x).toBeGreaterThanOrEqual(sorted[i]!.width - 0.01)
      }
    }
  })
})

describe('finding a passage by its code', () => {
  beforeEach(() => {
    store.clearFilters()
    store.editBody(idOf('One'), '[[Go|Two]]\n[[Stay|Three]]')
  })

  it('matches only the coded passage on an exact code', () => {
    expect(store.codeSet(idOf('Two'), 'A3')).toBeNull()
    // Prose on another passage that contains the code as a substring must not
    // dilute the result — an exact code means "this passage".
    store.editBody(idOf('Three'), 'The a3 corridor smells of smoke.')

    store.state.search = 'A3'
    expect([...store.matches.value!]).toEqual([idOf('Two')])

    // ...and it is case-insensitive, the way the code itself is.
    store.state.search = 'a3'
    expect([...store.matches.value!]).toEqual([idOf('Two')])
  })

  it('still searches prose when the query is not a code', () => {
    store.codeSet(idOf('Two'), 'A3')
    store.editBody(idOf('Three'), 'A quiet clearing.')
    store.state.search = 'clearing'
    expect([...store.matches.value!]).toEqual([idOf('Three')])
  })

  it('falls back to substring matching on a partial code', () => {
    store.codeSet(idOf('Two'), 'END-A3')
    store.state.search = 'END'
    expect([...store.matches.value!]).toEqual([idOf('Two')])
  })

  it('composes with a tag filter', () => {
    store.codeSet(idOf('Two'), 'A3')
    store.state.search = 'A3'
    store.state.tagFilter = ['combat']
    expect([...store.matches.value!]).toEqual([])

    store.tagAdd(idOf('Two'), 'combat')
    expect([...store.matches.value!]).toEqual([idOf('Two')])
  })

  it('leaves layout untouched, since a code has no geometry', () => {
    const before = serializeDoc(store.state.doc)
    const geometry = store.state.doc.nodes.map((n) => [xOf(n.title), yOf(n.title)])
    store.codeSet(idOf('Two'), 'A3')
    expect(serializeDoc(store.state.doc)).not.toBe(before)
    expect(store.state.doc.nodes.map((n) => [xOf(n.title), yOf(n.title)])).toEqual(geometry)
  })
})
