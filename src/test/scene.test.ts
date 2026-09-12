import { beforeEach, describe, expect, it } from 'vitest'
import {
  addPassageCharacter,
  characterUsage,
  createCharacter,
  createNode,
  deleteCharacter,
  inheritedSetting,
  moveCharacter,
  materializePhantom,
  renameCharacter,
  renameSetting,
  setBody,
  setCharacterBio,
  setPassageCharacterNote,
  setSetting,
  settingUsage,
  sortCharacters,
} from '../lib/doc/mutations'
import { parseDoc, serializeDoc } from '../lib/doc/serialize'
import * as store from '../stores/story'
import type { StoryDoc } from '../types/story'
import { compareNodes, emptyCharacter, emptyDoc } from '../types/story'
import { docFrom, shuffled } from './helpers'

function idOf(doc: StoryDoc, title: string): string {
  const n = doc.nodes.find((x) => x.title === title)
  if (!n) throw new Error(`no passage titled ${title}`)
  return n.id
}

function settingOf(doc: StoryDoc, title: string): string {
  return doc.nodes.find((n) => n.title === title)!.setting
}

describe('setting inheritance', () => {
  it('gives a passage created by a new link its parent’s setting', () => {
    let doc = createNode(emptyDoc(), { title: 'Tavern Door' }).doc
    const id = doc.nodes[0]!.id
    doc = setSetting(doc, id, 'The Rusty Anchor')
    doc = setBody(doc, id, '[[Step inside|Common Room]]')

    expect(settingOf(doc, 'Common Room')).toBe('The Rusty Anchor')
  })

  it('lets the child override without the parent clawing it back', () => {
    let doc = createNode(emptyDoc(), { title: 'Tavern Door' }).doc
    const parent = doc.nodes[0]!.id
    doc = setSetting(doc, parent, 'The Rusty Anchor')
    doc = setBody(doc, parent, '[[Step inside|Common Room]]')

    doc = setSetting(doc, idOf(doc, 'Common Room'), 'The Cellar')
    // Editing the parent again must not re-inherit onto an existing passage.
    doc = setBody(doc, parent, 'More prose.\n[[Step inside|Common Room]]')

    expect(settingOf(doc, 'Common Room')).toBe('The Cellar')
  })

  it('inherits into a phantom only when every parent agrees', () => {
    const agreeing = docFrom(
      { North: ['Cave'], South: ['Cave'] },
      { settings: { North: 'The Moors', South: 'The Moors' } },
    )
    expect(inheritedSetting(agreeing, 'Cave')).toBe('The Moors')
    expect(settingOf(materializePhantom(agreeing, 'Cave'), 'Cave')).toBe('The Moors')

    const disagreeing = docFrom(
      { North: ['Cave'], South: ['Cave'] },
      { settings: { North: 'The Moors', South: 'The Docks' } },
    )
    // Two parents in different places: guessing one would plant wrong metadata.
    expect(inheritedSetting(disagreeing, 'Cave')).toBe('')
    expect(settingOf(materializePhantom(disagreeing, 'Cave'), 'Cave')).toBe('')
  })

  it('leaves a passage created with no parent blank', () => {
    const doc = createNode(docFrom({ A: [] }, { settings: { A: 'Somewhere' } })).doc
    expect(doc.nodes.find((n) => n.title === 'Untitled Passage')!.setting).toBe('')
  })
})

