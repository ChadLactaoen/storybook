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

  it('gains exactly one key per passage when re-saved, and nothing else', () => {
    const before = JSON.parse(LEGACY) as { nodes: Record<string, unknown>[] }
    const after = JSON.parse(serializeDoc(parseDoc(LEGACY).doc)) as {
      nodes: Record<string, unknown>[]
    }

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    after.nodes.forEach((node, i) => {
      const added = Object.keys(node).filter((k) => !(k in before.nodes[i]!))
      expect(added).toEqual(['isEnding'])
      expect(node.isEnding).toBe(false)
    })
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
  })
})
