import { describe, expect, it } from 'vitest'
import { linkSyntaxIn, parseLinks, retargetLinks } from '../lib/harlowe/links'
import {
  addTag,
  createNode,
  deleteNode,
  deleteTag,
  deleteNodes,
  recodeAll,
  removeTag,
  renameNode,
  resolveLinks,
  setBody,
  setCode,
  setEnding,
  setEndingMany,
  setLevelOffset,
  setLevelOffsetMany,
  setState,
  setStateMany,
  setStoryNotes,
  setTagColor,
  setNote,
  setSlug,
  SLUG_MAX,
} from '../lib/doc/mutations'
import * as M from '../lib/doc/mutations'
import { parseDoc, serializeDoc } from '../lib/doc/serialize'
import { deriveGraph } from '../lib/graph/derive'
import { compareNodes, emptyDoc } from '../types/story'
import { deepFreeze, docFrom, shuffled } from './helpers'

describe('passage note', () => {
  const doc = docFrom({ One: ['Two'], Two: [] })
  const one = doc.nodes[0]!.id
  const noteOf = (d: typeof doc) => d.nodes.find((n) => n.id === one)!.note

  it('keeps whatever the author typed', () => {
    // Free text now. The field once carried a grammar so that per-passage
    // notes could concatenate into a route; the concatenation turned out to
    // be noise, and what survived needs no grammar at all. The concatenation
    // came back on `slug`, which is a separate field for that reason — see
    // `normalizeSlug`.
    expect(noteOf(setNote(doc, one, 'ate dragonfruit'))).toBe('ate dragonfruit')
    expect(noteOf(setNote(doc, one, '*-?!'))).toBe('*-?!')
  })

  it('keeps leading and trailing space, and any length at all', () => {
    // Nothing normalizes on the way out or back in, so the round trip is
    // identity rather than a fixed point — the same bargain `story notes`
    // makes. Trailing whitespace is where the caret is parked, and the field is
    // a textarea now, so trimming would eat it mid-sentence.
    const typed = '  two things still owed here\n\n  - a better ending\n'
    const set = setNote(doc, one, typed)
    expect(noteOf(set)).toBe(typed)
    expect(parseDoc(serializeDoc(set)).doc.nodes.find((n) => n.id === one)!.note).toBe(typed)
  })

  it('returns the identical document for a no-op, protecting the undo stack', () => {
    const set = setNote(doc, one, 'a note')
    // This matters more without a cap, not less: the cap used to swallow every
    // keystroke past thirty characters, and now every one of them commits.
    expect(setNote(set, one, 'a note')).toBe(set)
    expect(setNote(set, one, 'a note ')).not.toBe(set)
  })

  it('survives a save-file round trip', () => {
    const set = setNote(doc, one, 'turning point')
    const back = parseDoc(serializeDoc(set)).doc
    expect(back.nodes.find((n) => n.id === one)!.note).toBe('turning point')
    expect(serializeDoc(back)).toBe(serializeDoc(set))
  })

  it('serializes byte-identically however the nodes are ordered', () => {
    const set = setNote(setNote(doc, one, 'first'), doc.nodes[1]!.id, 'second')
    const base = serializeDoc(set)
    for (let i = 0; i < 4; i++) {
      expect(serializeDoc({ ...set, nodes: shuffled(set.nodes, i + 7) })).toBe(base)
    }
  })

  it('loads a save file written before notes existed', () => {
    const { doc: back, warnings } = parseDoc(
      JSON.stringify({ nodes: [{ id: '1', title: 'One', code: 'P1', body: '' }] }),
    )
    expect(back.nodes[0]!.note).toBe('')
    expect(warnings).toEqual([])
  })
})

describe('passage slug', () => {
  const doc = docFrom({ One: ['Two'], Two: [] })
  const one = doc.nodes[0]!.id
  const slugOf = (d: typeof doc) => d.nodes.find((n) => n.id === one)!.slug

  it('keeps whatever the author typed, up to the cap', () => {
    expect(slugOf(setSlug(doc, one, 'LY'))).toBe('LY')
    expect(slugOf(setSlug(doc, one, '  spaced  '))).toBe('spaced')
    expect(slugOf(setSlug(doc, one, 'a'.repeat(SLUG_MAX * 2)))).toBe('a'.repeat(SLUG_MAX))
  })

  it('strips the asterisk, because that is the ambiguity marker', () => {
    // A literal `*` in a slug could not be told from the `*` a running slug
    // writes where routes disagree, and the card would state something false.
    expect(slugOf(setSlug(doc, one, 'a*b'))).toBe('ab')
    expect(slugOf(setSlug(doc, one, '***'))).toBe('')
  })

  it('normalizes to something it would not change again', () => {
    // Cut mid-space and a second pass would trim, so a hand-edited file would
    // not re-serialize to itself — which is the canonical-JSON invariant.
    const cut = setSlug(doc, one, 'a'.repeat(SLUG_MAX - 1) + ' b')
    const back = parseDoc(serializeDoc(cut)).doc
    expect(serializeDoc(back)).toBe(serializeDoc(cut))
  })

  it('counts characters, not UTF-16 units, so an emoji is never halved', () => {
    // Exactly at the cap in characters, one over it in UTF-16 units.
    expect(slugOf(setSlug(doc, one, 'a'.repeat(SLUG_MAX - 1) + '\u{1F525}'))).toBe(
      'a'.repeat(SLUG_MAX - 1) + '\u{1F525}',
    )
  })

  it('returns the identical document for a no-op, protecting the undo stack', () => {
    const set = setSlug(doc, one, 'LY')
    // Committed on every keystroke, so past the cap every further character
    // would otherwise push an empty undo entry.
    expect(setSlug(set, one, 'LY ')).toBe(set)
    expect(setSlug(set, one, 'LZ')).not.toBe(set)
  })

  it('does not have to be unique', () => {
    // A running slug identifies the route so far, not the passage at the end of
    // it, so two passages sharing a mark is ordinary rather than a conflict —
    // unlike `code`, which `setCode` refuses to duplicate.
    const both = setSlug(setSlug(doc, one, 'A'), doc.nodes[1]!.id, 'A')
    expect(both.nodes.map((n) => n.slug)).toEqual(['A', 'A'])
  })

  it('survives a save-file round trip', () => {
    const set = setSlug(doc, one, 'LY')
    const back = parseDoc(serializeDoc(set)).doc
    expect(back.nodes.find((n) => n.id === one)!.slug).toBe('LY')
    expect(serializeDoc(back)).toBe(serializeDoc(set))
  })

  it('serializes byte-identically however the nodes are ordered', () => {
    const set = setSlug(setSlug(doc, one, 'A'), doc.nodes[1]!.id, 'B')
    const base = serializeDoc(set)
    for (let i = 0; i < 4; i++) {
      expect(serializeDoc({ ...set, nodes: shuffled(set.nodes, i + 7) })).toBe(base)
    }
  })

  it('loads a save file written before slugs existed', () => {
    const { doc: back, warnings } = parseDoc(
      JSON.stringify({ nodes: [{ id: '1', title: 'One', code: 'P1', body: '' }] }),
    )
    expect(back.nodes[0]!.slug).toBe('')
    expect(warnings).toEqual([])
  })
})

