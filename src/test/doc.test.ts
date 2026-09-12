import { describe, expect, it } from 'vitest'
import { parseLinks, retargetLinks } from '../lib/harlowe/links'
import {
  addTag,
  createNode,
  deleteNode,
  renameNode,
  setBody,
  setCode,
  setTagColor,
} from '../lib/doc/mutations'
import { parseDoc, serializeDoc } from '../lib/doc/serialize'
import { deriveGraph } from '../lib/graph/derive'
import { compareNodes, emptyDoc } from '../types/story'
import { docFrom, shuffled } from './helpers'

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

describe('rename cascade', () => {
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

  it('updates every parent that linked to the renamed passage', () => {
    const doc = docFrom({ One: ['Cave'], Two: ['Cave'], Cave: [] })
    const caveId = doc.nodes.find((n) => n.title === 'Cave')!.id
    const { doc: next, error } = renameNode(doc, caveId, 'Grotto')
    expect(error).toBeNull()

    const g = deriveGraph(next)
    expect(g.phantoms).toHaveLength(0)
    for (const title of ['One', 'Two']) {
      const body = next.nodes.find((n) => n.title === title)!.body
      expect(body).toContain('[[Go to Cave|Grotto]]')
    }
  })

  it('refuses a colliding rename and changes nothing', () => {
    const doc = docFrom({ One: [], Two: [] })
    const id = doc.nodes.find((n) => n.title === 'One')!.id
    const { doc: next, error } = renameNode(doc, id, 'Two')
    expect(error).toBe('A passage named "Two" already exists.')
    expect(next).toBe(doc)
  })

  it('refuses an empty rename', () => {
    const doc = docFrom({ One: [] })
    const id = doc.nodes[0]!.id
    expect(renameNode(doc, id, '   ').error).toBe('A passage needs a title.')
  })
})

describe('auto-create and delete', () => {
  it('creates a passage when a body links somewhere new', () => {
    const { doc: withOne } = createNode(emptyDoc(), { title: 'One' })
    const next = setBody(withOne, withOne.nodes[0]!.id, '[[Go|Cave]]')
    expect(next.nodes.map((n) => n.title).sort()).toEqual(['Cave', 'One'])
  })

  it('does not resurrect a passage that was deleted while still linked', () => {
    let doc = createNode(emptyDoc(), { title: 'One' }).doc
    const oneId = doc.nodes[0]!.id
    doc = setBody(doc, oneId, '[[Go|Cave]]')
    const caveId = doc.nodes.find((n) => n.title === 'Cave')!.id

    doc = deleteNode(doc, caveId)
    expect(doc.nodes.map((n) => n.title)).toEqual(['One'])
    // The author's prose is untouched; the link surfaces as a phantom instead.
    expect(doc.nodes[0]!.body).toBe('[[Go|Cave]]')
    expect(deriveGraph(doc).phantoms.map((p) => p.title)).toEqual(['Cave'])

    // Editing elsewhere in the body must not bring it back.
    doc = setBody(doc, oneId, 'Some prose. [[Go|Cave]]')
    expect(doc.nodes.map((n) => n.title)).toEqual(['One'])
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
    expect(doc.nodes.map((n) => n.title).sort()).toEqual(['One', 'One (2)'])
    expect(doc.nodes.every((n) => n.state === 'TODO')).toBe(true)
    expect(doc.nodes.every((n) => n.levelOffset <= 1)).toBe(true)
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('passage code', () => {
  const doc = docFrom({ One: ['Two'], Two: [] })
  const [one, two] = [doc.nodes[0]!.id, doc.nodes[1]!.id]

  it('has no default', () => {
    expect(doc.nodes.every((n) => n.code === '')).toBe(true)
  })

  it('sets and trims a code', () => {
    const next = setCode(doc, one, '  A3 ').doc
    expect(next.nodes.find((n) => n.id === one)!.code).toBe('A3')
  })

  it('clears a code with an empty value', () => {
    const set = setCode(doc, one, 'A3').doc
    const cleared = setCode(set, one, '   ')
    expect(cleared.error).toBeNull()
    expect(cleared.doc.nodes.find((n) => n.id === one)!.code).toBe('')
  })

  it('rejects a duplicate, naming the passage that holds it', () => {
    const set = setCode(doc, one, 'A3').doc
    const clash = setCode(set, two, 'A3')
    expect(clash.error).toContain('One')
    expect(clash.doc).toBe(set)
  })

  it('treats codes differing only in case as the same code', () => {
    const set = setCode(doc, one, 'A3').doc
    expect(setCode(set, two, 'a3').error).not.toBeNull()
  })

  it('keeps the author\'s capitalisation', () => {
    const set = setCode(doc, one, 'a3').doc
    expect(set.nodes.find((n) => n.id === one)!.code).toBe('a3')
  })

  it('lets many passages have no code at once', () => {
    expect(setCode(doc, one, '').error).toBeNull()
    expect(setCode(doc, two, '').error).toBeNull()
  })

  it('returns the identical document for a no-op, protecting the undo stack', () => {
    const set = setCode(doc, one, 'A3').doc
    expect(setCode(set, one, 'A3').doc).toBe(set)
    expect(setCode(doc, one, '').doc).toBe(doc)
  })

  it('survives a save-file round trip', () => {
    const set = setCode(doc, one, 'A3').doc
    const back = parseDoc(serializeDoc(set)).doc
    expect(back.nodes.find((n) => n.id === one)!.code).toBe('A3')
    expect(serializeDoc(back)).toBe(serializeDoc(set))
  })

  it('loads a file that predates codes with every code empty', () => {
    const { doc: loaded, warnings } = parseDoc(
      JSON.stringify({ nodes: [{ id: '1', title: 'One', body: '' }] }),
    )
    expect(loaded.nodes[0]!.code).toBe('')
    expect(warnings).toEqual([])
  })

  it('clears a duplicated code in a hand-edited file, with a warning', () => {
    const { doc: loaded, warnings } = parseDoc(
      JSON.stringify({
        nodes: [
          { id: '1', title: 'One', body: '', code: 'A3' },
          { id: '2', title: 'Two', body: '', code: 'a3' },
        ],
      }),
    )
    const byTitle = new Map(loaded.nodes.map((n) => [n.title, n.code]))
    expect(byTitle.get('One')).toBe('A3')
    expect(byTitle.get('Two')).toBe('')
    expect(warnings.some((w) => w.includes('A3') || w.includes('a3'))).toBe(true)
  })
})
