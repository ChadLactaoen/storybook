import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serializeDoc } from '../lib/doc/serialize'
import { deriveGraph } from '../lib/graph/derive'
import { layoutStory } from '../lib/graph/layout'
import { planRecode } from '../lib/graph/recode'
import type { RecodeOptions } from '../lib/graph/recode'
import * as store from '../stores/story'
import { prefs, resetPrefs } from '../stores/prefs'
import { docFrom } from './helpers'

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

    store.select(idOf('Three'))
    store.levelNudgeSelected(1)

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

  it('removes a tag nothing carries, and takes the filter with it', () => {
    store.tagAdd(idOf('One'), 'exposition')
    store.toggleFilter('tagFilter', 'exposition')
    expect(store.state.tagFilter).toEqual(['exposition'])

    // While a passage carries it, the tag stays — and so does the filter.
    store.tagDelete('exposition')
    expect(store.tags.value).toContain('exposition')
    expect(store.state.tagFilter).toEqual(['exposition'])

    store.tagRemove(idOf('One'), 'exposition')
    store.tagDelete('exposition')
    expect(store.tags.value).not.toContain('exposition')
    // The chip that would switch this filter back off is drawn from `tags`, so
    // leaving the name here would dim the canvas with nothing left to click.
    expect(store.state.tagFilter).toEqual([])
  })

  it('pushes no undo entry for a removal it refused', () => {
    store.tagAdd(idOf('One'), 'exposition')
    const before = store.state.doc
    store.tagDelete('exposition')
    expect(store.state.doc).toBe(before)
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
    store.select(idOf('Three'))
    store.levelNudgeSelected(1)
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

describe('batch state and ending', () => {
  const stateOf = (title: string) => store.state.doc.nodes.find((n) => n.title === title)!.state
  const endingOf = (title: string) => store.state.doc.nodes.find((n) => n.title === title)!.isEnding

  /** The selection the sidebar's batch controls act on. */
  function pickBranch(): void {
    write(idOf('One'), '[[Two]]')
    write(idOf('Two'), '[[Three]]\n[[Four]]')
    store.selectSubtree(idOf('Two'))
    expect(store.selectedNodes.value.map((n) => n.title)).toEqual(['Two', 'Three', 'Four'])
  }

  it('sets the state of the whole selection as one undo step', () => {
    pickBranch()
    const before = serializeDoc(store.state.doc)

    store.changeStateSelected('Done')
    expect(['Two', 'Three', 'Four'].map(stateOf)).toEqual(['Done', 'Done', 'Done'])
    // Untouched: the batch acts on the selection, not on the story.
    expect(stateOf('One')).toBe('TODO')

    store.undo()
    expect(serializeDoc(store.state.doc)).toBe(before)
  })

  it('marks the whole selection as endings as one undo step', () => {
    pickBranch()
    const before = serializeDoc(store.state.doc)

    store.endingSetSelected(true)
    expect(['Two', 'Three', 'Four'].map(endingOf)).toEqual([true, true, true])
    expect(endingOf('One')).toBe(false)

    store.undo()
    expect(serializeDoc(store.state.doc)).toBe(before)
  })

  it('does not commit when the whole selection already agrees', () => {
    pickBranch()
    store.changeStateSelected('Done')
    store.undo()
    expect(store.canRedo.value).toBe(true)

    // The guard in `setStateMany`, which is the same one `setEnding` has always
    // had. Everything selected is TODO again after that undo, so asking for
    // TODO must not push an empty entry and throw the redo away.
    store.changeStateSelected('TODO')
    expect(store.canRedo.value).toBe(true)
    store.endingSetSelected(false)
    expect(store.canRedo.value).toBe(true)

    store.redo()
    expect(['Two', 'Three', 'Four'].map(stateOf)).toEqual(['Done', 'Done', 'Done'])
  })

  it('commits when only part of the selection would change', () => {
    pickBranch()
    store.changeState(idOf('Three'), 'Done')
    store.changeStateSelected('Done')
    expect(['Two', 'Three', 'Four'].map(stateOf)).toEqual(['Done', 'Done', 'Done'])

    // One undo takes the batch off and leaves the single write that preceded it.
    store.undo()
    expect(['Two', 'Three', 'Four'].map(stateOf)).toEqual(['TODO', 'Done', 'TODO'])
  })

  it('toggles the ending flag for a single passage', () => {
    write(idOf('One'), '[[Two]]')
    store.select(idOf('Two'))

    // One passage is just a selection of one: the same call the sidebar's
    // checkbox and the keyboard both make, with nothing to branch on.
    store.endingToggleSelected()
    expect(endingOf('Two')).toBe(true)
    store.endingToggleSelected()
    expect(endingOf('Two')).toBe(false)
  })

  it('marks a mixed selection rather than clearing the ones already set', () => {
    pickBranch()
    store.endingSet(idOf('Three'), true)
    store.selectSubtree(idOf('Two'))

    store.endingToggleSelected()
    expect(['Two', 'Three', 'Four'].map(endingOf)).toEqual([true, true, true])

    // Only once everything agrees does the key clear, which is what makes a
    // second press undo the first.
    store.endingToggleSelected()
    expect(['Two', 'Three', 'Four'].map(endingOf)).toEqual([false, false, false])
  })

  it('does nothing when the selection holds no passage', () => {
    pickBranch()
    store.endingSetSelected(true)
    store.undo()
    expect(store.canRedo.value).toBe(true)

    // Clearing the selection leaves `selectedIds` empty, the same as anchoring
    // on a phantom. Toggling must not commit, or the redo would be thrown away.
    store.select(null)
    store.endingToggleSelected()
    expect(store.canRedo.value).toBe(true)

    store.redo()
    expect(['Two', 'Three', 'Four'].map(endingOf)).toEqual([true, true, true])
  })

  it('reports the state the selection shares, and null when it does not', () => {
    pickBranch()
    expect(store.selectedState.value).toBe('TODO')

    store.changeState(idOf('Three'), 'Done')
    // Mixed: the segmented control lights nothing and the menu ticks nothing,
    // rather than naming one of the three the selection is not all of.
    expect(store.selectedState.value).toBeNull()

    store.changeStateSelected('Done')
    expect(store.selectedState.value).toBe('Done')

    store.select(null)
    expect(store.selectedState.value).toBeNull()
  })

  it('agrees with the tri-state the sidebar draws', () => {
    pickBranch()
    expect(store.allSelectedEndings.value).toBe(false)
    expect(store.selectedEndingCount.value).toBe(0)

    store.endingSet(idOf('Three'), true)
    expect(store.selectedEndingCount.value).toBe(1)
    expect(store.allSelectedEndings.value).toBe(false)

    store.endingSetSelected(true)
    expect(store.allSelectedEndings.value).toBe(true)

    // Empty is not "all of them": with nothing selected the box is not ticked,
    // and the key has nothing to act on.
    store.select(null)
    expect(store.allSelectedEndings.value).toBe(false)
  })

  it('changes neither the drawing nor the selection', () => {
    pickBranch()
    const hash = store.layout.value.stats.hash

    store.changeStateSelected('Draft')
    store.endingSetSelected(true)

    // Both fields are deliberately outside `layoutKey`, so a batch of either is
    // a pure re-render: no card moves, and the selection survives to be acted
    // on again.
    expect(store.layout.value.stats.hash).toBe(hash)
    expect(store.selectedNodes.value.map((n) => n.title)).toEqual(['Two', 'Three', 'Four'])
    expect(store.state.selectedId).toBe(idOf('Two'))
  })
})

describe('batch level offset', () => {
  /** One -> Two -> {Three, Four}, with Two and everything under it selected. */
  function pickBranch(): void {
    write(idOf('One'), '[[Two]]')
    write(idOf('Two'), '[[Three]]\n[[Four]]')
    store.selectSubtree(idOf('Two'))
    expect(store.selectedNodes.value.map((n) => n.title)).toEqual(['Two', 'Three', 'Four'])
  }

  it('nudges the whole selection as one undo step', () => {
    pickBranch()
    const before = serializeDoc(store.state.doc)

    store.levelNudgeSelected(1)
    expect(store.state.doc.nodes.filter((n) => n.levelOffset === 1)).toHaveLength(3)

    // One step, not three: the batch is a single mutation and a single commit.
    store.undo()
    expect(serializeDoc(store.state.doc)).toBe(before)
    store.redo()
    expect(store.state.doc.nodes.filter((n) => n.levelOffset === 1)).toHaveLength(3)
  })

  it('drops a selected passage under another selected one further than one level', () => {
    pickBranch()
    expect(['Two', 'Three', 'Four'].map(levelOf)).toEqual([2, 3, 3])

    store.levelNudgeSelected(1)

    // Not a bug and not a thing to "fix": `minLevel` is recomputed from the
    // parent's *final* level, so Two's own nudge raises the floor under Three
    // and Four before their offsets are added on top. Nudging one below your
    // floor is what the control says it does; the floor is derived.
    expect(['Two', 'Three', 'Four'].map(levelOf)).toEqual([3, 5, 5])
  })

  it('refuses a selection that disagrees about where it sits', () => {
    pickBranch()
    store.select(idOf('Three'))
    store.levelNudgeSelected(1)
    store.selectSubtree(idOf('Two'))

    expect(store.selectedOffset.value).toBe(null)
    expect(store.canNudgeSelectedDown.value).toBe(false)
    expect(store.canNudgeSelectedUp.value).toBe(false)
    expect(store.selectedNudgedCount.value).toBe(1)

    const before = serializeDoc(store.state.doc)
    store.undo()
    store.redo()
    // Redo is the tell: a refused move that still committed would have cleared
    // it, and a no-op that cloned anyway would have pushed an empty entry.
    store.selectSubtree(idOf('Two'))
    store.levelNudgeSelected(1)
    store.levelNudgeSelected(-1)
    expect(serializeDoc(store.state.doc)).toBe(before)
    expect(store.canUndo.value).toBe(true)
  })

  it('reverses exactly, drawing and all', () => {
    pickBranch()
    const doc = serializeDoc(store.state.doc)
    const hash = store.layout.value.stats.hash

    store.levelNudgeSelected(1)
    store.levelNudgeSelected(-1)

    expect(serializeDoc(store.state.doc)).toBe(doc)
    expect(store.layout.value.stats.hash).toBe(hash)
  })

  it('does nothing with nothing selected', () => {
    write(idOf('One'), '[[Two]]')
    store.select(null)
    const before = serializeDoc(store.state.doc)

    store.levelNudgeSelected(1)
    store.levelNudgeSelected(-1)
    expect(serializeDoc(store.state.doc)).toBe(before)
    expect(store.canUndo.value).toBe(true)
  })

  it('keeps the selection and the anchor, so the move can be taken back', () => {
    pickBranch()
    store.levelNudgeSelected(1)

    expect(store.selectedNodes.value.map((n) => n.title)).toEqual(['Two', 'Three', 'Four'])
    expect(store.state.selectedId).toBe(idOf('Two'))
    expect(store.canNudgeSelectedUp.value).toBe(true)
  })

  it('redraws, unlike every other batch — this field is in `layoutKey`', () => {
    pickBranch()
    const hash = store.layout.value.stats.hash
    const version = store.layoutVersion.value

    store.levelNudgeSelected(1)

    // The deliberate mirror of 'changes neither the drawing nor the selection'
    // above: State and Ending are absent from `layoutKey` and are pure
    // re-renders, `levelOffset` is in it and is a real Sugiyama pass. A test
    // pinning the hash here would be asserting something false.
    expect(store.layout.value.stats.hash).not.toBe(hash)
    expect(store.layoutVersion.value).toBeGreaterThan(version)
  })
})

describe('batch setting', () => {
  const settingOf = (title: string) =>
    store.state.doc.nodes.find((n) => n.title === title)!.setting

  function pickBranch(): void {
    write(idOf('One'), '[[Two]]')
    write(idOf('Two'), '[[Three]]\n[[Four]]')
    store.selectSubtree(idOf('Two'))
    expect(store.selectedNodes.value.map((n) => n.title)).toEqual(['Two', 'Three', 'Four'])
  }

  it('puts the whole selection in one place as one undo step', () => {
    pickBranch()
    const before = serializeDoc(store.state.doc)

    store.settingSetSelected('  The cellar  ')
    expect(['Two', 'Three', 'Four'].map(settingOf)).toEqual([
      'The cellar',
      'The cellar',
      'The cellar',
    ])
    // Untouched: the batch acts on the selection, not on the story.
    expect(settingOf('One')).toBe('')

    store.undo()
    expect(serializeDoc(store.state.doc)).toBe(before)
  })

  it('clears the whole selection when handed nothing', () => {
    pickBranch()
    store.settingSetSelected('The cellar')
    store.settingSetSelected('')
    expect(['Two', 'Three', 'Four'].map(settingOf)).toEqual(['', '', ''])

    store.undo()
    expect(['Two', 'Three', 'Four'].map(settingOf)).toEqual([
      'The cellar',
      'The cellar',
      'The cellar',
    ])
  })

  it('does not commit when the whole selection already agrees', () => {
    pickBranch()
    store.settingSetSelected('The cellar')
    store.undo()
    expect(store.canRedo.value).toBe(true)

    // The guard in `setSettingMany`. Everything selected is unset again after
    // that undo, so asking to clear must not push an empty entry and throw the
    // redo away — and neither must a padded repeat once it is set.
    store.settingSetSelected('')
    expect(store.canRedo.value).toBe(true)

    store.redo()
    store.settingSetSelected(' The cellar ')
    expect(store.canRedo.value).toBe(false)
    expect(['Two', 'Three', 'Four'].map(settingOf)).toEqual([
      'The cellar',
      'The cellar',
      'The cellar',
    ])
  })

  it('reads the shared setting, and null while they disagree', () => {
    pickBranch()
    expect(store.selectedSetting.value).toBe('')
    expect(store.selectedSettingCount.value).toBe(0)

    store.settingSet(idOf('Three'), 'Docks')
    expect(store.selectedSetting.value).toBeNull()
    expect(store.selectedSettingCount.value).toBe(1)

    // A mixed selection has a shared move, unlike a mixed level: naming one
    // place is something every passage in the set can do.
    store.settingSetSelected('The cellar')
    expect(store.selectedSetting.value).toBe('The cellar')
    expect(store.selectedSettingCount.value).toBe(3)
  })

  it('changes neither the drawing nor the selection', () => {
    pickBranch()
    const hash = store.layout.value.stats.hash

    store.settingSetSelected('The cellar')

    // `setting` is deliberately absent from `layoutKey`, so this is a pure
    // re-render — the mirror of the level batch, which is in it and redraws.
    expect(store.layout.value.stats.hash).toBe(hash)
    expect(store.selectedNodes.value.map((n) => n.title)).toEqual(['Two', 'Three', 'Four'])
    expect(store.state.selectedId).toBe(idOf('Two'))
  })

  it('writes one passage through the same call', () => {
    write(idOf('One'), '[[Two]]')
    store.select(idOf('Two'))

    store.settingSetSelected('Docks')
    expect(settingOf('Two')).toBe('Docks')
    expect(settingOf('One')).toBe('')
  })
})

describe('story notes through the store', () => {
  it('commits, undoes and rides the save file out', () => {
    store.storyNotesSet('Mira never learns the truth.')
    expect(store.state.doc.notes).toBe('Mira never learns the truth.')

    store.undo()
    expect(store.state.doc.notes).toBe('')
    store.redo()
    expect(store.state.doc.notes).toBe('Mira never learns the truth.')

    expect(JSON.parse(serializeDoc(store.state.doc)).notes).toBe('Mira never learns the truth.')
  })

  it('leaves the search index alone — a story-wide hit has no card to light up', () => {
    write(idOf('One'), '[[Two]]')
    store.storyNotesSet('innkeeper')
    store.state.search = 'innkeeper'
    expect(store.matches.value?.size).toBe(0)
  })
})

describe('conditional links through the store', () => {
  it('does not move a single card when a note or a slug changes', () => {
    write(idOf('One'), '[[Two]]\n[[Three]]')
    const before = store.layout.value.stats.hash

    store.noteSet(idOf('Two'), 'needs a rewrite')
    store.noteSet(idOf('Three'), 'done')
    store.storyNotesSet('A paragraph about the ending.')
    store.slugSet(idOf('Two'), 'LY')

    // A note is authoring metadata, per passage or story-wide: put either in
    // `layoutKey` and every keystroke re-parses every body in the story. A slug
    // is read off the graph rather than fed into it, so it must be as invisible
    // here as a note is.
    expect(store.layout.value.stats.hash).toBe(before)
  })

  it('re-reads the macros when a body changes, and not when a tag does', () => {
    write(idOf('One'), '[[Two]]')
    const read = store.gates.value

    // A tag replaces the document but reaches no macro, so the whole story is
    // not re-scanned for one. The identity check is how that is observable.
    store.tagAdd(idOf('One'), 'opening')
    expect(store.gates.value).toBe(read)

    write(idOf('Two'), '(set: $v to "x")')
    expect(store.gates.value).not.toBe(read)
  })

  it('recomputes the running slugs on a slug or an ending, and not on a tag', () => {
    write(idOf('One'), '[[Two]]')
    const read = store.runningSlugs.value

    // A tag reaches nothing a running slug is made of, so the map comes back
    // with the same identity and no card re-renders.
    store.tagAdd(idOf('One'), 'opening')
    expect(store.runningSlugs.value).toBe(read)

    // These two do, and neither is in `layoutKey` — which is the whole reason
    // this memo cannot key on `layoutVersion` the way `gates` does. Get it
    // wrong and the value is stale *and* recomputed: the body re-runs, the key
    // matches, and the previous map is handed back.
    store.slugSet(idOf('One'), 'A')
    const marked = store.runningSlugs.value
    expect(marked).not.toBe(read)
    expect(marked.get(idOf('Two'))).toBe('A')

    store.endingSet(idOf('One'), true)
    const ended = store.runningSlugs.value
    expect(ended).not.toBe(marked)
    // Routes stop at One, so nothing arrives at Two any more.
    expect(ended.has(idOf('Two'))).toBe(false)
    store.endingSet(idOf('One'), false)
  })

  it('finds a passage by the route code that reaches it, not just its own mark', () => {
    // What a reader quotes back is the whole run, so that is what has to be
    // pasteable. `One` is marked `A` and `Two` is marked `B`, so Two's route
    // code is `AB` — a string neither passage holds in any field of its own.
    write(idOf('One'), '[[Two]]')
    const one = idOf('One')
    const two = idOf('Two')
    store.slugSet(one, 'A')
    store.slugSet(two, 'B')

    const hits = (q: string) => {
      store.state.search = q
      return [...(store.matches.value ?? [])]
    }

    expect(store.runningSlugs.value.get(two)).toBe('AB')
    expect(hits('AB')).toEqual([two])
    // And the widening this buys: the mark on One reaches everything downstream
    // of it, which is how you ask "what does a route through A get to?".
    expect(hits('A').sort()).toEqual([one, two].sort())
    store.clearFilters()
  })

  it('finds a passage whose route the tool cannot pin down', () => {
    // A bare `*` sweeps up every passage a reader could arrive at more than one
    // way — the marks disagree, so the card shows a star, and so can a search.
    write(idOf('One'), '[[Two]]\n[[Three]]')
    write(idOf('Two'), '[[Four]]')
    // `linkTo`, not a second bare `[[Four]]`: titles are not link targets, so
    // that would make a second passage called Four rather than joining this one.
    write(idOf('Three'), linkTo('Four'))
    store.slugSet(idOf('One'), 'A')
    store.slugSet(idOf('Two'), 'B')
    store.slugSet(idOf('Three'), 'C')
    store.slugSet(idOf('Four'), 'D')

    expect(store.runningSlugs.value.get(idOf('Four'))).toBe('A*D')

    store.state.search = '*'
    expect([...(store.matches.value ?? [])]).toEqual([idOf('Four')])
    store.clearFilters()
  })

  it('filters to the passages carrying a note', () => {
    write(idOf('One'), '[[Two]]\n[[Three]]')
    store.noteSet(idOf('Two'), 'the innkeeper still needs a name')

    expect(store.anyNotes.value).toBe(true)
    store.state.noteFilter = true
    expect([...(store.matches.value ?? [])]).toEqual([idOf('Two')])

    // Filters on presence, not on content, so it stacks with everything else
    // the same way a state chip does.
    store.state.search = 'innkeeper'
    expect([...(store.matches.value ?? [])]).toEqual([idOf('Two')])
    store.state.search = 'nothing matches this'
    expect([...(store.matches.value ?? [])]).toEqual([])

    store.clearFilters()
    expect(store.state.noteFilter).toBe(false)
    expect(store.filtering.value).toBe(false)
    expect(store.matches.value).toBeNull()
  })

  it('offers the note filter only once there is a note to find', () => {
    write(idOf('One'), '[[Two]]')
    expect(store.anyNotes.value).toBe(false)
    store.noteSet(idOf('Two'), 'x')
    expect(store.anyNotes.value).toBe(true)
    store.noteSet(idOf('Two'), '')
    expect(store.anyNotes.value).toBe(false)
  })

  it('counts the note filter as filtering, or the clear control lies', () => {
    // `filtering` and `matches` must agree on the predicate, or the bar offers
    // a "clear filters" button while nothing is filtered — or worse, hides it
    // while something is.
    write(idOf('One'), '')
    store.noteSet(idOf('One'), 'a note')
    store.state.noteFilter = true
    expect(store.filtering.value).toBe(true)
    expect(store.matches.value).not.toBeNull()
    store.clearFilters()
  })

  it('names the passage a conditional link locks a route to', () => {
    write(idOf('One'), '[[Pick]]')
    write(idOf('Pick'), '(set:$idol to "p")\n[[Mid]]')
    write(idOf('Mid'), '(if:$idol is "p")[[End]]')

    // The whole point: the link graph says Mid links to End unconditionally.
    expect(store.gates.value.get(idOf('End'))!.gateId).toBe(idOf('Pick'))
  })

  it('reports a passage whose condition nothing can satisfy', () => {
    write(idOf('One'), '(if:$idol is "never")[[End]]')
    expect(store.gates.value.get(idOf('End'))!.dead).toBe(true)
  })

  it('keeps a note verbatim, spaces and newlines and all', () => {
    write(idOf('One'), '')
    const typed = '  needs a rewrite\n\n  - and a name for the innkeeper\n'
    store.noteSet(idOf('One'), typed)
    expect(store.state.doc.nodes.find((n) => n.id === idOf('One'))!.note).toBe(typed)
  })

  it('finds a passage by its note, its title, its code and its slug', () => {
    write(idOf('One'), '[[Two]]')
    const two = idOf('Two')
    store.noteSet(two, 'turning point')
    store.slugSet(two, 'LY')

    const hits = (q: string) => {
      store.state.search = q
      return [...(store.matches.value ?? [])]
    }
    expect(hits('turning point')).toEqual([two])
    expect(hits('Two')).toContain(two)
    // An exact code narrows to that passage alone, on purpose.
    expect(hits(store.state.doc.nodes.find((n) => n.id === two)!.code)).toEqual([two])
    // A slug is something the author writes down and later wants to find again,
    // the same as a code.
    expect(hits('LY')).toEqual([two])
    store.clearFilters()
  })
})

describe('recoding the whole story', () => {
  const LEVEL_NODE: RecodeOptions = { mode: 'levelNode', prefix: '', separator: 'N' }

  /** A small branching story, written the way the editor writes one. */
  function branch(): void {
    write(idOf('One'), '[[Two]]\n[[Three]]')
    write(idOf('Two'), '[[Four]]')
    write(idOf('Three'), `[[Four|${store.state.doc.nodes.find((n) => n.title === 'Four')!.code}]]`)
  }

  function codeOf(title: string): string {
    return store.state.doc.nodes.find((n) => n.title === title)!.code
  }

  it('numbers every passage off the tree, and follows the links', () => {
    branch()
    expect(store.codesRecode(LEVEL_NODE)).toBeNull()

    expect(codeOf('One')).toBe('1N01')
    expect(codeOf('Four')).toBe('3N01')
    expect([codeOf('Two'), codeOf('Three')].sort()).toEqual(['2N01', '2N02'])
    // Every link still lands: nothing fell out as a phantom.
    expect(store.layout.value.nodes.filter((n) => n.isPhantom)).toHaveLength(0)
    expect(store.state.doc.nodes.find((n) => n.title === 'One')!.body).toContain(
      `|${codeOf('Two')}]]`,
    )
  })

  it('is one undo step, however many passages moved', () => {
    branch()
    const before = serializeDoc(store.state.doc)
    store.codesRecode(LEVEL_NODE)
    expect(serializeDoc(store.state.doc)).not.toBe(before)
    store.undo()
    expect(serializeDoc(store.state.doc)).toBe(before)
  })

  it('settles: recoding again changes nothing, and pushes no undo entry', () => {
    branch()
    store.codesRecode(LEVEL_NODE)
    const settled = store.state.doc

    // The numbering the tree now shows is the numbering it already has.
    expect(planRecode(store.layout.value, LEVEL_NODE).changed).toBe(0)

    store.codesRecode(LEVEL_NODE)
    expect(store.state.doc).toBe(settled)
  })

  it('settles a story of loose fragments, which is where it used to rotate', () => {
    // Eleven passages linked to nothing: eleven components, packed in codepoint
    // order. Unpadded, each press reshuffled every code and never converged.
    for (let i = 0; i < 10; i++) store.addPassage()
    expect(store.state.doc.nodes).toHaveLength(11)

    store.codesRecode({ mode: 'node', prefix: 'P', separator: '' })
    const first = store.state.doc.nodes.map((n) => n.code).sort().join(' ')

    store.codesRecode({ mode: 'node', prefix: 'P', separator: '' })
    expect(store.state.doc.nodes.map((n) => n.code).sort().join(' ')).toBe(first)
    expect(planRecode(store.layout.value, { mode: 'node', prefix: 'P', separator: '' }).changed).toBe(0)
  })

  it('warns about every dangling link it attaches, not just the first pass\'s', () => {
    // The warning is measured against the settled document rather than read off
    // the first plan, so a capture that only happens on a later pass still shows.
    write(idOf('One'), '[[Two]]')
    store.addPassage()
    store.editBody(idOf('One'), '[[Two|P2]]\n[[go|1N02]]\n[[on|2N01]]')

    const before = new Set(deriveGraph(store.state.doc).phantoms.map((p) => p.code))
    expect(before.size).toBeGreaterThan(0)

    const warned = store.recodePreview(LEVEL_NODE).captures
    store.codesRecode(LEVEL_NODE)
    const after = new Set(deriveGraph(store.state.doc).phantoms.map((p) => p.code))
    const reallyAttached = [...before].filter((c) => !after.has(c)).sort()

    expect(warned.slice().sort()).toEqual(reallyAttached)
  })

  it('ignores a preview settled against a document that has since changed', () => {
    branch()
    const stale = store.recodePreview(LEVEL_NODE)
    // Something else edits the story between preview and apply.
    store.addPassage()

    expect(store.codesRecode(LEVEL_NODE, stale)).toBeNull()
    // Every passage is coded, including the one the stale preview never saw.
    expect(store.state.doc.nodes.every((n) => n.code.length > 0)).toBe(true)
    expect(new Set(store.state.doc.nodes.map((n) => n.code)).size).toBe(
      store.state.doc.nodes.length,
    )
    expect(store.recodePreview(LEVEL_NODE).changed).toBe(0)
  })

  it('writes exactly what the preview showed, down to the last row', () => {
    // The panel's rows are the promise the button keeps. Planning once and
    // applying a re-plan would quietly hand the author a different mapping.
    for (let i = 0; i < 10; i++) store.addPassage()
    const previewed = store
      .recodePreview(LEVEL_NODE)
      .entries.map((e) => `${e.id}:${e.to}`)
      .sort()

    store.codesRecode(LEVEL_NODE)
    const written = store.state.doc.nodes.map((n) => `${n.id}:${n.code}`).sort()
    expect(written).toEqual(previewed)
  })

  it('adds the next passage in the shape the recode left behind', () => {
    // The wrinkle this closes: recode everything to `T…`, press + Passage, and
    // get `P13` — the one code in the story that does not match the rest.
    branch()
    expect(store.codesRecode({ mode: 'node', prefix: 'T', separator: '' })).toBeNull()
    expect(store.state.doc.nodes.map((n) => n.code).sort()).toEqual(['T01', 'T02', 'T03', 'T04'])

    store.addPassage()
    const added = store.state.doc.nodes.find((n) => n.title === 'Untitled Passage')!
    expect(added.code).toBe('T05')

    // Recoding again renumbers rather than no-ops, and rightly so: the new
    // passage is an orphan at level 1, so it takes a number in the middle of the
    // order and shifts everything after it. What matters is that it settles.
    const T = { mode: 'node' as const, prefix: 'T', separator: '' }
    expect(store.codesRecode(T)).toBeNull()
    expect(store.state.doc.nodes.map((n) => n.code).sort()).toEqual([
      'T01', 'T02', 'T03', 'T04', 'T05',
    ])
    expect(store.recodePreview(T).changed).toBe(0)
  })

  it('previews what the document receives even when captures keep redrawing it', () => {
    // Dangling links named after the very codes the scheme mints: each pass
    // attaches one more and redraws the tree the next pass reads. The preview
    // is read off the settled drawing rather than re-planned, so it holds even
    // if the pass budget runs out before the numbering stops moving.
    // `editBody` without `resolveBody`, so the targets stay dangling instead of
    // being turned into real passages the way the editor's blur would.
    write(idOf('One'), '[[Two]]')
    write(idOf('Two'), '[[Three]]')
    store.editBody(idOf('One'), '[[Two|P2]]\n[[go|2N02]]\n[[on|3N01]]\n[[up|1N02]]')
    expect(deriveGraph(store.state.doc).phantoms.length).toBeGreaterThan(0)

    const previewed = store
      .recodePreview(LEVEL_NODE)
      .entries.map((e) => `${e.id}:${e.to}`)
      .sort()
    expect(store.codesRecode(LEVEL_NODE)).toBeNull()
    expect(store.state.doc.nodes.map((n) => `${n.id}:${n.code}`).sort()).toEqual(previewed)
  })

  it('previews the code each passage has now, never an intermediate one', () => {
    branch()
    const before = new Map(store.state.doc.nodes.map((n) => [n.id, n.code]))
    for (const entry of store.recodePreview(LEVEL_NODE).entries) {
      expect(entry.from).toBe(before.get(entry.id))
    }
  })

  it('refuses a numbering the preview already rejected, writing nothing', () => {
    branch()
    const before = store.state.doc
    const error = store.codesRecode({ mode: 'node', prefix: 'X|', separator: '' })
    expect(error).toContain('|')
    expect(store.state.doc).toBe(before)
  })

  it('previews without touching the document', () => {
    branch()
    const before = store.state.doc
    const plan = store.recodePreview(LEVEL_NODE)
    expect(plan.entries).toHaveLength(4)
    expect(store.state.doc).toBe(before)
  })
})

describe('marking endings', () => {
  beforeEach(() => store.newStory('Endings'))

  it('survives a save and reload', () => {
    write(idOf('Start'), '[[Two]]\n[[Three]]')
    store.endingSet(idOf('Two'), true)
    const json = serializeDoc(store.state.doc)

    store.loadStory(json)
    expect(store.state.doc.nodes.find((n) => n.title === 'Two')!.isEnding).toBe(true)
    expect(store.state.doc.nodes.find((n) => n.title === 'Three')!.isEnding).toBe(false)
    expect(serializeDoc(store.state.doc)).toBe(json)
  })

  it('undoes and redoes as one step', () => {
    write(idOf('Start'), '[[Two]]')
    const id = idOf('Two')
    const isEnding = () => store.state.doc.nodes.find((n) => n.id === id)!.isEnding

    store.endingSet(id, true)
    expect(isEnding()).toBe(true)
    store.undo()
    expect(isEnding()).toBe(false)
    store.redo()
    expect(isEnding()).toBe(true)
  })

  it('does not commit when the value is already what was asked for', () => {
    write(idOf('Start'), '[[Two]]')
    const id = idOf('Two')

    store.endingSet(id, true)
    store.undo()
    expect(store.canRedo.value).toBe(true)

    // The guard in `setEnding`. A checkbox is easy to re-fire, and `commit`
    // compares by reference: an unguarded write of the value already there
    // would push an empty undo entry and throw the redo away. Watching redo
    // survive is what proves no commit happened.
    store.endingSet(id, false)
    expect(store.canRedo.value).toBe(true)

    store.redo()
    expect(store.state.doc.nodes.find((n) => n.id === id)!.isEnding).toBe(true)
  })

  it('changes the route count without redrawing the tree', () => {
    write(idOf('Start'), '[[Two]]\n[[Three]]')
    write(idOf('Two'), '[[Four]]')
    const hash = store.layout.value.stats.hash
    expect(store.pathsFrom(idOf('Start'))).toBe(2n)

    store.endingSet(idOf('Two'), true)

    // Two still counts as a route, but Four is no longer on one.
    expect(store.pathsFrom(idOf('Start'))).toBe(2n)
    expect(store.pathsFrom(idOf('Four'))).toBe(1n)
    expect(store.layout.value.stats.hash).toBe(hash)
  })
})

/**
 * The drawing settings, through the store rather than through `layoutStory`.
 *
 * `layout.test.ts` covers what each setting does to a drawing by passing a
 * config straight in. What it cannot see is the wiring: `configKey` is what
 * puts the settings in the memo key, and without it `setDoc` would return at
 * its early exit — the document has not changed — leaving the menu's rows
 * silently doing nothing until the next structural edit. These commands are
 * chordless, so `commands.test.ts` enrols none of them either, which would
 * leave that drift with nothing watching for it at all.
 */
describe('the drawing settings', () => {
  beforeEach(() => {
    resetPrefs()
    // A passage reached from three levels at once, which is what makes the two
    // packings disagree. A tree draws identically under either, so a fixture
    // without a merge could not tell a working toggle from a dead one.
    store.newStory('Settings')
    store.loadStory(
      serializeDoc(
        docFrom({
          Start: ['A', 'B', 'C', 'D'],
          A: ['A1', 'A2'],
          B: ['B1', 'B2'],
          C: ['C1', 'C2', 'Merge'],
          D: ['D1', 'D2'],
          A1: ['A1a'],
          A2: ['A2a'],
          B1: ['B1a', 'Merge'],
          B2: ['B2a'],
          C1: ['C1a'],
          C2: ['C2a'],
          D1: ['D1a'],
          D2: ['D2a'],
          A1a: ['Merge'],
          // The endings matter: without a populated layer below them the two
          // packings have nothing to disagree about and this suite would pass
          // against a toggle that did nothing at all.
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
        }),
      ),
    )
  })

  afterEach(() => resetPrefs())

  it('redraws when a setting changes, in the same turn', () => {
    const before = store.layout.value.stats.hash
    store.setDrawingPref('alignedView', true)
    // Synchronously, deliberately: a watcher would flush a tick late and leave
    // anything reading `layout` in this turn looking at the previous drawing.
    expect(store.layout.value.stats.hash).not.toBe(before)
    expect(store.layout.value.nodes).toHaveLength(store.state.doc.nodes.length)
  })

  it('draws narrower on compact, and puts it back on the way out', () => {
    const width = () => store.layout.value.bounds.maxX - store.layout.value.bounds.minX
    const roomy = width()
    store.setDrawingPref('compactSpacing', true)
    expect(width()).toBeLessThan(roomy)
    store.setDrawingPref('compactSpacing', false)
    expect(width()).toBe(roomy)
  })

  it('persists the choice, so a reload draws what was left on screen', () => {
    store.setDrawingPref('alignedView', true)
    const aligned = store.layout.value.stats.hash
    // What a reload restores is the preference, not the drawing: nothing
    // positional is ever saved, so the same preference has to reproduce it.
    expect(prefs.alignedView).toBe(true)
    store.setDrawingPref('alignedView', false)
    store.setDrawingPref('alignedView', true)
    expect(store.layout.value.stats.hash).toBe(aligned)
  })

  it('is a no-op when the setting is already what it is', () => {
    store.setDrawingPref('alignedView', true)
    const version = store.layoutVersion.value
    store.setDrawingPref('alignedView', true)
    expect(store.layoutVersion.value).toBe(version)
  })
})