describe('story notes', () => {
  const doc = docFrom({ One: ['Two'], Two: [] })

  it('keeps whatever the author typed, trailing newline and all', () => {
    // Nothing normalizes on the way out or back in, so the round trip is
    // identity rather than a fixed point. A scratchpad's trailing newline is
    // where the caret is parked; trimming would eat it mid-sentence.
    const typed = '  the ending\n\n'
    const set = setStoryNotes(doc, typed)
    expect(set.notes).toBe(typed)
    expect(parseDoc(serializeDoc(set)).doc.notes).toBe(typed)
  })

  it('returns the identical document for a no-op, protecting the undo stack', () => {
    const set = setStoryNotes(doc, 'Mira never learns the truth.')
    // Committed on every keystroke, so a no-op would push an empty undo entry
    // and wipe the redo stack.
    expect(setStoryNotes(set, 'Mira never learns the truth.')).toBe(set)
    expect(setStoryNotes(set, 'Mira never learns the truth!')).not.toBe(set)
  })

  it('survives a save-file round trip', () => {
    const set = setStoryNotes(doc, 'Loose end: who pays the innkeeper?')
    const back = parseDoc(serializeDoc(set)).doc
    expect(back.notes).toBe('Loose end: who pays the innkeeper?')
    expect(serializeDoc(back)).toBe(serializeDoc(set))
  })

  it('serializes byte-identically however the nodes are ordered', () => {
    const set = setStoryNotes(doc, 'A paragraph about the ending.')
    const base = serializeDoc(set)
    for (let i = 0; i < 4; i++) {
      expect(serializeDoc({ ...set, nodes: shuffled(set.nodes, i + 7) })).toBe(base)
    }
  })

  it('loads a save file written before story notes existed', () => {
    const { doc: back, warnings } = parseDoc(
      JSON.stringify({ nodes: [{ id: '1', title: 'One', code: 'P1', body: '' }] }),
    )
    expect(back.notes).toBe('')
    expect(warnings).toEqual([])
  })

  it('repairs a notes field that is not a string, without a warning', () => {
    // Repairing something nobody wrote is not news.
    const { doc: back, warnings } = parseDoc(
      JSON.stringify({ notes: 42, nodes: [{ id: '1', code: 'P1', body: '' }] }),
    )
    expect(back.notes).toBe('')
    expect(warnings).toEqual([])
  })
})

describe('link parsing', () => {
  it('reads all four Twine link forms', () => {
    const links = parseLinks('[[Cave]] [[Go north|Cave]] [[Go north->Cave]] [[Cave<-Go north]]')
    expect(links.map((l) => l.target)).toEqual(['Cave', 'Cave', 'Cave', 'Cave'])
    expect(links.map((l) => l.label)).toEqual([null, 'Go north', 'Go north', 'Go north'])
  })

  it('trims whitespace around the target', () => {
    expect(parseLinks('[[ Go |  Cave  ]]')[0]!.target).toBe('Cave')
  })

  it('splits at the outermost arrow so display text may contain one', () => {
    expect(parseLinks('[[a -> b->Cave]]')[0]!.target).toBe('Cave')
    expect(parseLinks('[[Cave<-a <- b]]')[0]!.target).toBe('Cave')
  })

  it('ignores a link with no target', () => {
    expect(parseLinks('[[]] [[  ]]')).toHaveLength(0)
  })
})