describe('the cast roster', () => {
  function seeded() {
    let doc = docFrom({ One: ['Two'], Two: [] })
    doc = createCharacter(doc, 'Mira').doc
    doc = setCharacterBio(doc, 'Mira', "The innkeeper's daughter")
    doc = addPassageCharacter(doc, idOf(doc, 'One'), 'Mira')
    doc = setPassageCharacterNote(doc, idOf(doc, 'One'), 'Mira', 'Furious.')
    doc = addPassageCharacter(doc, idOf(doc, 'Two'), 'Mira')
    doc = setPassageCharacterNote(doc, idOf(doc, 'Two'), 'Mira', 'Quietly relieved.')
    return doc
  }

  it('keeps the global bio and the per-passage notes separate', () => {
    const doc = seeded()
    expect(doc.characters).toEqual([
      { ...emptyCharacter('Mira'), note: "The innkeeper's daughter" },
    ])
    expect(doc.nodes.find((n) => n.title === 'One')!.characters).toEqual([
      { name: 'Mira', note: 'Furious.' },
    ])
    expect(doc.nodes.find((n) => n.title === 'Two')!.characters).toEqual([
      { name: 'Mira', note: 'Quietly relieved.' },
    ])
  })

  it('refuses anyone who is not on the roster', () => {
    const doc = docFrom({ One: [] })
    const next = addPassageCharacter(doc, idOf(doc, 'One'), 'Nobody')
    expect(next).toBe(doc)
    expect(next.nodes[0]!.characters).toEqual([])
  })

  it('refuses a duplicate roster name', () => {
    const doc = createCharacter(docFrom({ One: [] }), 'Mira').doc
    const { doc: after, error } = createCharacter(doc, 'Mira')
    expect(error).toBe('A character named "Mira" already exists.')
    expect(after).toBe(doc)
  })

  it('cascades a rename into every passage', () => {
    const { doc, error } = renameCharacter(seeded(), 'Mira', 'Mirabel')
    expect(error).toBeNull()
    expect(doc.characters.map((c) => c.name)).toEqual(['Mirabel'])
    for (const n of doc.nodes) {
      expect(n.characters.map((c) => c.name)).toEqual(['Mirabel'])
    }
    // Per-passage notes survive the rename.
    expect(doc.nodes.find((n) => n.title === 'One')!.characters[0]!.note).toBe('Furious.')
  })

  it('refuses a rename that collides with another character', () => {
    const doc = createCharacter(seeded(), 'Tam').doc
    const { doc: after, error } = renameCharacter(doc, 'Mira', 'Tam')
    expect(error).toBe('A character named "Tam" already exists.')
    expect(after).toBe(doc)
  })

  it('removes a deleted character from the roster and every passage', () => {
    const doc = deleteCharacter(seeded(), 'Mira')
    expect(doc.characters).toEqual([])
    for (const n of doc.nodes) expect(n.characters).toEqual([])
  })
})

