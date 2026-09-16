/**
 * Backwards compatibility with save files written before a field existed.
 *
 * `fixtures/legacy-v1.ts` is not hand-written: it was exported from the build that
 * shipped before `isEnding`, so it is exactly what an author's in-progress
 * story looks like on disk and in localStorage today. The point of these tests
 * is that upgrading must cost such an author nothing — no warning, no moved
 * number, no redrawn tree.
 */

import { describe, expect, it } from 'vitest'
import { importDoc } from '../lib/doc/file'
import { parseDoc, serializeDoc } from '../lib/doc/serialize'
import { layoutStory } from '../lib/graph/layout'
import { deriveGraph } from '../lib/graph/derive'
import { findBackEdges } from '../lib/graph/acyclic'
import { countPaths } from '../lib/graph/paths'
import { SLUG_MAX } from '../lib/doc/mutations'
import { LEGACY_V1 as LEGACY } from './fixtures/legacy-v1'
import { docFrom } from './helpers'

/**
 * Recorded from the pre-change build against this very file. If a change moves
 * either number, it has changed an existing author's story — which is the one
 * thing adding a field must never do.
 */
const BASELINE = { hash: '9406c897', layers: 3, routesFromStart: 3n }

describe('a save file written before endings existed', () => {
  it('does not mention the field at all', () => {
    expect(LEGACY).not.toContain('isEnding')
    expect(LEGACY).not.toContain('slug')
    // It predates the rename too, so it still spells the note `token`.
    expect(LEGACY).not.toContain('"note"')
  })

  it('loads without a single warning', () => {
    const { doc, warnings } = parseDoc(LEGACY)
    expect(warnings).toEqual([])
    expect(doc.nodes).toHaveLength(5)
    expect(doc.storyTitle).toBe('Test Story')
  })

  it('defaults every passage to not an ending', () => {
    const { doc } = parseDoc(LEGACY)
    expect(doc.nodes.every((n) => n.isEnding === false)).toBe(true)
  })

  it('defaults every passage to an empty slug', () => {
    const { doc } = parseDoc(LEGACY)
    expect(doc.nodes.every((n) => n.slug === '')).toBe(true)
  })

  it('imports as a file the same way it loads from storage', () => {
    const { doc, warnings } = importDoc(LEGACY)
    expect(warnings).toEqual([])
    expect(doc.nodes.every((n) => n.isEnding === false)).toBe(true)
  })

  it('draws exactly as it did before', () => {
    const { doc } = parseDoc(LEGACY)
    const l = layoutStory(doc)
    expect(l.stats.hash).toBe(BASELINE.hash)
    expect(l.stats.layers).toBe(BASELINE.layers)
  })

  it('counts exactly the routes it did before', () => {
    const { doc } = parseDoc(LEGACY)
    const g = deriveGraph(doc)
    const { backEdges } = findBackEdges(g, doc.startNodeId)
    expect(countPaths(g, backEdges, doc.startNodeId!)).toBe(BASELINE.routesFromStart)
  })

  it('gains exactly the keys added since, at their defaults, and nothing else', () => {
    const before = JSON.parse(LEGACY) as { nodes: Record<string, unknown>[] }
    const after = JSON.parse(serializeDoc(parseDoc(LEGACY).doc)) as {
      nodes: Record<string, unknown>[]
    }

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    after.nodes.forEach((node, i) => {
      const added = Object.keys(node).filter((k) => !(k in before.nodes[i]!))
      const gone = Object.keys(before.nodes[i]!).filter((k) => !(k in node))
      expect(added).toEqual(['isEnding', 'note', 'slug'])
      // `token` is not lost, it is renamed — the assertion below proves the
      // value came with it.
      expect(gone).toEqual(['token'])
      expect(node.isEnding).toBe(false)
    })
  })

  it('carries a note written under the old name across the rename', () => {
    // The fixture is the only pre-rename file the repo has, and one of its
    // passages carries a real note. That makes this a stronger guarantee than
    // any hand-written case: the value has to survive a read of a key the
    // current build never writes.
    expect(LEGACY).toContain('"token": "both roads meet"')
    const { doc, warnings } = parseDoc(LEGACY)
    expect(doc.nodes.map((n) => n.note).filter((t) => t.length > 0)).toEqual(['both roads meet'])
    expect(warnings).toEqual([])
  })
})