describe('code cascade', () => {
  it('rewrites the target half of every link form, leaving display text alone', () => {
    const body = 'a [[Cave]] b [[Go north|Cave]] c [[Go north->Cave]] d [[Cave<-Go north]] e'
    expect(retargetLinks(body, 'Cave', 'Dark Cave')).toBe(
      'a [[Dark Cave]] b [[Go north|Dark Cave]] c [[Go north->Dark Cave]] d [[Dark Cave<-Go north]] e',
    )
  })

  it('leaves unrelated prose containing the same word untouched', () => {
    expect(retargetLinks('The Cave is dark. [[Cave]]', 'Cave', 'Grotto')).toBe(
      'The Cave is dark. [[Grotto]]',
    )
  })

  it('updates every parent that linked to the recoded passage', () => {
    const doc = docFrom({ One: ['Cave'], Two: ['Cave'], Cave: [] }, { codes: { Cave: 'Cave' } })
    const caveId = doc.nodes.find((n) => n.title === 'Cave')!.id
    const { doc: next, error } = setCode(doc, caveId, 'Grotto')
    expect(error).toBeNull()

    const g = deriveGraph(next)
    expect(g.phantoms).toHaveLength(0)
    for (const title of ['One', 'Two']) {
      const body = next.nodes.find((n) => n.title === title)!.body
      // Only the target half moves; the display text the author wrote stays put.
      expect(body).toContain('[[Go to Cave|Grotto]]')
    }
  })

  it('refuses a colliding code and changes nothing', () => {
    const doc = docFrom({ One: [], Two: [] })
    const id = doc.nodes.find((n) => n.title === 'One')!.id
    const { doc: next, error } = setCode(doc, id, 'P2')
    expect(error).toBe('Code "P2" is already used by "Two".')
    expect(next).toBe(doc)
  })

  it('refuses an empty code', () => {
    const doc = docFrom({ One: [] })
    const id = doc.nodes[0]!.id
    expect(setCode(doc, id, '   ').error).toBe('A passage needs a code.')
  })

  it('treats codes as case-sensitive, so 3a and 3A are different passages', () => {
    const doc = docFrom({ One: [], Two: [] }, { codes: { One: '3A' } })
    const two = doc.nodes.find((n) => n.title === 'Two')!.id
    const { error } = setCode(doc, two, '3a')
    expect(error).toBeNull()
  })

  it('renames a title without touching a single link', () => {
    const doc = docFrom({ One: ['Two'], Two: [] })
    const two = doc.nodes.find((n) => n.title === 'Two')!.id
    const next = renameNode(doc, two, 'The Cave')

    expect(next.nodes.find((n) => n.id === two)!.title).toBe('The Cave')
    expect(next.nodes.find((n) => n.title === 'One')!.body).toBe(
      doc.nodes.find((n) => n.title === 'One')!.body,
    )
    expect(deriveGraph(next).phantoms).toHaveLength(0)
  })

  it('lets two passages share a title', () => {
    const doc = docFrom({ One: ['Two'], Two: [] })
    const next = renameNode(doc, doc.nodes.find((n) => n.title === 'Two')!.id, 'One')

    expect(next.nodes.map((n) => n.title)).toEqual(['One', 'One'])
    // Structure is untouched: the link still names a code, and codes are unique.
    const g = deriveGraph(next)
    expect(g.phantoms).toHaveLength(0)
    expect(g.edges).toHaveLength(1)
  })
})

describe('auto-create and delete', () => {
  it('creates nothing while the author is still typing', () => {
    const { doc: withOne } = createNode(emptyDoc(), { title: 'One' })
    const typed = setBody(withOne, withOne.nodes[0]!.id, '[[Go|Cave]]')
    expect(typed.nodes).toHaveLength(1)
  })

  it('creates a passage when a body that links somewhere new settles', () => {
    const { doc: withOne } = createNode(emptyDoc(), { title: 'One' })
    const id = withOne.nodes[0]!.id
    const next = resolveLinks(setBody(withOne, id, '[[Go|Cave]]'), id, '')

    // The author named the code; the link's display text becomes the title.
    const made = next.nodes.find((n) => n.id !== id)!
    expect(made.code).toBe('Cave')
    expect(made.title).toBe('Go')
  })

  it('mints a code for a bare link and writes it back into the prose', () => {
    const { doc: withOne } = createNode(emptyDoc(), { title: 'One' })
    const id = withOne.nodes[0]!.id
    const next = resolveLinks(setBody(withOne, id, 'Go on. [[Head north]] or stay.'), id, '')

    const made = next.nodes.find((n) => n.id !== id)!
    expect(made.title).toBe('Head north')
    expect(made.code).toBe('P2')
    // Only the target half is spliced; the prose around it is byte-identical.
    expect(next.nodes.find((n) => n.id === id)!.body).toBe('Go on. [[Head north|P2]] or stay.')
  })

  it('gives two bare links to the same name one passage', () => {
    const { doc: withOne } = createNode(emptyDoc(), { title: 'One' })
    const id = withOne.nodes[0]!.id
    const next = resolveLinks(setBody(withOne, id, '[[Head north]] and [[Head north]]'), id, '')

    expect(next.nodes).toHaveLength(2)
    expect(next.nodes.find((n) => n.id === id)!.body).toBe(
      '[[Head north|P2]] and [[Head north|P2]]',
    )
  })

  it('does not match a bare link against a title', () => {
    const doc = docFrom({ One: [], Cave: [] })
    const id = doc.nodes.find((n) => n.title === 'One')!.id
    const next = resolveLinks(setBody(doc, id, '[[Cave]]'), id, '')

    // Titles are cosmetic, so the existing "Cave" is not a link target. A second
    // passage is created, and the two share a title quite legally.
    expect(next.nodes.filter((n) => n.title === 'Cave')).toHaveLength(2)
    expect(deriveGraph(next).phantoms).toHaveLength(0)
  })

  it('does not resurrect a passage that was deleted while still linked', () => {
    let doc = createNode(emptyDoc(), { title: 'One' }).doc
    const oneId = doc.nodes[0]!.id
    doc = resolveLinks(setBody(doc, oneId, '[[Go|Cave]]'), oneId, '')
    const caveId = doc.nodes.find((n) => n.code === 'Cave')!.id

    doc = deleteNode(doc, caveId)
    expect(doc.nodes.map((n) => n.title)).toEqual(['One'])
    // The author's prose is untouched; the link surfaces as a phantom instead.
    expect(doc.nodes[0]!.body).toBe('[[Go|Cave]]')
    expect(deriveGraph(doc).phantoms.map((p) => p.code)).toEqual(['Cave'])

    // Settling again must not bring it back — `[[Go|Cave]]` reads as an
    // instruction to create "Cave", and only the guard stops it.
    const before = doc.nodes[0]!.body
    doc = resolveLinks(setBody(doc, oneId, 'Some prose. [[Go|Cave]]'), oneId, before)
    expect(doc.nodes.map((n) => n.title)).toEqual(['One'])
  })

  it('deletes several passages in one edit, leaving the prose alone', () => {
    const doc = docFrom({ One: ['Two', 'Three'], Two: [], Three: [] })
    const next = deleteNodes(doc, [doc.nodes[1]!.id, doc.nodes[2]!.id])

    expect(next.nodes.map((n) => n.title)).toEqual(['One'])
    // Same rule as a single delete: the author's markup is never rewritten.
    expect(next.nodes[0]!.body).toBe(doc.nodes[0]!.body)
    expect(deriveGraph(next).phantoms.map((p) => p.code)).toEqual(['P2', 'P3'])
  })

  it('returns the same document when nothing matches', () => {
    // The store's commit compares by reference, so a no-op that cloned would
    // push an empty undo entry and wipe the redo stack.
    const doc = docFrom({ One: ['Two'], Two: [] })
    expect(deleteNodes(doc, [])).toBe(doc)
    expect(deleteNodes(doc, ['no-such-id'])).toBe(doc)
    expect(deleteNode(doc, 'no-such-id')).toBe(doc)
  })

  it('re-roots the story when the start passage is in the batch', () => {
    const doc = docFrom({ One: ['Two'], Two: ['Three'], Three: [] })
    const next = deleteNodes(doc, [doc.nodes[0]!.id, doc.nodes[1]!.id])
    expect(next.startNodeId).toBe(next.nodes[0]!.id)
    expect(next.nodes.map((n) => n.title)).toEqual(['Three'])
  })
})