describe('roster order', () => {
  /** Leads first, then a walk-on added later — the shape the author chose. */
  function cast(...names: string[]): StoryDoc {
    let doc = docFrom({ One: [], Two: [] })
    for (const name of names) doc = createCharacter(doc, name).doc
    return doc
  }

  const names = (doc: StoryDoc) => doc.characters.map((c) => c.name)
  const orders = (doc: StoryDoc) => doc.characters.map((c) => c.order)

  it('appends a new character instead of alphabetizing them in', () => {
    const doc = cast('Mira', 'Tam', 'Bandit')
    expect(names(doc)).toEqual(['Mira', 'Tam', 'Bandit'])
    expect(orders(doc)).toEqual([0, 1, 2])
  })

  it('moves a character up and down', () => {
    const doc = cast('Mira', 'Tam', 'Bandit')
    expect(names(moveCharacter(doc, 'Bandit', -1))).toEqual(['Mira', 'Bandit', 'Tam'])
    expect(names(moveCharacter(doc, 'Mira', 1))).toEqual(['Tam', 'Mira', 'Bandit'])
    expect(orders(moveCharacter(doc, 'Bandit', -1))).toEqual([0, 1, 2])
  })

  it('leaves the document untouched at either end', () => {
    const doc = cast('Mira', 'Tam')
    expect(moveCharacter(doc, 'Mira', -1)).toBe(doc)
    expect(moveCharacter(doc, 'Tam', 1)).toBe(doc)
    expect(moveCharacter(doc, 'Nobody', 1)).toBe(doc)
  })

  it('keeps a renamed character in place', () => {
    const { doc } = renameCharacter(cast('Mira', 'Tam', 'Bandit'), 'Mira', 'Zeno')
    expect(names(doc)).toEqual(['Zeno', 'Tam', 'Bandit'])
  })

  it('closes the gap a deletion leaves', () => {
    const doc = deleteCharacter(cast('Mira', 'Tam', 'Bandit'), 'Tam')
    expect(names(doc)).toEqual(['Mira', 'Bandit'])
    expect(orders(doc)).toEqual([0, 1])
  })

  it('alphabetizes on request', () => {
    const doc = sortCharacters(cast('Mira', 'Tam', 'Bandit'))
    expect(names(doc)).toEqual(['Bandit', 'Mira', 'Tam'])
    expect(orders(doc)).toEqual([0, 1, 2])
  })

  it('lists the index in roster order, not by how often they are cast', () => {
    let doc = cast('Mira', 'Tam', 'Bandit')
    doc = addPassageCharacter(doc, idOf(doc, 'One'), 'Bandit')
    doc = addPassageCharacter(doc, idOf(doc, 'Two'), 'Bandit')
    doc = addPassageCharacter(doc, idOf(doc, 'One'), 'Tam')
    expect(characterUsage(doc).map((u) => [u.value, u.count])).toEqual([
      ['Mira', 0],
      ['Tam', 1],
      ['Bandit', 2],
    ])
  })

  it('survives a save and load', () => {
    const doc = moveCharacter(cast('Mira', 'Tam', 'Bandit'), 'Bandit', -2)
    expect(names(parseDoc(serializeDoc(doc)).doc)).toEqual(['Bandit', 'Mira', 'Tam'])
  })

  it('reads a save file that predates the order field in its written order', () => {
    const { doc } = parseDoc(
      JSON.stringify({
        storyTitle: 'Old',
        startNodeId: '1',
        characters: [{ name: 'Mira' }, { name: 'Bandit' }],
        nodes: [{ id: '1', title: 'One', body: '' }],
      }),
    )
    expect(names(doc)).toEqual(['Mira', 'Bandit'])
    expect(orders(doc)).toEqual([0, 1])
  })

  it('repairs duplicate and missing order values without dropping anyone', () => {
    const { doc } = parseDoc(
      JSON.stringify({
        storyTitle: 'Hand edited',
        startNodeId: '1',
        characters: [
          { name: 'Tam', order: 4 },
          { name: 'Mira', order: 4 },
          { name: 'Bandit', order: 'first' },
        ],
        nodes: [{ id: '1', title: 'One', body: '' }],
      }),
    )
    // Bandit's junk order falls back to its position in the file, which is 2.
    expect(names(doc)).toEqual(['Bandit', 'Mira', 'Tam'])
    expect(orders(doc)).toEqual([0, 1, 2])
  })
})

describe('aggregation', () => {
  it('counts settings, skipping passages with none', () => {
    const doc = docFrom(
      { A: [], B: [], C: [], D: [] },
      { settings: { A: 'Tavern', B: 'Tavern', C: 'Docks' } },
    )
    expect(settingUsage(doc)).toEqual([
      { value: 'Tavern', count: 2, nodeIds: ['1', '2'] },
      { value: 'Docks', count: 1, nodeIds: ['3'] },
    ])
  })

  it('counts characters and keeps unused roster members visible at zero', () => {
    let doc = docFrom({ A: [], B: [] })
    doc = createCharacter(doc, 'Mira').doc
    doc = createCharacter(doc, 'Tam').doc
    doc = createCharacter(doc, 'Unseen').doc
    doc = addPassageCharacter(doc, idOf(doc, 'A'), 'Mira')
    doc = addPassageCharacter(doc, idOf(doc, 'B'), 'Mira')
    doc = addPassageCharacter(doc, idOf(doc, 'B'), 'Tam')

    expect(characterUsage(doc)).toEqual([
      { value: 'Mira', count: 2, nodeIds: ['1', '2'] },
      { value: 'Tam', count: 1, nodeIds: ['2'] },
      { value: 'Unseen', count: 0, nodeIds: [] },
    ])
  })

  it('orders ties by name, so the index never reshuffles', () => {
    const doc = docFrom(
      { A: [], B: [], C: [] },
      { settings: { A: 'Zed', B: 'Alpha', C: 'Mid' } },
    )
    expect(settingUsage(doc).map((u) => u.value)).toEqual(['Alpha', 'Mid', 'Zed'])
    for (let i = 0; i < 4; i++) {
      const shuffledDoc = { ...doc, nodes: shuffled(doc.nodes, i + 3) }
      expect(settingUsage(shuffledDoc).map((u) => u.value)).toEqual(['Alpha', 'Mid', 'Zed'])
    }
  })

  it('renames a setting across every passage using it', () => {
    const doc = renameSetting(
      docFrom({ A: [], B: [], C: [] }, { settings: { A: 'Taven', B: 'Taven', C: 'Docks' } }),
      'Taven',
      'Tavern',
    )
    expect(settingUsage(doc)).toEqual([
      { value: 'Tavern', count: 2, nodeIds: ['1', '2'] },
      { value: 'Docks', count: 1, nodeIds: ['3'] },
    ])
  })
})

