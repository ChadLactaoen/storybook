import { beforeEach, describe, expect, it } from 'vitest'
import {
  addPassageCharacter,
  addRelation,
  createCharacter,
  deleteCharacter,
  relationsToward,
  removeRelation,
  renameCharacter,
  setCharacterBio,
  setCharacterTrait,
  setRelationPoints,
} from '../lib/doc/mutations'
import { parseDoc, serializeDoc } from '../lib/doc/serialize'
import * as store from '../stores/story'
import type { StoryDoc } from '../types/story'
import { compareNodes, emptyCharacter } from '../types/story'
import { docFrom, shuffled } from './helpers'

/** Mira and Tam on the roster, both cast into passage One. */
function cast(): StoryDoc {
  let doc = docFrom({ One: ['Two'], Two: [] })
  doc = createCharacter(doc, 'Mira').doc
  doc = createCharacter(doc, 'Tam').doc
  const one = doc.nodes.find((n) => n.title === 'One')!.id
  doc = addPassageCharacter(doc, one, 'Mira')
  doc = addPassageCharacter(doc, one, 'Tam')
  return doc
}

function entry(doc: StoryDoc, name: string) {
  return doc.characters.find((c) => c.name === name)!
}

describe('trait lists', () => {
  it('stores points in the author’s order, not sorted', () => {
    const doc = setCharacterTrait(cast(), 'Mira', 'personality', ['Zebra', 'Apple', 'Mango'])
    expect(entry(doc, 'Mira').personality).toEqual(['Zebra', 'Apple', 'Mango'])
  })

  it('trims points and drops blanks', () => {
    const doc = setCharacterTrait(cast(), 'Mira', 'dialogue', ['  Clipped  ', '', '   ', 'Dry'])
    expect(entry(doc, 'Mira').dialogue).toEqual(['Clipped', 'Dry'])
  })

  it('keeps the three lists independent', () => {
    let doc = cast()
    doc = setCharacterTrait(doc, 'Mira', 'personality', ['Guarded'])
    doc = setCharacterTrait(doc, 'Mira', 'mannerisms', ['Wipes glasses'])
    const mira = entry(doc, 'Mira')
    expect(mira.personality).toEqual(['Guarded'])
    expect(mira.mannerisms).toEqual(['Wipes glasses'])
    expect(mira.dialogue).toEqual([])
  })

  it('ignores a character who is not on the roster', () => {
    const doc = cast()
    expect(setCharacterTrait(doc, 'Nobody', 'personality', ['x'])).toBe(doc)
  })
})

describe('relations', () => {
  it('is one-directional: Mira→Tam says nothing about Tam→Mira', () => {
    let doc = cast()
    doc = addRelation(doc, 'Mira', 'Tam').doc
    doc = setRelationPoints(doc, 'Mira', 'Tam', ['Owes him nothing'])

    expect(entry(doc, 'Mira').relations).toEqual([
      { to: 'Tam', points: ['Owes him nothing'] },
    ])
    expect(entry(doc, 'Tam').relations).toEqual([])
  })

  it('refuses a self-relation', () => {
    const doc = cast()
    const { doc: after, error } = addRelation(doc, 'Mira', 'Mira')
    expect(error).toBe('A character cannot have a relation to themselves.')
    expect(after).toBe(doc)
  })

  it('refuses a duplicate target', () => {
    const doc = addRelation(cast(), 'Mira', 'Tam').doc
    const { doc: after, error } = addRelation(doc, 'Mira', 'Tam')
    expect(error).toBe('Mira already has a relation to Tam.')
    expect(after).toBe(doc)
  })

  it('refuses a target who is not on the roster', () => {
    const doc = cast()
    const { doc: after, error } = addRelation(doc, 'Mira', 'Nobody')
    expect(error).toBe('There is no character named "Nobody".')
    expect(after).toBe(doc)
  })

  it('removes a relation without touching the other direction', () => {
    let doc = cast()
    doc = addRelation(doc, 'Mira', 'Tam').doc
    doc = setRelationPoints(doc, 'Mira', 'Tam', ['Owes him nothing'])
    doc = addRelation(doc, 'Tam', 'Mira').doc
    doc = setRelationPoints(doc, 'Tam', 'Mira', ['Afraid of her'])

    doc = removeRelation(doc, 'Mira', 'Tam')
    expect(entry(doc, 'Mira').relations).toEqual([])
    expect(entry(doc, 'Tam').relations).toEqual([{ to: 'Mira', points: ['Afraid of her'] }])
  })
})

