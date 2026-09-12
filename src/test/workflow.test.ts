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

/**
 * What the editor does: type into the body, then leave the field.
 *
 * `editBody` alone only writes text — passages are created and bare links bound
 * when the author blurs, which is what `resolveBody` stands in for here.
 */
function write(id: string, body: string): void {
  const before = store.state.doc.nodes.find((n) => n.id === id)!.body
  store.editBody(id, body)
  store.resolveBody(id, before)
}

/**
 * A link to a passage that already exists, the way the picker writes one.
 *
 * A bare `[[Three]]` means "make me a passage called Three" — titles are not
 * link targets, so re-typing one would create a second passage sharing the name.
 * Pointing at an existing passage means naming its code.
 */
function linkTo(title: string): string {
  return `[[${title}|${store.state.doc.nodes.find((x) => x.title === title)!.code}]]`
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
  write(idOf('One'), '')
})

describe('the spec walkthrough', () => {
  it('auto-creates linked passages and puts siblings on one axis', () => {
    write(idOf('One'), '[[Two]]\n[[Three]]')

    expect(store.state.doc.nodes.map((n) => n.title).sort()).toEqual(['One', 'Three', 'Two'])
    expect(levelOf('One')).toBe(1)
    expect(levelOf('Two')).toBe(2)
    expect(levelOf('Three')).toBe(2)
    expect(yOf('Two')).toBe(yOf('Three'))
    // Equidistant from the parent, per the equilateral-fan rule.
    expect(Math.abs(xOf('One') - xOf('Two'))).toBeCloseTo(Math.abs(xOf('One') - xOf('Three')), 6)
  })

  it('re-levels a descendant when a passage is inserted above it', () => {
    write(idOf('One'), '[[Two]]\n[[Three]]')
    // Rewire One -> Four -> Two, keeping One -> Three. Four is new, so it goes in
    // bare; Two and Three already exist, so they go in by code.
    write(idOf('One'), `[[Four]]\n${linkTo('Three')}`)
    write(idOf('Four'), linkTo('Two'))

    expect(levelOf('Four')).toBe(2)
    expect(levelOf('Three')).toBe(2)
    expect(levelOf('Two')).toBe(3)
  })

  it('lets Three be nudged onto Two’s axis, leaving Four alone on its level', () => {
    write(idOf('One'), '[[Four]]\n[[Three]]')
    write(idOf('Four'), '[[Two]]')

    store.changeLevelOffset(idOf('Three'), 1)

    expect(levelOf('Three')).toBe(3)
    expect(levelOf('Two')).toBe(3)
    expect(yOf('Three')).toBe(yOf('Two'))
    expect(levelOf('Four')).toBe(2)
    expect(yOf('Four')).not.toBe(yOf('Three'))
  })

  it('reports the floor that blocks moving a passage up a level', () => {
    write(idOf('One'), '[[Four]]\n[[Three]]')
    write(idOf('Four'), '[[Two]]')
    store.select(idOf('Three'))

    // Three sits at its floor, pinned by One at level 1: there is no level to
    // move up to, and the UI can name the parent responsible.
    expect(store.selectedLayout.value!.minLevel).toBe(2)
    expect(store.blockingParent.value?.title).toBe('One')
  })

  it('counts unique paths for a perfect binary tree', () => {
    write(idOf('One'), '[[L]]\n[[R]]')
    write(idOf('L'), '[[LL]]\n[[LR]]')
    write(idOf('R'), '[[RL]]\n[[RR]]')

    expect(store.state.doc.nodes).toHaveLength(7)
    expect(store.pathsFrom(idOf('One'))).toBe(4n)
    expect(store.pathsFrom(idOf('L'))).toBe(2n)
  })

  it('recodes through every parent and refuses a collision', () => {
    write(idOf('One'), '[[Cave]]')
    write(idOf('Cave'), '')
    store.addPassage()
    const otherId = store.state.selectedId!
    store.rename(otherId, 'Side Room')
    write(otherId, linkTo('Cave'))

    const caveId = idOf('Cave')
    expect(store.codeSet(caveId, 'Grotto')).toBeNull()
    // Both parents follow the code; the display text they wrote is untouched.
    expect(store.state.doc.nodes.find((n) => n.title === 'One')!.body).toBe('[[Cave|Grotto]]')
    expect(store.state.doc.nodes.find((n) => n.title === 'Side Room')!.body).toBe(
      '[[Cave|Grotto]]',
    )
    // No phantom appeared, so every link still resolves.
    expect(store.layout.value.graph.phantoms).toHaveLength(0)

    const before = serializeDoc(store.state.doc)
    const oneCode = store.state.doc.nodes.find((n) => n.title === 'One')!.code
    expect(store.codeSet(caveId, oneCode)).toContain('already used by')
    expect(serializeDoc(store.state.doc)).toBe(before)
  })

  it('lets two passages share a title without disturbing a link', () => {
    write(idOf('One'), '[[Cave]]')
    const before = store.state.doc.nodes.find((n) => n.title === 'One')!.body
    store.rename(idOf('Cave'), 'One')

    expect(store.state.doc.nodes.map((n) => n.title)).toEqual(['One', 'One'])
    expect(store.state.doc.nodes.find((n) => n.id === '1')!.body).toBe(before)
    expect(store.layout.value.graph.phantoms).toHaveLength(0)
  })

  it('undoes a code cascade in one step', () => {
    write(idOf('One'), '[[Cave]]')
    const before = serializeDoc(store.state.doc)
    store.codeSet(idOf('Cave'), 'Grotto')
    store.undo()
    expect(serializeDoc(store.state.doc)).toBe(before)
  })

  it('leaves prose alone on delete and surfaces a phantom instead', () => {
    write(idOf('One'), '[[Cave]]')
    // Settling bound the bare link to the code it minted.
    expect(store.state.doc.nodes[0]!.body).toBe('[[Cave|P2]]')

    store.removePassage(idOf('Cave'))
    expect(store.state.doc.nodes.map((n) => n.title)).toEqual(['One'])
    expect(store.state.doc.nodes[0]!.body).toBe('[[Cave|P2]]')

    const phantom = store.layout.value.nodes.find((n) => n.isPhantom)!
    expect(phantom.code).toBe('P2')
    // The link's display text is what the card offers as a name.
    expect(phantom.title).toBe('Cave')
    expect(phantom.level).toBe(2)

    // ...and the phantom can be turned back into a real passage, keeping both.
    store.createFromPhantom(phantom.id)
    expect(store.layout.value.nodes.some((n) => n.isPhantom)).toBe(false)
    expect(idOf('Cave')).toBeDefined()
  })

  it('keeps tags global, reusable and recolourable across passages', () => {
    write(idOf('One'), '[[Two]]')
    store.tagAdd(idOf('One'), 'exposition')
    expect(store.tags.value).toContain('exposition')

    // The same tag is now offerable on another passage without retyping.
    store.tagAdd(idOf('Two'), 'exposition')
    store.tagRecolor('exposition', 'purple')

    expect(store.tagColors.value.get('exposition')).toBe('purple')
    expect(store.state.doc.nodes.every((n) => n.tags.includes('exposition'))).toBe(true)
  })

  it('filters by search, tag and state together', () => {
    write(idOf('One'), '[[Two]]\n[[Three]]')
    store.tagAdd(idOf('Two'), 'combat')
    store.changeState(idOf('Two'), 'Done')

    // Search covers prose as well as titles, so match on something only
    // Three's own card carries.
    write(idOf('Three'), 'A quiet clearing.')
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
    write(idOf('One'), '[[Two]]\n[[Three]]')
    write(idOf('Two'), '[[Four]]')
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
          { id: '1', title: 'One', code: 'A', body: '[[Go|B]]' },
          { id: '2', title: 'Two', code: 'B', body: '', level: 9 },
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
        code: `P${i}`,
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
    write(idOf('One'), '[[Two]]\n[[Three]]')
  })

  it('matches only the coded passage on an exact code', () => {
    expect(store.codeSet(idOf('Two'), 'A3')).toBeNull()
    // Prose on another passage that contains the code as a substring must not
    // dilute the result — an exact code means "this passage".
    write(idOf('Three'), 'The a3 corridor smells of smoke.')

    store.state.search = 'A3'
    expect([...store.matches.value!]).toEqual([idOf('Two')])
  })

  it('still finds a passage when the code is typed in the wrong case', () => {
    expect(store.codeSet(idOf('Two'), 'A3')).toBeNull()

    // `[[a3]]` would not link to `A3` — but a search box is not a link, so the
    // query falls through to the folded prose search and still turns it up.
    store.state.search = 'a3'
    expect([...store.matches.value!]).toContain(idOf('Two'))
  })

  it('still searches prose when the query is not a code', () => {
    store.codeSet(idOf('Two'), 'A3')
    write(idOf('Three'), 'A quiet clearing.')
    store.state.search = 'clearing'
    expect([...store.matches.value!]).toEqual([idOf('Three')])
  })

  it('falls back to substring matching on a partial code', () => {
    store.codeSet(idOf('Two'), 'END-A3')
    store.state.search = 'END'

    const hits = [...store.matches.value!]
    expect(hits).toContain(idOf('Two'))
    // One matches too, and correctly so: a code lives in the prose of every
    // passage that links to it, so a partial code finds the way in as well as
    // the destination. Only an exact code narrows to the one passage.
    expect(hits).toContain(idOf('One'))
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

describe('multi-select and mass delete', () => {
  const picked = () => store.selectedNodes.value.map((n) => n.title)

  it('takes a passage and everything it leads to', () => {
    // A diamond with a back edge: the walk must visit Four once and terminate.
    write(idOf('One'), '[[Two]]')
    write(idOf('Two'), '[[Three]]\n[[Four]]')
    // Three and Four already exist, so these link by code rather than making a
    // second passage of each name.
    write(idOf('Three'), linkTo('Four'))
    write(idOf('Four'), linkTo('Two'))

    store.selectSubtree(idOf('Two'))
    expect(picked()).toEqual(['Two', 'Three', 'Four'])
    expect(store.state.selectedId).toBe(idOf('Two'))
  })

  it('falls back to a plain select on a phantom card', () => {
    write(idOf('One'), '[[Ghost]]')
    store.removePassage(idOf('Ghost'))
    const ghost = store.layout.value.nodes.find((n) => n.isPhantom)!.id
    store.selectSubtree(ghost)
    expect(store.state.selectedIds).toEqual([])
    expect(store.state.selectedId).toBe(ghost)
  })

  it('toggles one passage in and out, re-anchoring when the anchor goes', () => {
    write(idOf('One'), '[[Two]]\n[[Three]]')
    store.select(idOf('Two'))
    store.toggleSelected(idOf('Three'))
    expect(picked()).toEqual(['Two', 'Three'])
    expect(store.state.selectedId).toBe(idOf('Three'))

    // Dropping the anchor must leave the inspector pointing at something selected.
    store.toggleSelected(idOf('Three'))
    expect(picked()).toEqual(['Two'])
    expect(store.state.selectedId).toBe(idOf('Two'))
  })

  it('deletes every selected passage in one undo step', () => {
    write(idOf('One'), '[[Two]]')
    write(idOf('Two'), '[[Three]]\n[[Four]]')
    const before = serializeDoc(store.state.doc)

    store.selectSubtree(idOf('Two'))
    expect(store.removeSelected()).toBeNull()
    expect(store.state.doc.nodes.map((n) => n.title)).toEqual(['One'])
    // The link from One is left as written, so Two comes back as a phantom.
    expect(store.state.notice).toBe(
      'Deleted 3 passages. 1 link now points at nothing and shows as a dashed card.',
    )

    store.undo()
    expect(serializeDoc(store.state.doc)).toBe(before)
  })

  it('refuses a delete that would strand a surviving passage', () => {
    write(idOf('One'), '[[Two]]')
    write(idOf('Two'), '[[Three]]')
    const before = serializeDoc(store.state.doc)

    store.select(idOf('Two'))
    const refusal = store.removePassage(idOf('Two'))
    expect(refusal).toContain('"P3 · Three" would no longer be reachable from the start')
    expect(store.state.notice).toBe(refusal)
    // Refused means untouched: no commit, and the selection stands so the
    // author can add the stranded passage to it.
    expect(serializeDoc(store.state.doc)).toBe(before)
    expect(store.state.selectedIds).toEqual([idOf('Two')])
  })

  it('allows the delete once the stranded passage joins the selection', () => {
    write(idOf('One'), '[[Two]]')
    write(idOf('Two'), '[[Three]]')
    store.selectSubtree(idOf('Two'))
    expect(store.removeSelected()).toBeNull()
    expect(store.state.doc.nodes.map((n) => n.title)).toEqual(['One'])
  })

  it('does not block on a passage that was already unreachable', () => {
    write(idOf('One'), '[[Two]]')
    store.addPassage()
    expect(store.removePassage(idOf('Two'))).toBeNull()
  })

  it('re-anchors on the start once the whole selection is gone', () => {
    write(idOf('One'), '[[Two]]\n[[Three]]')
    store.select(idOf('Two'))
    store.toggleSelected(idOf('Three'))
    store.removeSelected()
    expect(store.state.selectedId).toBe(idOf('One'))
    expect(store.state.selectedIds).toEqual([idOf('One')])
  })

  it('drops passages the selection names when history takes them away', () => {
    write(idOf('One'), '[[Two]]\n[[Three]]')
    store.select(idOf('Two'))
    store.toggleSelected(idOf('Three'))

    // Undoing the body edit takes both auto-created passages with it.
    store.undo()
    expect(store.state.doc.nodes.map((n) => n.title)).toEqual(['One'])
    expect(store.state.selectedIds).toEqual([])
    expect(store.state.selectedId).toBeNull()
  })
})