describe('the save file', () => {
  function populated() {
    let doc = docFrom({ One: ['Two'], Two: [] }, { settings: { One: 'Tavern' } })
    doc = createCharacter(doc, 'Mira').doc
    doc = setCharacterBio(doc, 'Mira', 'The daughter')
    doc = createCharacter(doc, 'Tam').doc
    doc = addPassageCharacter(doc, idOf(doc, 'One'), 'Mira')
    doc = addPassageCharacter(doc, idOf(doc, 'One'), 'Tam')
    doc = setPassageCharacterNote(doc, idOf(doc, 'One'), 'Mira', 'Furious.')
    return doc
  }

  it('round-trips both fields', () => {
    const doc = populated()
    const canonical = { ...doc, nodes: [...doc.nodes].sort(compareNodes) }
    expect(parseDoc(serializeDoc(doc)).doc).toEqual(canonical)
  })

  it('serializes byte-identically however the arrays are ordered', () => {
    const doc = populated()
    const base = serializeDoc(doc)

    for (let i = 0; i < 4; i++) {
      const jumbled: StoryDoc = {
        ...doc,
        nodes: shuffled(doc.nodes, i + 11).map((n) => ({
          ...n,
          characters: shuffled(n.characters, i + 5),
        })),
        characters: shuffled(doc.characters, i + 2),
      }
      expect(serializeDoc(jumbled)).toBe(base)
    }
  })

  it('loads a save file that predates these fields', () => {
    const { doc } = parseDoc(
      JSON.stringify({
        storyTitle: 'Old',
        startNodeId: '1',
        nodes: [{ id: '1', title: 'One', body: '', tags: [], state: 'TODO', levelOffset: 0 }],
      }),
    )
    expect(doc.nodes[0]!.setting).toBe('')
    expect(doc.nodes[0]!.characters).toEqual([])
    expect(doc.characters).toEqual([])
  })

  it('adopts an off-roster character rather than discarding the casting', () => {
    const { doc, warnings } = parseDoc(
      JSON.stringify({
        storyTitle: 'Hand edited',
        startNodeId: '1',
        characters: [{ name: 'Tam', note: '' }],
        nodes: [
          {
            id: '1',
            title: 'One',
            body: '',
            characters: [{ name: 'Mira', note: 'Furious.' }, 'Bare String'],
          },
        ],
      }),
    )
    // The file's own roster keeps its order; the adopted pair follows it.
    expect(doc.characters.map((c) => c.name)).toEqual(['Tam', 'Bare String', 'Mira'])
    expect(doc.nodes[0]!.characters).toEqual([
      { name: 'Bare String', note: '' },
      { name: 'Mira', note: 'Furious.' },
    ])
    expect(warnings.join(' ')).toContain('"Mira"')
  })
})