describe('batch state and ending', () => {
  const doc = docFrom({ One: ['Two', 'Three'], Two: [], Three: [] })
  const [one, two, three] = doc.nodes.map((n) => n.id) as [string, string, string]

  it('sets the state of several passages in one edit', () => {
    const next = setStateMany(doc, [two, three], 'Done')

    expect(next.nodes.map((n) => n.state)).toEqual(['TODO', 'Done', 'Done'])
    // A state change is not a statement about the prose, the same as a delete.
    expect(next.nodes.map((n) => n.body)).toEqual(doc.nodes.map((n) => n.body))
  })

  it('marks several passages as endings in one edit', () => {
    const next = setEndingMany(doc, [two, three], true)
    expect(next.nodes.map((n) => n.isEnding)).toEqual([false, true, true])
  })

  it('ignores ids the document does not have', () => {
    const next = setStateMany(doc, [two, 'no-such-id'], 'Draft')
    expect(next.nodes.map((n) => n.state)).toEqual(['TODO', 'Draft', 'TODO'])
  })

  it('returns the same document when every id already holds the value', () => {
    // The store's commit compares by reference. A whole selection already
    // agreeing is the common case here, not the rare one — clicking Done on a
    // branch that is mostly done must not push an empty undo entry.
    expect(setStateMany(doc, [], 'Done')).toBe(doc)
    expect(setStateMany(doc, [one, two, three], 'TODO')).toBe(doc)
    expect(setStateMany(doc, ['no-such-id'], 'Done')).toBe(doc)

    expect(setEndingMany(doc, [], true)).toBe(doc)
    expect(setEndingMany(doc, [one, two, three], false)).toBe(doc)
  })

  it('commits when only some of the batch would change', () => {
    const partly = setStateMany(doc, [two], 'Done')
    // `three` is still TODO, so the batch is a real edit even though `two` is
    // already Done — the guard asks whether *any* id changes, not whether all do.
    expect(setStateMany(partly, [two, three], 'Done')).not.toBe(partly)
  })

  it('keeps the single-passage writes as the one-entry case', () => {
    expect(setState(doc, two, 'Draft').nodes[1]!.state).toBe('Draft')
    expect(setEnding(doc, two, true).nodes[1]!.isEnding).toBe(true)
    // `setState` used to clone unconditionally; routing it through the batch
    // gives it the guard `setEnding` always had.
    expect(setState(doc, two, 'TODO')).toBe(doc)
    expect(setEnding(doc, two, false)).toBe(doc)
  })

  it('leaves the rest of the document alone', () => {
    const next = setEndingMany(doc, [three], true)
    expect(serializeDoc({ ...next, nodes: next.nodes.map((n) => ({ ...n, isEnding: false })) })).toBe(
      serializeDoc(doc),
    )
  })
})

describe('batch level offset', () => {
  const doc = docFrom({ One: ['Two', 'Three'], Two: [], Three: [] })
  const [one, two, three] = doc.nodes.map((n) => n.id) as [string, string, string]

  it('nudges several passages in one edit', () => {
    const next = setLevelOffsetMany(doc, [two, three], 1)

    expect(next.nodes.map((n) => n.levelOffset)).toEqual([0, 1, 1])
    // A nudge is not a statement about the prose, the same as a state change.
    expect(next.nodes.map((n) => n.body)).toEqual(doc.nodes.map((n) => n.body))
  })

  it('clamps out of range in both directions', () => {
    expect(setLevelOffsetMany(doc, [two, three], 9).nodes.map((n) => n.levelOffset)).toEqual([
      0, 1, 1,
    ])
    const pushed = setLevelOffsetMany(doc, [one, two, three], 1)
    expect(setLevelOffsetMany(pushed, [two], -3).nodes.map((n) => n.levelOffset)).toEqual([1, 0, 1])
  })

  it('ignores ids the document does not have', () => {
    const next = setLevelOffsetMany(doc, [two, 'no-such-id'], 1)
    expect(next.nodes.map((n) => n.levelOffset)).toEqual([0, 1, 0])
  })

  it('returns the same document when every id already sits where it is asked to', () => {
    expect(setLevelOffsetMany(doc, [], 1)).toBe(doc)
    expect(setLevelOffsetMany(doc, [one, two, three], 0)).toBe(doc)
    expect(setLevelOffsetMany(doc, ['no-such-id'], 1)).toBe(doc)

    // Clamped ahead of the guard, so an out-of-range ask against a passage
    // already at 1 is the no-op it looks like. The `replaceNode` this
    // replaced cloned straight through it.
    const pushed = setLevelOffsetMany(doc, [two], 1)
    expect(setLevelOffsetMany(pushed, [two], 9)).toBe(pushed)
  })

  it('commits when only some of the batch would change', () => {
    const partly = setLevelOffsetMany(doc, [two], 1)
    expect(setLevelOffsetMany(partly, [two, three], 1)).not.toBe(partly)
  })

  it('keeps the single-passage write as the one-entry case', () => {
    expect(setLevelOffset(doc, two, 1).nodes[1]!.levelOffset).toBe(1)
    expect(setLevelOffset(doc, two, 0)).toBe(doc)
  })

  it('leaves the rest of the document alone', () => {
    const next = setLevelOffsetMany(doc, [three], 1)
    expect(
      serializeDoc({ ...next, nodes: next.nodes.map((n) => ({ ...n, levelOffset: 0 })) }),
    ).toBe(serializeDoc(doc))
  })
})

