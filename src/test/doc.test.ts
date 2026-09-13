import { describe, expect, it } from 'vitest'
import { parseLinks, retargetLinks } from '../lib/harlowe/links'
import {
  addTag,
  createNode,
  deleteNode,
  deleteNodes,
  renameNode,
  resolveLinks,
  setBody,
  setCode,
  setStoryNotes,
  setTagColor,
  setToken,
} from '../lib/doc/mutations'
import { parseDoc, serializeDoc } from '../lib/doc/serialize'
import { deriveGraph } from '../lib/graph/derive'
import { compareNodes, emptyDoc } from '../types/story'
import { docFrom, shuffled } from './helpers'

describe('passage note', () => {
  const doc = docFrom({ One: ['Two'], Two: [] })
  const one = doc.nodes[0]!.id
  const noteOf = (d: typeof doc) => d.nodes.find((n) => n.id === one)!.token

  it('keeps whatever the author typed', () => {
    // Free text now. The field once carried a grammar so that per-passage
    // tokens could concatenate into a route; the concatenation turned out to
    // be noise, and what survived needs no grammar at all.
    expect(noteOf(setToken(doc, one, 'ate dragonfruit'))).toBe('ate dragonfruit')
    expect(noteOf(setToken(doc, one, '*-?!'))).toBe('*-?!')
  })

  it('trims and caps at fifteen characters', () => {
    expect(noteOf(setToken(doc, one, '  spaced  '))).toBe('spaced')
    expect(noteOf(setToken(doc, one, 'a'.repeat(40)))).toBe('a'.repeat(15))
  })

  it('normalizes to something it would not change again', () => {
    // Cut mid-space and a second pass would trim, so a hand-edited file would
    // not re-serialize to itself — which is the canonical-JSON invariant.
    const cut = setToken(doc, one, 'aaaaaaaaaaaaaa b')
    const back = parseDoc(serializeDoc(cut)).doc
    expect(serializeDoc(back)).toBe(serializeDoc(cut))
  })

  it('counts characters, not UTF-16 units, so an emoji is never halved', () => {
    expect(noteOf(setToken(doc, one, 'a'.repeat(14) + '\u{1F525}'))).toBe(
      'a'.repeat(14) + '\u{1F525}',
    )
  })

  it('returns the identical document for a no-op, protecting the undo stack', () => {
    const set = setToken(doc, one, 'a note')
    // Committed on every keystroke, so past the cap every further character
    // would otherwise push an empty undo entry.
    expect(setToken(set, one, 'a note ')).toBe(set)
    expect(setToken(set, one, 'a note!')).not.toBe(set)
  })

  it('survives a save-file round trip', () => {
    const set = setToken(doc, one, 'turning point')
    const back = parseDoc(serializeDoc(set)).doc
    expect(back.nodes.find((n) => n.id === one)!.token).toBe('turning point')
    expect(serializeDoc(back)).toBe(serializeDoc(set))
  })

  it('serializes byte-identically however the nodes are ordered', () => {
    const set = setToken(setToken(doc, one, 'first'), doc.nodes[1]!.id, 'second')
    const base = serializeDoc(set)
    for (let i = 0; i < 4; i++) {
      expect(serializeDoc({ ...set, nodes: shuffled(set.nodes, i + 7) })).toBe(base)
    }
  })

  it('loads a save file written before notes existed', () => {
    const { doc: back, warnings } = parseDoc(
      JSON.stringify({ nodes: [{ id: '1', title: 'One', code: 'P1', body: '' }] }),
    )
    expect(back.nodes[0]!.token).toBe('')
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
    // The loser cannot simply be cleared: a passage with no code is unreachable.
    expect(byId.get('2')).toBe('P2')
    expect(warnings.some((w) => w.includes('A3'))).toBe(true)
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