describe('through the store', () => {
  beforeEach(() => {
    store.newStory('Scene Test')
    store.clearFilters()
  })

  const id = (title: string) => idOf(store.state.doc, title)

  it('does not relayout when scene metadata changes', () => {
    store.editBody(id('Start'), '[[Go|Two]]')
    const before = store.layout.value.stats.hash

    store.settingSet(id('Start'), 'Tavern')
    store.characterCreate('Mira')
    store.castAdd(id('Start'), 'Mira')
    store.castSetNote(id('Start'), 'Mira', 'Furious.')

    expect(store.layout.value.stats.hash).toBe(before)
  })

  it('undoes a reorder, and records no step for a move off the end', () => {
    store.characterCreate('Mira')
    store.characterCreate('Bandit')
    store.characterMove('Bandit', -1)
    expect(store.state.doc.characters.map((c) => c.name)).toEqual(['Bandit', 'Mira'])

    // Already at the top: nothing to commit, so undo must still reach the move.
    store.characterMove('Bandit', -1)
    store.undo()
    expect(store.state.doc.characters.map((c) => c.name)).toEqual(['Mira', 'Bandit'])
  })

  it('restores a per-passage note on undo', () => {
    store.characterCreate('Mira')
    store.castAdd(id('Start'), 'Mira')
    store.castSetNote(id('Start'), 'Mira', 'Calm.')
    store.castSetNote(id('Start'), 'Mira', 'Furious.')

    store.undo()

    // The clone() regression: a shallow copy would have rewritten the past too.
    expect(store.selected.value).toBeTruthy()
    expect(store.state.doc.nodes.find((n) => n.title === 'Start')!.characters).toEqual([
      { name: 'Mira', note: 'Calm.' },
    ])
  })

  it('undoes a character deletion, notes and all', () => {
    store.characterCreate('Mira')
    store.castAdd(id('Start'), 'Mira')
    store.castSetNote(id('Start'), 'Mira', 'Furious.')

    store.characterDelete('Mira')
    expect(store.state.doc.characters).toEqual([])

    store.undo()
    expect(store.state.doc.characters).toEqual([emptyCharacter('Mira')])
    expect(store.state.doc.nodes.find((n) => n.title === 'Start')!.characters).toEqual([
      { name: 'Mira', note: 'Furious.' },
    ])
  })

  it('creates a character and casts them in one undo step', () => {
    const before = serializeDoc(store.state.doc)
    expect(store.castCreateAndAdd(id('Start'), 'Mira')).toBeNull()
    expect(store.state.doc.characters.map((c) => c.name)).toEqual(['Mira'])
    expect(store.state.doc.nodes.find((n) => n.title === 'Start')!.characters).toHaveLength(1)

    store.undo()
    expect(serializeDoc(store.state.doc)).toBe(before)
  })

  it('filters by setting and character alongside the existing filters', () => {
    store.editBody(id('Start'), '[[Go|Two]]\n[[Stay|Three]]')
    store.settingSet(id('Two'), 'Tavern')
    store.settingSet(id('Three'), 'Docks')
    store.characterCreate('Mira')
    store.castAdd(id('Two'), 'Mira')
    store.changeState(id('Two'), 'Done')

    store.toggleFilter('settingFilter', 'Tavern')
    expect([...store.matches.value!]).toEqual([id('Two')])

    store.toggleFilter('characterFilter', 'Mira')
    expect([...store.matches.value!]).toEqual([id('Two')])

    // Composes with state: Three is in neither the Tavern nor Done.
    store.state.stateFilter = ['TODO']
    expect(store.matches.value!.size).toBe(0)

    store.clearFilters()
    expect(store.matches.value).toBeNull()
  })

  it('finds a character’s scenes by name through the search box', () => {
    store.editBody(id('Start'), '[[Go|Two]]')
    store.characterCreate('Mirabel')
    store.castAdd(id('Two'), 'Mirabel')

    store.state.search = 'mirabel'
    expect([...store.matches.value!]).toEqual([id('Two')])
  })

  it('keeps an active filter pointing at a renamed character', () => {
    store.characterCreate('Mira')
    store.castAdd(id('Start'), 'Mira')
    store.toggleFilter('characterFilter', 'Mira')

    expect(store.characterRename('Mira', 'Mirabel')).toBeNull()
    expect(store.state.characterFilter).toEqual(['Mirabel'])
    expect([...store.matches.value!]).toEqual([id('Start')])
  })
})