describe('tags', () => {
  it('registers a new tag story-wide so other passages can reuse it', () => {
    const doc = docFrom({ One: [], Two: [] })
    const next = addTag(doc, doc.nodes[0]!.id, 'exposition')
    expect(next.tagColors.map((t) => t.name)).toEqual(['exposition'])
    expect(next.tagColors[0]!.color).toBe('none')
  })

  it('recolours a tag in one place for every passage carrying it', () => {
    let doc = docFrom({ One: [], Two: [] })
    doc = addTag(doc, doc.nodes[0]!.id, 'exposition')
    doc = addTag(doc, doc.nodes[1]!.id, 'exposition')
    doc = setTagColor(doc, 'exposition', 'purple')
    expect(doc.tagColors).toEqual([{ name: 'exposition', color: 'purple' }])
    expect(doc.nodes.every((n) => n.tags.includes('exposition'))).toBe(true)
  })

  it('removes a tag nothing carries', () => {
    let doc = docFrom({ One: [], Two: [] })
    doc = addTag(doc, doc.nodes[0]!.id, 'exposition')
    doc = removeTag(doc, doc.nodes[0]!.id, 'exposition')
    // Un-tagging a passage leaves the tag registered — that is the row the
    // analyzer calls unused, and this is what clears it.
    expect(doc.tagColors.map((t) => t.name)).toEqual(['exposition'])
    expect(deleteTag(doc, 'exposition').tagColors).toEqual([])
  })

  it('refuses to remove a tag a passage still carries, rather than stripping it', () => {
    let doc = docFrom({ One: [], Two: [] })
    doc = addTag(doc, doc.nodes[0]!.id, 'exposition')
    // Reference-identity, not just equality: `commit` compares by reference, so
    // a refusal has to push no undo entry for a press that did nothing.
    expect(deleteTag(doc, 'exposition')).toBe(doc)
  })

  it('does nothing for a tag the story never had', () => {
    const doc = docFrom({ One: [] })
    expect(deleteTag(doc, 'ghost')).toBe(doc)
  })
})