describe('relationsToward', () => {
  it('reports only inbound relations, never the outbound ones', () => {
    let doc = cast()
    doc = addRelation(doc, 'Mira', 'Tam').doc
    doc = setRelationPoints(doc, 'Mira', 'Tam', ['Owes him nothing'])
    doc = addRelation(doc, 'Tam', 'Mira').doc
    doc = setRelationPoints(doc, 'Tam', 'Mira', ['Afraid of her'])

    expect(relationsToward(doc, 'Tam')).toEqual([
      { from: 'Mira', points: ['Owes him nothing'] },
    ])
    expect(relationsToward(doc, 'Mira')).toEqual([{ from: 'Tam', points: ['Afraid of her'] }])
  })

  it('skips a relation that has no points written yet', () => {
    const doc = addRelation(cast(), 'Mira', 'Tam').doc
    expect(relationsToward(doc, 'Tam')).toEqual([])
  })
})

describe('cascades', () => {
  it('retargets relations when a character is renamed', () => {
    let doc = cast()
    doc = addRelation(doc, 'Mira', 'Tam').doc
    doc = setRelationPoints(doc, 'Mira', 'Tam', ['Owes him nothing'])

    const { doc: renamed, error } = renameCharacter(doc, 'Tam', 'Tamsin')
    expect(error).toBeNull()
    expect(entry(renamed, 'Mira').relations).toEqual([
      { to: 'Tamsin', points: ['Owes him nothing'] },
    ])
  })

  it('keeps the renamed character’s own relations intact', () => {
    let doc = cast()
    doc = addRelation(doc, 'Mira', 'Tam').doc
    doc = setRelationPoints(doc, 'Mira', 'Tam', ['Owes him nothing'])

    const renamed = renameCharacter(doc, 'Mira', 'Mirabel').doc
    expect(entry(renamed, 'Mirabel').relations).toEqual([
      { to: 'Tam', points: ['Owes him nothing'] },
    ])
  })

  it('cannot produce a duplicate or self-directed relation via rename', () => {
    let doc = createCharacter(cast(), 'Wren').doc
    doc = addRelation(doc, 'Mira', 'Tam').doc
    doc = setRelationPoints(doc, 'Mira', 'Tam', ['Owes him nothing'])
    doc = addRelation(doc, 'Mira', 'Wren').doc
    doc = setRelationPoints(doc, 'Mira', 'Wren', ['Trusts her'])

    // Renaming onto an existing roster name is refused before any retargeting
    // happens, which is precisely why the retarget needs no merge step.
    expect(renameCharacter(doc, 'Wren', 'Tam').error).toBe(
      'A character named "Tam" already exists.',
    )
    expect(renameCharacter(doc, 'Tam', 'Mira').error).toBe(
      'A character named "Mira" already exists.',
    )

    // A rename to a free name retargets cleanly, leaving both relations distinct.
    const renamed = renameCharacter(doc, 'Tam', 'Tamsin').doc
    expect(entry(renamed, 'Mira').relations).toEqual([
      { to: 'Tamsin', points: ['Owes him nothing'] },
      { to: 'Wren', points: ['Trusts her'] },
    ])
  })

  it('drops inbound relations when a character is deleted', () => {
    let doc = cast()
    doc = addRelation(doc, 'Mira', 'Tam').doc
    doc = setRelationPoints(doc, 'Mira', 'Tam', ['Owes him nothing'])

    const deleted = deleteCharacter(doc, 'Tam')
    expect(deleted.characters.map((c) => c.name)).toEqual(['Mira'])
    expect(entry(deleted, 'Mira').relations).toEqual([])
  })
})