describe('a hand-edited isEnding', () => {
  function firstNode(value: unknown) {
    const { doc, warnings } = parseDoc(
      JSON.stringify({ nodes: [{ id: '1', code: 'P1', title: 'One', body: '', isEnding: value }] }),
    )
    return { node: doc.nodes[0]!, warnings }
  }

  it.each([
    ['the string "yes"', 'yes'],
    ['the number 1', 1],
    ['null', null],
    ['an object', {}],
    ['the string "false"', 'false'],
  ])('coerces %s to false without complaining', (_label, value) => {
    const { node, warnings } = firstNode(value)
    expect(node.isEnding).toBe(false)
    expect(warnings).toEqual([])
  })

  it('accepts only a real boolean true', () => {
    expect(firstNode(true).node.isEnding).toBe(true)
  })
})

describe('the default-empty endings set', () => {
  it('leaves countPaths meaning what it meant when called with three arguments', () => {
    // Marked endings that the caller never passes through must be invisible:
    // this is what keeps every pre-existing call site honest.
    const doc = docFrom({ A: ['B'], B: ['C'], C: [] }, { endings: ['B'] })
    const g = deriveGraph(doc)
    const { backEdges } = findBackEdges(g, doc.startNodeId)
    expect(countPaths(g, backEdges, doc.startNodeId!)).toBe(1n)
  })
})

describe('round-tripping with the field present', () => {
  it('re-saves byte-identically', () => {
    const doc = docFrom({ One: ['Two', 'Three'], Two: [], Three: [] }, { endings: ['Two'] })
    const once = serializeDoc(doc)
    expect(serializeDoc(parseDoc(once).doc)).toBe(once)
    expect(parseDoc(once).doc.nodes.find((n) => n.title === 'Two')!.isEnding).toBe(true)
  })

  it('emits the field even when false, or the round-trip would churn', () => {
    const doc = docFrom({ One: [] })
    expect(serializeDoc(doc)).toContain('"isEnding": false')
    // Same rule, and the reason `slug` is a required `string` rather than an
    // optional one: `JSON.stringify` drops `undefined`, so an absent key would
    // stop `parseDoc(serializeDoc(x))` round-tripping byte-identically.
    expect(serializeDoc(doc)).toContain('"slug": ""')
  })
})

describe('a hand-edited slug', () => {
  function firstNode(value: unknown) {
    const { doc, warnings } = parseDoc(
      JSON.stringify({ nodes: [{ id: '1', code: 'P1', title: 'One', body: '', slug: value }] }),
    )
    return { node: doc.nodes[0]!, warnings }
  }

  it.each([
    ['the number 1', 1],
    ['null', null],
    ['an object', {}],
    ['an array', []],
  ])('coerces %s to empty without complaining', (_label, value) => {
    const { node, warnings } = firstNode(value)
    expect(node.slug).toBe('')
    expect(warnings).toEqual([])
  })

  it('strips a reserved asterisk a hand-edited file slipped in', () => {
    // `setSlug` would never have written one, but nothing stops a text editor.
    // Loading it verbatim would put a literal `*` beside the ambiguity marker.
    expect(firstNode('a*b').node.slug).toBe('ab')
    expect(firstNode('a*b').warnings).toEqual([])
  })

  it('cuts an over-long slug to the cap on the way in', () => {
    expect(firstNode('a'.repeat(SLUG_MAX * 2)).node.slug).toBe('a'.repeat(SLUG_MAX))
  })

  it('re-serializes a repaired slug to itself', () => {
    // The repair has to land on a fixed point or the canonical-JSON invariant
    // breaks the first time a hand-edited file is saved twice.
    const { doc } = parseDoc(
      JSON.stringify({ nodes: [{ id: '1', code: 'P1', body: '', slug: '  a*b  ' }] }),
    )
    const once = serializeDoc(doc)
    expect(serializeDoc(parseDoc(once).doc)).toBe(once)
  })
})
