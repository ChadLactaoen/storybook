import { beforeEach, describe, expect, it } from 'vitest'
import {
  addPassageCharacter,
  characterUsage,
  createCharacter,
  createNode,
  deleteCharacter,
  inheritedCast,
  inheritedSetting,
  moveCharacter,
  materializePhantom,
  renameCharacter,
  removePassageCharacter,
  renameSetting,
  resolveLinks,
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
import { castInRosterOrder, compareNodes, emptyCharacter, emptyDoc } from '../types/story'
import { docFrom, shuffled } from './helpers'

function idOf(doc: StoryDoc, title: string): string {
  const n = doc.nodes.find((x) => x.title === title)
  if (!n) throw new Error(`no passage titled ${title}`)
  return n.id
}

/** What the editor does: type into the body, then leave the field. */
function writeBody(nodeId: string, body: string): void {
  const before = store.state.doc.nodes.find((n) => n.id === nodeId)!.body
  store.editBody(nodeId, body)
  store.resolveBody(nodeId, before)
}

function settingOf(doc: StoryDoc, title: string): string {
  return doc.nodes.find((n) => n.title === title)!.setting
}

/** Inheritance is opt-in, so most of these have to ask for it. */
const INHERIT_SETTING = { setting: true }

describe('setting inheritance', () => {
  it('inherits nothing unless asked', () => {
    let doc = createNode(emptyDoc(), { title: 'Tavern Door' }).doc
    const id = doc.nodes[0]!.id
    doc = setSetting(doc, id, 'The Rusty Anchor')
    doc = resolveLinks(setBody(doc, id, '[[Common Room]]'), id, '')

    expect(settingOf(doc, 'Common Room')).toBe('')
  })

  it('gives a passage created by a new link its parent’s setting', () => {
    let doc = createNode(emptyDoc(), { title: 'Tavern Door' }).doc
    const id = doc.nodes[0]!.id
    doc = setSetting(doc, id, 'The Rusty Anchor')
    doc = resolveLinks(setBody(doc, id, '[[Common Room]]'), id, '', INHERIT_SETTING)

    expect(settingOf(doc, 'Common Room')).toBe('The Rusty Anchor')
  })

  it('lets the child override without the parent clawing it back', () => {
    let doc = createNode(emptyDoc(), { title: 'Tavern Door' }).doc
    const parent = doc.nodes[0]!.id
    doc = setSetting(doc, parent, 'The Rusty Anchor')
    doc = resolveLinks(setBody(doc, parent, '[[Common Room]]'), parent, '', INHERIT_SETTING)
    const bound = doc.nodes.find((n) => n.id === parent)!.body

    doc = setSetting(doc, idOf(doc, 'Common Room'), 'The Cellar')
    // Editing the parent again must not re-inherit onto an existing passage.
    doc = resolveLinks(
      setBody(doc, parent, `More prose.\n${bound}`),
      parent,
      bound,
      INHERIT_SETTING,
    )

    expect(settingOf(doc, 'Common Room')).toBe('The Cellar')
  })

  it('inherits into a phantom only when every parent agrees', () => {
    const agreeing = docFrom(
      { North: ['Cave'], South: ['Cave'] },
      { settings: { North: 'The Moors', South: 'The Moors' } },
    )
    expect(inheritedSetting(agreeing, 'Cave')).toBe('The Moors')
    expect(settingOf(materializePhantom(agreeing, 'Cave', null, INHERIT_SETTING), 'Cave')).toBe(
      'The Moors',
    )
    // ...and not at all with the preference off.
    expect(settingOf(materializePhantom(agreeing, 'Cave'), 'Cave')).toBe('')

    const disagreeing = docFrom(
      { North: ['Cave'], South: ['Cave'] },
      { settings: { North: 'The Moors', South: 'The Docks' } },
    )
    // Two parents in different places: guessing one would plant wrong metadata.
    expect(inheritedSetting(disagreeing, 'Cave')).toBe('')
    expect(settingOf(materializePhantom(disagreeing, 'Cave', null, INHERIT_SETTING), 'Cave')).toBe(
      '',
    )
  })

  it('leaves a passage created with no parent blank', () => {
    const doc = createNode(docFrom({ A: [] }, { settings: { A: 'Somewhere' } })).doc
    expect(doc.nodes.find((n) => n.title === 'Untitled Passage')!.setting).toBe('')
  })
})

describe('cast inheritance', () => {
  const INHERIT_CAST = { characters: true }

  const castOf = (doc: StoryDoc, title: string) =>
    doc.nodes.find((n) => n.title === title)!.characters

  const namesOf = (doc: StoryDoc, title: string) => castOf(doc, title).map((c) => c.name)

  /** One passage with Mira and Tam in it, each carrying a scene note. */
  function peopled(): StoryDoc {
    let doc = createNode(emptyDoc(), { title: 'Tavern Door' }).doc
    const id = doc.nodes[0]!.id
    doc = createCharacter(doc, 'Mira').doc
    doc = createCharacter(doc, 'Tam').doc
    doc = addPassageCharacter(doc, id, 'Mira')
    doc = addPassageCharacter(doc, id, 'Tam')
    doc = setPassageCharacterNote(doc, id, 'Mira', 'Furious.')
    return doc
  }

  it('inherits nothing unless asked', () => {
    const doc = peopled()
    const id = doc.nodes[0]!.id
    const next = resolveLinks(setBody(doc, id, '[[Common Room]]'), id, '')

    expect(castOf(next, 'Common Room')).toEqual([])
  })

  it('carries the parent’s cast onto a passage created by a new link', () => {
    const doc = peopled()
    const id = doc.nodes[0]!.id
    const next = resolveLinks(setBody(doc, id, '[[Common Room]]'), id, '', INHERIT_CAST)

    expect(namesOf(next, 'Common Room')).toEqual(['Mira', 'Tam'])
  })

  it('never carries a scene note forward', () => {
    const doc = peopled()
    const id = doc.nodes[0]!.id
    const next = resolveLinks(setBody(doc, id, '[[Common Room]]'), id, '', INHERIT_CAST)

    // "Furious." is direction for the tavern door, not for wherever they go next.
    expect(castOf(next, 'Common Room')).toEqual([
      { name: 'Mira', note: '' },
      { name: 'Tam', note: '' },
    ])
    expect(castOf(next, 'Tavern Door').find((c) => c.name === 'Mira')!.note).toBe('Furious.')
  })

  it('gives the child its own objects, so neither can rewrite the other', () => {
    const doc = peopled()
    const id = doc.nodes[0]!.id
    let next = resolveLinks(setBody(doc, id, '[[Common Room]]'), id, '', INHERIT_CAST)
    const child = idOf(next, 'Common Room')

    next = setPassageCharacterNote(next, child, 'Mira', 'Calmer now.')

    // The clone() aliasing failure: a shared object would have moved both.
    expect(castOf(next, 'Tavern Door').find((c) => c.name === 'Mira')!.note).toBe('Furious.')
    expect(castOf(next, 'Common Room').find((c) => c.name === 'Mira')!.note).toBe('Calmer now.')
  })

  it('lets the child override without the parent clawing it back', () => {
    const doc = peopled()
    const parent = doc.nodes[0]!.id
    let next = resolveLinks(setBody(doc, parent, '[[Common Room]]'), parent, '', INHERIT_CAST)
    const bound = next.nodes.find((n) => n.id === parent)!.body

    next = removePassageCharacter(next, idOf(next, 'Common Room'), 'Tam')
    next = resolveLinks(
      setBody(next, parent, `More prose.\n${bound}`),
      parent,
      bound,
      INHERIT_CAST,
    )

    expect(namesOf(next, 'Common Room')).toEqual(['Mira'])
  })

  it('stores an inherited cast in name order, not roster order', () => {
    let doc = docFrom({ One: [] })
    for (const name of ['Zeno', 'Mira', 'Bandit']) doc = createCharacter(doc, name).doc
    const id = idOf(doc, 'One')
    for (const name of ['Zeno', 'Mira', 'Bandit']) doc = addPassageCharacter(doc, id, name)

    const next = resolveLinks(setBody(doc, id, '[[Two]]'), id, '', INHERIT_CAST)
    expect(namesOf(next, 'Two')).toEqual(['Bandit', 'Mira', 'Zeno'])
  })

  it('drops a name the roster does not have', () => {
    // A hand-edited document can hold one; the invariant says a new passage
    // must not spread it any further.
    const doc = docFrom({ One: ['Cave'] }, { casts: { One: ['Mira'] } })
    const stray: StoryDoc = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.title === 'One' ? { ...n, characters: [...n.characters, { name: 'Ghost', note: '' }] } : n,
      ),
    }
    const id = idOf(stray, 'One')

    // The query still reports what the parents say; `createNode` is what refuses
    // to write an off-roster name onto a new passage.
    expect(inheritedCast(stray, 'Cave')).toEqual(['Ghost', 'Mira'])
    expect(namesOf(materializePhantom(stray, 'Cave', null, INHERIT_CAST), 'Cave')).toEqual(['Mira'])
    expect(namesOf(resolveLinks(setBody(stray, id, '[[Cellar]]'), id, '', INHERIT_CAST), 'Cellar'))
      .toEqual(['Mira'])
  })

  it('gives every passage one blur creates the same cast', () => {
    const doc = peopled()
    const id = doc.nodes[0]!.id
    const next = resolveLinks(setBody(doc, id, '[[Cellar]]\n[[Yard]]'), id, '', INHERIT_CAST)

    expect(namesOf(next, 'Cellar')).toEqual(['Mira', 'Tam'])
    expect(namesOf(next, 'Yard')).toEqual(['Mira', 'Tam'])
  })

  it('inherits into a phantom only when every parent agrees', () => {
    const agreeing = docFrom(
      { North: ['Cave'], South: ['Cave'] },
      { casts: { North: ['Mira', 'Tam'], South: ['Tam', 'Mira'] } },
    )
    expect(inheritedCast(agreeing, 'Cave')).toEqual(['Mira', 'Tam'])
    expect(namesOf(materializePhantom(agreeing, 'Cave', null, INHERIT_CAST), 'Cave')).toEqual([
      'Mira',
      'Tam',
    ])
    // ...and not at all with the preference off.
    expect(namesOf(materializePhantom(agreeing, 'Cave'), 'Cave')).toEqual([])

    const disagreeing = docFrom(
      { North: ['Cave'], South: ['Cave'] },
      { casts: { North: ['Mira', 'Tam'], South: ['Mira'] } },
    )
    expect(inheritedCast(disagreeing, 'Cave')).toEqual([])
    expect(namesOf(materializePhantom(disagreeing, 'Cave', null, INHERIT_CAST), 'Cave')).toEqual([])
  })

  it('counts an empty parent as a disagreement, the way a blank setting does', () => {
    const doc = docFrom({ North: ['Cave'], South: ['Cave'] }, { casts: { North: ['Mira'] } })
    expect(inheritedCast(doc, 'Cave')).toEqual([])
  })

  it('leaves a passage created with no parent empty', () => {
    expect(inheritedCast(docFrom({ A: [] }, { casts: { A: ['Mira'] } }), 'Nowhere')).toEqual([])
  })

  it('is independent of the setting preference', () => {
    let doc = peopled()
    const id = doc.nodes[0]!.id
    doc = setSetting(doc, id, 'The Rusty Anchor')

    const castOnly = resolveLinks(setBody(doc, id, '[[Cellar]]'), id, '', INHERIT_CAST)
    expect(settingOf(castOnly, 'Cellar')).toBe('')
    expect(namesOf(castOnly, 'Cellar')).toEqual(['Mira', 'Tam'])

    const settingOnly = resolveLinks(setBody(doc, id, '[[Cellar]]'), id, '', { setting: true })
    expect(settingOf(settingOnly, 'Cellar')).toBe('The Rusty Anchor')
    expect(namesOf(settingOnly, 'Cellar')).toEqual([])
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

  describe('a passage cast on screen', () => {
    /** Three names whose alphabet runs backwards against the roster. */
    function scene(doc: StoryDoc): StoryDoc {
      const id = idOf(doc, 'One')
      let next = doc
      for (const c of next.characters) next = addPassageCharacter(next, id, c.name)
      return next
    }

    const shown = (doc: StoryDoc) =>
      castInRosterOrder(doc.nodes.find((n) => n.title === 'One')!.characters, doc.characters).map(
        (c) => c.name,
      )

    it('follows the roster, not the alphabet', () => {
      const doc = scene(cast('Zeno', 'Mira', 'Bandit'))
      // Stored alphabetically, which is exactly what must not reach the screen.
      expect(doc.nodes.find((n) => n.title === 'One')!.characters.map((c) => c.name)).toEqual([
        'Bandit',
        'Mira',
        'Zeno',
      ])
      expect(shown(doc)).toEqual(['Zeno', 'Mira', 'Bandit'])
    })

    it('re-orders when the roster moves, with the passage untouched', () => {
      const doc = scene(cast('Zeno', 'Mira', 'Bandit'))
      const moved = moveCharacter(doc, 'Bandit', -2)
      expect(shown(moved)).toEqual(['Bandit', 'Zeno', 'Mira'])
      // The document's own cast array never changed; only the view did.
      expect(moved.nodes.find((n) => n.title === 'One')!.characters).toEqual(
        doc.nodes.find((n) => n.title === 'One')!.characters,
      )
    })

    it('agrees with the alphabet once the roster is sorted A-Z', () => {
      const doc = sortCharacters(scene(cast('Zeno', 'Mira', 'Bandit')))
      expect(shown(doc)).toEqual(['Bandit', 'Mira', 'Zeno'])
    })

    it('leaves the array it was handed alone', () => {
      const doc = scene(cast('Zeno', 'Mira', 'Bandit'))
      const stored = doc.nodes.find((n) => n.title === 'One')!.characters
      const before = [...stored]
      castInRosterOrder(stored, doc.characters)
      expect(stored).toEqual(before)
    })

    it('sorts anyone off the roster last rather than dropping them', () => {
      const doc = cast('Zeno', 'Mira')
      const strays = [{ name: 'Ghost', note: '' }, { name: 'Mira', note: '' }]
      expect(castInRosterOrder(strays, doc.characters).map((c) => c.name)).toEqual(['Mira', 'Ghost'])
    })
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
    writeBody(id('Start'), '[[Two]]')
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
    writeBody(id('Start'), '[[Two]]\n[[Three]]')
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
    writeBody(id('Start'), '[[Two]]')
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