describe('save file', () => {
  it('round-trips', () => {
    let doc = docFrom({ One: ['Two', 'Three'], Two: [], Three: [] })
    doc = addTag(doc, doc.nodes[0]!.id, 'intro')
    const canonical = { ...doc, nodes: [...doc.nodes].sort(compareNodes) }
    expect(parseDoc(serializeDoc(doc)).doc).toEqual(canonical)
    // ...and parsing is idempotent, so re-saving never churns the file.
    expect(serializeDoc(parseDoc(serializeDoc(doc)).doc)).toBe(serializeDoc(doc))
  })

  it('serializes byte-identically however the nodes are ordered', () => {
    const doc = docFrom({ One: ['Two', 'Three'], Two: [], Three: [] })
    const base = serializeDoc(doc)
    for (let i = 0; i < 4; i++) {
      expect(serializeDoc({ ...doc, nodes: shuffled(doc.nodes, i + 7) })).toBe(base)
    }
  })

  it('repairs a hand-edited file rather than rejecting it', () => {
    const { doc, warnings } = parseDoc(
      JSON.stringify({
        nodes: [
          { id: '1', title: 'One', body: '', state: 'nonsense', levelOffset: 9 },
          { id: '1', title: 'One' },
        ],
      }),
    )
    expect(doc.nodes).toHaveLength(2)
    // Duplicate titles are legal now, so the repair leaves both alone.
    expect(doc.nodes.map((n) => n.title)).toEqual(['One', 'One'])
    expect(doc.nodes.every((n) => n.state === 'TODO')).toBe(true)
    expect(doc.nodes.every((n) => n.levelOffset <= 1)).toBe(true)
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('leaves an untitled passage untitled rather than inventing a name', () => {
    const { doc } = parseDoc(JSON.stringify({ nodes: [{ id: '1', code: 'A3', body: '' }] }))
    expect(doc.nodes[0]!.title).toBe('')
  })
})

describe('passage code', () => {
  const doc = docFrom({ One: ['Two'], Two: [] })
  const [one, two] = [doc.nodes[0]!.id, doc.nodes[1]!.id]

  it('is minted from the id, so every passage has one', () => {
    const made = createNode(emptyDoc(), { title: 'One' })
    expect(made.node.code).toBe('P1')
    expect(createNode(made.doc, {}).node.code).toBe('P2')
  })

  it('steps past a code the author already typed by hand', () => {
    // `P2` is the code the counter is about to reach; minting must skip it
    // rather than hand out a duplicate link target.
    const taken = setCode(createNode(emptyDoc(), {}).doc, '1', 'P2').doc
    expect(createNode(taken, {}).node.code).toBe('P3')
  })

  it('sets and trims a code', () => {
    const next = setCode(doc, one, '  A3 ').doc
    expect(next.nodes.find((n) => n.id === one)!.code).toBe('A3')
  })

  it('refuses to clear a code, since an uncoded passage is unreachable', () => {
    const set = setCode(doc, one, 'A3').doc
    const cleared = setCode(set, one, '   ')
    expect(cleared.error).toBe('A passage needs a code.')
    expect(cleared.doc).toBe(set)
  })

  it('refuses a code carrying link syntax', () => {
    // Spliced into every inbound `[[...]]`, such a code would re-point the link.
    expect(setCode(doc, one, 'A->B').error).toContain('->')
    expect(setCode(doc, one, 'A|B').error).toContain('|')
  })

  it('rejects a duplicate, naming the passage that holds it', () => {
    const set = setCode(doc, one, 'A3').doc
    const clash = setCode(set, two, 'A3')
    expect(clash.error).toContain('One')
    expect(clash.doc).toBe(set)
  })

  it('treats codes differing only in case as different codes', () => {
    const set = setCode(doc, one, 'A3').doc
    expect(setCode(set, two, 'a3').error).toBeNull()
  })

  it('keeps the author\'s capitalisation', () => {
    const set = setCode(doc, one, 'a3').doc
    expect(set.nodes.find((n) => n.id === one)!.code).toBe('a3')
  })

  it('returns the identical document for a no-op, protecting the undo stack', () => {
    const set = setCode(doc, one, 'A3').doc
    expect(setCode(set, one, 'A3').doc).toBe(set)
  })

  it('survives a save-file round trip', () => {
    const set = setCode(doc, one, 'A3').doc
    const back = parseDoc(serializeDoc(set)).doc
    expect(back.nodes.find((n) => n.id === one)!.code).toBe('A3')
    expect(serializeDoc(back)).toBe(serializeDoc(set))
  })

  it('invents a code for a file that has none, reusing the id', () => {
    const { doc: loaded, warnings } = parseDoc(
      JSON.stringify({ nodes: [{ id: '1', title: 'One', body: '' }] }),
    )
    // `P<id>` is what `createNode` would have minted, so a file stripped of its
    // codes reloads with the codes it started with.
    expect(loaded.nodes[0]!.code).toBe('P1')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('keeps a hand-edited duplicate code for the first passage only', () => {
    const { doc: loaded, warnings } = parseDoc(
      JSON.stringify({
        nodes: [
          { id: '1', title: 'One', body: '', code: 'A3' },
          { id: '2', title: 'Two', body: '', code: 'A3' },
        ],
      }),
    )
    const byId = new Map(loaded.nodes.map((n) => [n.id, n.code]))
    expect(byId.get('1')).toBe('A3')
    // The loser cannot simply be cleared: a passage with no code is unreachable,
    // and the code it is given follows the shape the story is already in rather
    // than dropping a stray `P2` into a story coded `A…`.
    expect(byId.get('2')).toBe('A2')
    expect(warnings.some((w) => w.includes('A3'))).toBe(true)
  })

  it('reproduces a padded code for a file that lost one', () => {
    // The correspondence the repair path exists for: a code this app minted and
    // someone stripped out comes back the same. Padding is part of that shape,
    // so a story recoded to `P01`.. must not reload with a bare `P2`.
    const { doc: loaded } = parseDoc(
      JSON.stringify({
        nodes: [
          { id: '1', title: 'One', code: 'P01', body: '[[Go|P02]]' },
          { id: '2', title: 'Two' },
        ],
      }),
    )
    expect(loaded.nodes.find((n) => n.id === '2')!.code).toBe('P02')
    expect(deriveGraph(loaded).phantoms).toHaveLength(0)
  })

  it('bumps nextId past every code it invents', () => {
    // Non-numeric ids, so `P<id>` is unavailable and the counter is the only
    // source of codes.
    const { doc: loaded } = parseDoc(
      JSON.stringify({ nodes: [{ id: 'a', title: 'One' }, { id: 'b', title: 'Two' }] }),
    )
    expect(loaded.nodes.map((n) => n.code)).toEqual(['P1', 'P2'])
    // Left at 1, the next passage added would be minted a code already in use.
    expect(loaded.nextId).toBe(3)
  })

  it('skips a code the author typed by hand when minting the next one', () => {
    const { doc: loaded } = parseDoc(
      JSON.stringify({ nodes: [{ id: '1', title: 'One', code: 'P2' }], nextId: 2 }),
    )
    expect(createNode(loaded, {}).node.code).toBe('P3')
  })
})

describe('batch recode', () => {
  const doc = docFrom({ One: ['Two'], Two: ['One'] })
  const [one, two] = [doc.nodes[0]!.id, doc.nodes[1]!.id]

  it('swaps a pair of codes, which one-at-a-time renaming cannot', () => {
    // `setCode(one, 'P2')` is a collision it is right to refuse, and applying the
    // pair in sequence would move each link twice. One pass does neither.
    const { doc: next, error } = recodeAll(doc, new Map([[one, 'P2'], [two, 'P1']]))
    expect(error).toBeNull()

    const byId = new Map(next.nodes.map((n) => [n.id, n]))
    expect(byId.get(one)!.code).toBe('P2')
    expect(byId.get(two)!.code).toBe('P1')
    // One links to Two, which is now P1; Two links to One, which is now P2.
    expect(byId.get(one)!.body).toBe('[[Go to Two|P1]]')
    expect(byId.get(two)!.body).toBe('[[Go to One|P2]]')
    expect(deriveGraph(next).phantoms).toHaveLength(0)
  })

  it('renumbers a whole cycle without a link landing on the wrong passage', () => {
    const three = docFrom({ A: ['B'], B: ['C'], C: ['A'] })
    const [a, b, c] = three.nodes.map((n) => n.id)
    const { doc: next } = recodeAll(three, new Map([[a!, 'P2'], [b!, 'P3'], [c!, 'P1']]))
    const byId = new Map(next.nodes.map((n) => [n.id, n]))
    expect(byId.get(a!)!.body).toBe('[[Go to B|P3]]')
    expect(byId.get(b!)!.body).toBe('[[Go to C|P1]]')
    expect(byId.get(c!)!.body).toBe('[[Go to A|P2]]')
  })

  it('leaves a dangling target alone — that prose is the author\'s', () => {
    const ghosted = docFrom({ A: ['Ghost'] })
    const a = ghosted.nodes[0]!.id
    const { doc: next } = recodeAll(ghosted, new Map([[a, '1N1']]))
    expect(next.nodes[0]!.body).toBe('[[Go to Ghost|Ghost]]')
    expect(deriveGraph(next).phantoms.map((p) => p.code)).toEqual(['Ghost'])
  })

  it('rewrites a self-link in the recoded passage\'s own body', () => {
    // `setCode` skips the node it is recoding; here that would drop the loop.
    const loop = docFrom({ A: ['A'] })
    const a = loop.nodes[0]!.id
    const { doc: next } = recodeAll(loop, new Map([[a, 'Again']]))
    expect(next.nodes[0]!.body).toBe('[[Go to A|Again]]')
    expect(deriveGraph(next).phantoms).toHaveLength(0)
  })

  it('returns the identical document when nothing moves', () => {
    expect(recodeAll(doc, new Map([[one, 'P1'], [two, 'P2']])).doc).toBe(doc)
    expect(recodeAll(doc, new Map()).doc).toBe(doc)
  })

  it('trims, like every other code write', () => {
    const { doc: next } = recodeAll(doc, new Map([[one, '  A3  ']]))
    expect(next.nodes.find((n) => n.id === one)!.code).toBe('A3')
  })

  it('refuses two passages claiming one code, naming both', () => {
    const clash = recodeAll(doc, new Map([[one, 'X'], [two, 'X']]))
    expect(clash.error).toContain('One')
    expect(clash.error).toContain('Two')
    expect(clash.doc).toBe(doc)
  })

  it('refuses a code that a passage outside the mapping still holds', () => {
    // A partial recode may not walk onto a code nobody offered to vacate.
    const clash = recodeAll(doc, new Map([[one, 'P2']]))
    expect(clash.error).toContain('P2')
    expect(clash.doc).toBe(doc)
  })

  it('refuses link syntax, an empty code and an unknown passage', () => {
    expect(recodeAll(doc, new Map([[one, 'A->B']])).error).toContain('->')
    expect(recodeAll(doc, new Map([[one, '   ']])).error).toBe('A passage needs a code.')
    expect(recodeAll(doc, new Map([['nope', 'X']])).error).toContain('no longer exists')
    for (const bad of ['A->B', '   ']) expect(recodeAll(doc, new Map([[one, bad]])).doc).toBe(doc)
  })

  it('repairs a hand-edited duplicate code, because it is keyed by id', () => {
    const dupe = docFrom({ One: [], Two: [] }, { codes: { One: 'A3', Two: 'A3' } })
    const [a, b] = dupe.nodes.map((n) => n.id)
    const { doc: next, error } = recodeAll(dupe, new Map([[a!, '1N1'], [b!, '1N2']]))
    expect(error).toBeNull()
    expect(next.nodes.map((n) => n.code).sort()).toEqual(['1N1', '1N2'])
  })

  it('leaves the next minted code free, even after recoding to P1..Pn', () => {
    // `freeCode` loops past anything taken, so a P-prefixed recode cannot steal
    // the code the counter is about to hand out.
    const three = docFrom({ A: [], B: [], C: [] }, { codes: { A: 'X', B: 'Y', C: 'Z' } })
    const [a, b, c] = three.nodes.map((n) => n.id)
    const { doc: next } = recodeAll(three, new Map([[a!, 'P1'], [b!, 'P2'], [c!, 'P3']]))
    const made = createNode(next, {})
    expect(next.nodes.some((n) => n.code === made.node.code)).toBe(false)
  })

  it('mints the next code in the shape the story is already in', () => {
    // A story recoded to `T01`..`T03` should not hand the next passage `P4`.
    const three = docFrom({ A: [], B: [], C: [] })
    const [a, b, c] = three.nodes.map((n) => n.id)
    const { doc: next } = recodeAll(three, new Map([[a!, 'T01'], [b!, 'T02'], [c!, 'T03']]))
    expect(createNode(next, {}).node.code).toBe('T04')
  })

  it('keeps the padding the story uses, not just the prefix', () => {
    const three = docFrom({ A: [], B: [], C: [] })
    const [a, b, c] = three.nodes.map((n) => n.id)
    const { doc: next } = recodeAll(three, new Map([[a!, 'P001'], [b!, 'P002'], [c!, 'P003']]))
    expect(createNode(next, {}).node.code).toBe('P004')
  })

  it('falls back to P when the story\'s codes do not agree on a shape', () => {
    // Level-and-node codes (`3N01`) are not a prefix plus a number, and a story
    // of mixed prefixes has no shape to copy. Neither is worth a wrong guess.
    const level = docFrom({ A: [], B: [] }, { codes: { A: '1N01', B: '2N01' } })
    expect(createNode(level, {}).node.code).toBe('P3')

    const mixed = docFrom({ A: [], B: [] }, { codes: { A: 'T1', B: 'Q2' } })
    expect(createNode(mixed, {}).node.code).toBe('P3')

    // A code that is not numbered at all is simply ignored.
    const named = docFrom({ A: [], B: [] }, { codes: { A: 'Grotto', B: 'T07' } })
    expect(createNode(named, {}).node.code).toBe('T03')
  })

  it('writes a code change even when no link text moves', () => {
    // Both passages hold `A3`, so links resolve to the first and the second has
    // no inbound text to splice. The write still has to happen, or the duplicate
    // the caller asked to repair survives behind a success.
    const dupe = docFrom({ One: [], Two: [] }, { codes: { One: 'A3', Two: 'A3' } })
    const [a, b] = dupe.nodes.map((n) => n.id)
    const { doc: next, error } = recodeAll(dupe, new Map([[a!, 'A3'], [b!, 'B4']]))
    expect(error).toBeNull()
    expect(next).not.toBe(dupe)
    expect(next.nodes.map((n) => n.code).sort()).toEqual(['A3', 'B4'])
  })

  it('names an untitled passage by its code when it refuses', () => {
    const untitled = docFrom({ One: [], Two: [] })
    untitled.nodes[0]!.title = ''
    const [a, b] = untitled.nodes.map((n) => n.id)
    const clash = recodeAll(untitled, new Map([[a!, 'X'], [b!, 'X']]))
    expect(clash.error).toContain('P1')
    expect(clash.error).not.toContain('""')
  })

  it('never mints a code carrying link syntax, whatever the file held', () => {
    // `parseDoc` checks codes for uniqueness but not for link punctuation, so a
    // hand-edited file can hold `A|B1`. Copying that shape forward would mint a
    // code that re-points the links written for it.
    const bad = docFrom({ One: [], Two: [] }, { codes: { One: 'A|B1', Two: 'A|B2' } })
    const minted = createNode(bad, {}).node.code
    expect(linkSyntaxIn(minted)).toBeNull()
    expect(minted).toBe('P3')
  })

  it('retargets a self-link in the recoded passage\'s own body', () => {
    // `setCode` used to skip the node it was recoding, dropping `[[Again|P1]]`
    // into a phantom the moment P1 became something else.
    const loop = docFrom({ One: ['One'] })
    const id = loop.nodes[0]!.id
    const { doc: next, error } = setCode(loop, id, 'P9')
    expect(error).toBeNull()
    expect(next.nodes[0]!.body).toBe('[[Go to One|P9]]')
    expect(deriveGraph(next).phantoms).toHaveLength(0)
  })

  it('survives a save-file round trip', () => {
    const { doc: next } = recodeAll(doc, new Map([[one, '1N1'], [two, '2N1']]))
    const back = parseDoc(serializeDoc(next)).doc
    expect(serializeDoc(back)).toBe(serializeDoc(next))
    expect(deriveGraph(back).phantoms).toHaveLength(0)
  })
})

/**
 * The rule `replaceNode` leans on, made mechanical.
 *
 * Mutations are pure by construction, but "pure" here is narrower than it
 * sounds: several of them *do* assign in place, onto a `clone` they just made.
 * What must never happen is a write to something reached from the document that
 * came in, because that document is also sitting on the undo stack — so the
 * damage shows up as a broken undo long after the edit that caused it, with
 * nothing to connect the two. Freezing the input turns that into an immediate
 * throw at the guilty line.
 */
describe('no mutation writes to the document it was given', () => {
  const build = () =>
    docFrom(
      { One: ['Two'], Two: ['Three'], Three: [] },
      {
        start: 'One',
        tags: { One: ['red', 'blue'], Two: ['red'] },
        casts: { One: ['Mira', 'Tam'], Two: ['Mira'] },
        settings: { One: 'The docks' },
        notes: { One: 'a note' },
        slugs: { One: 'A' },
        endings: ['Three'],
      },
    )

  const idOf = (doc: ReturnType<typeof build>, title: string) =>
    doc.nodes.find((n) => n.title === title)!.id

  /**
   * One case per mutation shape rather than per export: what is being checked is
   * that each *kind* of write goes through `clone`, and the shapes are what
   * differ. A mutation added later that patches in place will fail whichever of
   * these touches its field.
   */
  const cases: [string, (d: ReturnType<typeof build>) => unknown][] = [
    ['setBody', (d) => M.setBody(d, idOf(d, 'One'), 'new prose [[Go|P2]]')],
    ['renameNode', (d) => M.renameNode(d, idOf(d, 'One'), 'Renamed')],
    ['setCode', (d) => M.setCode(d, idOf(d, 'Two'), 'Z9')],
    ['setSlug', (d) => M.setSlug(d, idOf(d, 'Two'), 'B')],
    ['setNote', (d) => M.setNote(d, idOf(d, 'Two'), 'note')],
    ['setState', (d) => M.setState(d, idOf(d, 'One'), 'Done')],
    ['setEnding', (d) => M.setEnding(d, idOf(d, 'One'), true)],
    ['setLevelOffset', (d) => M.setLevelOffsetMany(d, [idOf(d, 'Two')], 1)],
    ['addTag', (d) => M.addTag(d, idOf(d, 'Three'), 'green')],
    ['removeTag', (d) => M.removeTag(d, idOf(d, 'One'), 'red')],
    ['setTagColor', (d) => M.setTagColor(d, 'red', 'red')],
    ['renameTag', (d) => M.renameTag(d, 'red', 'crimson')],
    ['deleteTag', (d) => M.deleteTag(d, 'blue')],
    ['setSetting', (d) => M.setSetting(d, idOf(d, 'Two'), 'The pier')],
    ['renameSetting', (d) => M.renameSetting(d, 'The docks', 'The wharf')],
    ['createNode', (d) => M.createNode(d)],
    ['deleteNodes', (d) => M.deleteNodes(d, [idOf(d, 'Three')])],
    ['setStartNode', (d) => M.setStartNode(d, idOf(d, 'Two'))],
    ['setStoryTitle', (d) => M.setStoryTitle(d, 'Retitled')],
    ['setStoryNotes', (d) => M.setStoryNotes(d, 'scratch')],
    ['addPassageCharacter', (d) => M.addPassageCharacter(d, idOf(d, 'Three'), 'Mira')],
    ['removePassageCharacter', (d) => M.removePassageCharacter(d, idOf(d, 'One'), 'Tam')],
    ['createCharacter', (d) => M.createCharacter(d, 'Ines')],
    ['renameCharacter', (d) => M.renameCharacter(d, 'Mira', 'Mirabel')],
    ['deleteCharacter', (d) => M.deleteCharacter(d, 'Tam')],
    ['setCharacterBio', (d) => M.setCharacterBio(d, 'Mira', 'a bio')],
    ['sortCharacters', (d) => M.sortCharacters(d)],
    ['recodeAll', (d) => M.recodeAll(d, new Map(d.nodes.map((n, i) => [n.id, `Q${i + 1}`])))],
    // Body holds a bare link the author has just written; `bodyAtFocus` is what
    // it said when they arrived, so this is the case that mints a passage.
    [
      'resolveLinks',
      (d) =>
        M.resolveLinks(
          M.setBody(d, idOf(d, 'Three'), '[[A new place]]'),
          idOf(d, 'Three'),
          '',
        ),
    ],
  ]

  for (const [name, run] of cases) {
    it(`${name} leaves its input untouched`, () => {
      const doc = build()
      const before = serializeDoc(doc)
      deepFreeze(doc)
      expect(() => run(doc)).not.toThrow()
      // Belt and braces: a frozen write throws, but a write to something the
      // freeze somehow missed would only show up here.
      expect(serializeDoc(doc)).toBe(before)
    })
  }
})