describe('the save file', () => {
  function populated() {
    let doc = cast()
    doc = setCharacterBio(doc, 'Mira', 'The innkeeper’s daughter.')
    doc = setCharacterTrait(doc, 'Mira', 'personality', ['Zebra', 'Apple'])
    doc = setCharacterTrait(doc, 'Mira', 'dialogue', ['Clipped'])
    doc = setCharacterTrait(doc, 'Mira', 'mannerisms', ['Wipes glasses'])
    doc = addRelation(doc, 'Mira', 'Tam').doc
    doc = setRelationPoints(doc, 'Mira', 'Tam', ['Owes him nothing', 'Avoids his eye'])
    return doc
  }

  it('round-trips a full profile', () => {
    const doc = populated()
    const canonical = { ...doc, nodes: [...doc.nodes].sort(compareNodes) }
    expect(parseDoc(serializeDoc(doc)).doc).toEqual(canonical)
  })

  it('preserves point order through a save and load', () => {
    const reloaded = parseDoc(serializeDoc(populated())).doc
    // Sorting these would be the easy mistake; the order is the content.
    expect(entry(reloaded, 'Mira').personality).toEqual(['Zebra', 'Apple'])
    expect(entry(reloaded, 'Mira').relations[0]!.points).toEqual([
      'Owes him nothing',
      'Avoids his eye',
    ])
  })

  it('serializes byte-identically however the roster is ordered', () => {
    const doc = populated()
    const base = serializeDoc(doc)
    for (let i = 0; i < 4; i++) {
      expect(serializeDoc({ ...doc, characters: shuffled(doc.characters, i + 13) })).toBe(base)
    }
  })

  it('loads a save file that predates the profile fields', () => {
    const { doc } = parseDoc(
      JSON.stringify({
        storyTitle: 'Old',
        startNodeId: '1',
        characters: [{ name: 'Mira', note: 'The daughter.' }],
        nodes: [{ id: '1', title: 'One', body: '' }],
      }),
    )
    expect(doc.characters).toEqual([{ ...emptyCharacter('Mira'), note: 'The daughter.' }])
  })

  it('adopts a relation target missing from the roster', () => {
    const { doc, warnings } = parseDoc(
      JSON.stringify({
        storyTitle: 'Hand edited',
        startNodeId: '1',
        characters: [
          { name: 'Mira', note: '', relations: [{ to: 'Ghost', points: ['Never speaks of him'] }] },
        ],
        nodes: [{ id: '1', title: 'One', body: '' }],
      }),
    )
    // Adopted at the end of the roster, not alphabetized into the middle of it.
    expect(doc.characters.map((c) => c.name)).toEqual(['Mira', 'Ghost'])
    expect(entry(doc, 'Mira').relations).toEqual([
      { to: 'Ghost', points: ['Never speaks of him'] },
    ])
    expect(warnings.join(' ')).toContain('"Ghost"')
  })

  it('repairs junk in a hand-edited profile', () => {
    const { doc } = parseDoc(
      JSON.stringify({
        storyTitle: 'Hand edited',
        startNodeId: '1',
        characters: [
          {
            name: 'Mira',
            personality: ['  Guarded  ', 42, '', null, 'Dry'],
            relations: [
              { to: 'Mira', points: ['self'] },
              { to: '  ', points: [] },
            ],
          },
        ],
        nodes: [{ id: '1', title: 'One', body: '' }],
      }),
    )
    expect(entry(doc, 'Mira').personality).toEqual(['Guarded', 'Dry'])
    // A self-relation and a nameless target are meaningless; both dropped.
    expect(entry(doc, 'Mira').relations).toEqual([])
  })
})

describe('through the store', () => {
  beforeEach(() => {
    store.newStory('Profile Test')
    store.closeCharacterSheet()
    store.characterCreate('Mira')
    store.characterCreate('Tam')
  })

  it('restores a trait point on undo', () => {
    store.characterSetTrait('Mira', 'personality', ['Guarded'])
    store.characterSetTrait('Mira', 'personality', ['Guarded', 'Dry humour'])

    store.undo()

    // The clone() regression: a shallow copy of the roster entry would have
    // rewritten the earlier document's array too.
    expect(store.characterMap.value.get('Mira')!.personality).toEqual(['Guarded'])
  })

  it('restores relation points on undo', () => {
    store.relationAdd('Mira', 'Tam')
    store.relationSetPoints('Mira', 'Tam', ['Owes him nothing'])
    store.relationSetPoints('Mira', 'Tam', ['Owes him nothing', 'Avoids his eye'])

    store.undo()
    expect(store.characterMap.value.get('Mira')!.relations[0]!.points).toEqual([
      'Owes him nothing',
    ])
  })

  it('undoes a deletion with the inbound relation and its points', () => {
    store.relationAdd('Mira', 'Tam')
    store.relationSetPoints('Mira', 'Tam', ['Owes him nothing'])

    store.characterDelete('Tam')
    expect(store.characterMap.value.get('Mira')!.relations).toEqual([])

    store.undo()
    expect(store.characterMap.value.get('Mira')!.relations).toEqual([
      { to: 'Tam', points: ['Owes him nothing'] },
    ])
  })

  it('does not relayout when a profile changes', () => {
    const before = store.layout.value.stats.hash
    store.characterSetTrait('Mira', 'personality', ['Guarded'])
    store.relationAdd('Mira', 'Tam')
    store.relationSetPoints('Mira', 'Tam', ['Owes him nothing'])
    expect(store.layout.value.stats.hash).toBe(before)
  })

  it('keeps an open sheet pointing at a renamed character', () => {
    store.openCharacterSheet('Tam')
    expect(store.characterRename('Tam', 'Tamsin')).toBeNull()
    expect(store.state.openCharacter).toBe('Tamsin')
  })

  it('closes the sheet when its character is deleted', () => {
    store.openCharacterSheet('Tam')
    store.characterDelete('Tam')
    expect(store.state.openCharacter).toBeNull()
  })
})
