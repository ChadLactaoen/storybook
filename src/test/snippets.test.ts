/**
 * Snippets: passages on level 0, outside the tree, shown inside others with
 * `(display:)`.
 *
 * One file for the concern rather than one per module it touches, because the
 * rules only make sense together: a snippet is left out of the graph, so it
 * cannot be reached, so nothing may call it unreachable; it cannot link, so a
 * link in it is no edge, so the reader shows it as words. Each half of those
 * pairs is asserted here beside the other.
 */

import { describe, expect, it } from 'vitest'
import * as M from '../lib/doc/mutations'
import { parseDoc, serializeDoc } from '../lib/doc/serialize'
import { docFromSkeleton, serializeSkeleton, skeletonOf } from '../lib/doc/skeleton'
import { COMPACT_CONFIG, DEFAULT_CONFIG } from '../lib/graph/constants'
import { importDoc } from '../lib/doc/file'
import { deriveGraph } from '../lib/graph/derive'
import { authoredIn, authoredOut } from '../lib/graph/paths'
import { layoutStory } from '../lib/graph/layout'
import { planRecode, type RecodeOptions } from '../lib/graph/recode'
import { computeStoryStats, displayedWords, wordCount } from '../lib/graph/stats'
import { computeTagStats } from '../lib/graph/tags'
import type { LayoutResult } from '../lib/graph/types'
import { insertDisplay } from '../lib/harlowe/format'
import {
  buildDisplay,
  DISPLAY_BUDGET,
  DISPLAY_DEPTH,
  displayClosure,
  displayCode,
  parseDisplays,
  quoteString,
  readStoryMacros,
  remapDisplays,
  stringValue,
} from '../lib/harlowe/macros'
import { renderPassage, type RunResult } from '../lib/harlowe/run'
import { assemble } from '../lib/publish/html'
import {
  buildPayload,
  indexPayload,
  openPassage,
  partitionNodes,
  PublishError,
  startOf,
} from '../lib/publish/payload'
import type { StoryDoc } from '../types/story'
import { emptyDoc } from '../types/story'
import { deepFreeze, docFrom, shuffled } from './helpers'

const idOf = (doc: StoryDoc, title: string) => doc.nodes.find((n) => n.title === title)!.id
const nodeOf = (doc: StoryDoc, title: string) => doc.nodes.find((n) => n.title === title)!

function setBody(doc: StoryDoc, title: string, body: string): void {
  nodeOf(doc, title).body = body
}

/**
 * A small story with two snippets appended, so every story passage keeps the
 * code it would have without them: P1..P4 are the story, P5 and P6 snippets.
 */
function story(opts: { codes?: Record<string, string> } = {}): StoryDoc {
  return docFrom(
    { Start: ['Left', 'Right'], Left: ['End'], Right: ['End'], End: [], Weather: [], Status: [] },
    { snippets: ['Weather', 'Status'], codes: opts.codes },
  )
}

/** The same story with the snippets gone. */
function bare(): StoryDoc {
  return docFrom({ Start: ['Left', 'Right'], Left: ['End'], Right: ['End'], End: [] })
}

/* ------------------------------------------------------------------ model */

describe('a snippet in the document', () => {
  it('is never made the start, even of an empty story', () => {
    const { doc, node } = M.createNode(emptyDoc('T'), { isSnippet: true })
    expect(node.isSnippet).toBe(true)
    expect(doc.startNodeId).toBeNull()
    const { doc: next, node: first } = M.createNode(doc)
    expect(first.isSnippet).toBe(false)
    expect(next.startNodeId).toBe(first.id)
  })

  it('is never given a code a dangling link names', () => {
    const doc = docFrom({ Start: ['P2'] })
    const { node } = M.createNode(doc, { isSnippet: true })
    expect(node.code).toBe('P3')
    // An ordinary passage still takes it, which is how a link written ahead of
    // its passage gets one.
    expect(M.createNode(doc).node.code).toBe('P2')
  })

  it('is passed over when the start is deleted', () => {
    const doc = docFrom({ Snip: [], Start: ['End'], End: [] }, { snippets: ['Snip'] })
    expect(doc.startNodeId).toBe(idOf(doc, 'Start'))
    const next = M.deleteNodes(doc, [idOf(doc, 'Start')])
    expect(next.startNodeId).toBe(idOf(doc, 'End'))
  })

  it('cannot be made the start', () => {
    const doc = story()
    expect(M.setStartNode(doc, idOf(doc, 'Weather'))).toBe(doc)
  })

  it('is refused for the start, a passage with links, and one something links to', () => {
    const doc = story()
    for (const title of ['Start', 'Left', 'End']) {
      const { doc: next, error } = M.setSnippet(doc, idOf(doc, title), true)
      expect(error).not.toBeNull()
      expect(next).toBe(doc)
    }
    expect(M.snippetBlocker(doc, idOf(doc, 'Start'))).toMatch(/start/)
    expect(M.snippetBlocker(doc, idOf(doc, 'Left'))).toMatch(/cannot link/)
    expect(M.snippetBlocker(doc, idOf(doc, 'End'))).toMatch(/"Left", "Right" link to it/)
  })

  it('clears the ending mark and level nudge when made, and always unmakes', () => {
    const doc = docFrom({ Start: [], Lone: [] }, { endings: ['Lone'], offsets: { Lone: 1 } })
    const { doc: made, error } = M.setSnippet(doc, idOf(doc, 'Lone'), true)
    expect(error).toBeNull()
    expect(nodeOf(made, 'Lone')).toMatchObject({ isSnippet: true, isEnding: false, levelOffset: 0 })
    // Unchanged is the same document, so `commit` pushes nothing.
    expect(M.setSnippet(made, idOf(doc, 'Lone'), true).doc).toBe(made)

    // Unmaking is allowed whatever the snippet holds — even a link typed since.
    setBody(made, 'Lone', '[[Out|P1]]')
    const back = M.setSnippet(made, idOf(doc, 'Lone'), false)
    expect(back.error).toBeNull()
    expect(nodeOf(back.doc, 'Lone').isSnippet).toBe(false)
  })

  it('is skipped by the ending and level batches', () => {
    const doc = story()
    const snip = idOf(doc, 'Weather')
    expect(M.setEndingMany(doc, [snip], true)).toBe(doc)
    expect(M.setLevelOffsetMany(doc, [snip], 1)).toBe(doc)
    const mixed = M.setEndingMany(doc, [snip, idOf(doc, 'End')], true)
    expect(nodeOf(mixed, 'End').isEnding).toBe(true)
    expect(nodeOf(mixed, 'Weather').isEnding).toBe(false)
  })

  it('creates nothing from the links written in it', () => {
    const doc = story()
    setBody(doc, 'Weather', '[[A new place]]')
    expect(M.resolveLinks(doc, idOf(doc, 'Weather'), '')).toBe(doc)
  })

  it('carries its displays through a recode, as one permutation', () => {
    const doc = story()
    setBody(doc, 'Start', `(display: "P5")(display: 'P6')(display: $x)(display: "Nowhere")`)
    // Swap the two snippets' codes: pairs applied one at a time would move a
    // display an earlier pair had already rewritten.
    const { doc: next, error } = M.recodeAll(
      doc,
      new Map([
        [idOf(doc, 'Weather'), 'P6'],
        [idOf(doc, 'Status'), 'P5'],
      ]),
    )
    expect(error).toBeNull()
    expect(nodeOf(next, 'Start').body).toBe(
      `(display: "P6")(display: 'P5')(display: $x)(display: "Nowhere")`,
    )
  })

  it('carries a display through setCode, escaping a code that holds a quote', () => {
    const doc = story()
    setBody(doc, 'Start', `A (display: "P5") and (display: 'P5').`)
    const { doc: next, error } = M.setCode(doc, idOf(doc, 'Weather'), `Sky"'s\\`)
    expect(error).toBeNull()
    const body = nodeOf(next, 'Start').body
    expect(parseDisplays(body).map((d) => d.code)).toEqual([`Sky"'s\\`, `Sky"'s\\`])
  })

  it('leaves its input untouched', () => {
    const doc = story()
    const before = serializeDoc(doc)
    deepFreeze(doc)
    expect(() => M.setSnippet(doc, idOf(doc, 'Weather'), false)).not.toThrow()
    expect(() => M.createNode(doc, { isSnippet: true })).not.toThrow()
    const lone = docFrom({ Start: [], Lone: [] })
    deepFreeze(lone)
    expect(() => M.setSnippet(lone, idOf(lone, 'Lone'), true)).not.toThrow()
    expect(serializeDoc(doc)).toBe(before)
  })
})

describe('a snippet in a save file', () => {
  it('defaults to false, silently, when the file predates it', () => {
    const json = JSON.stringify({ nodes: [{ id: '1', code: 'P1', title: 'One', body: '' }] })
    const { doc, warnings } = parseDoc(json)
    expect(doc.nodes[0]!.isSnippet).toBe(false)
    expect(warnings).toEqual([])
    expect(serializeDoc(doc)).toContain('"isSnippet": false')
  })

  it('round-trips byte-identically', () => {
    const doc = story()
    const once = serializeDoc(parseDoc(serializeDoc(doc)).doc)
    expect(serializeDoc(parseDoc(once).doc)).toBe(once)
    expect(parseDoc(once).doc.nodes.filter((n) => n.isSnippet)).toHaveLength(2)
  })

  it('repairs a start that is a snippet by unflagging it', () => {
    const json = JSON.stringify({
      startNodeId: '1',
      nodes: [
        { id: '1', code: 'P1', title: 'One', body: '', isSnippet: true },
        { id: '2', code: 'P2', title: 'Two', body: '' },
      ],
    })
    const { doc, warnings } = parseDoc(json)
    expect(doc.startNodeId).toBe('1')
    expect(doc.nodes[0]!.isSnippet).toBe(false)
    expect(warnings.join(' ')).toMatch(/both the start and a snippet/)
  })

  it('never falls back to a snippet for a missing start', () => {
    const json = JSON.stringify({
      nodes: [
        { id: '1', code: 'P1', title: 'One', body: '', isSnippet: true },
        { id: '2', code: 'P2', title: 'Two', body: '' },
      ],
    })
    expect(parseDoc(json).doc.startNodeId).toBe('2')
  })

  it('clears an ending mark or level nudge a snippet cannot have', () => {
    const json = JSON.stringify({
      startNodeId: '2',
      nodes: [
        { id: '1', code: 'P1', title: 'One', body: '', isSnippet: true, isEnding: true, levelOffset: 1 },
        { id: '2', code: 'P2', title: 'Two', body: '' },
      ],
    })
    const { doc, warnings } = parseDoc(json)
    expect(doc.nodes[0]).toMatchObject({ isSnippet: true, isEnding: false, levelOffset: 0 })
    expect(warnings).toHaveLength(1)
  })

  it('reaches a skeleton, which redraws identically', () => {
    const doc = story()
    const back = docFromSkeleton(JSON.parse(serializeSkeleton(skeletonOf(doc))))
    expect(back.nodes.filter((n) => n.isSnippet)).toHaveLength(2)
    expect(layoutStory(back).stats.hash).toBe(layoutStory(doc).stats.hash)
  })
})

/* ------------------------------------------------------------------ graph */

describe('a snippet in the graph', () => {
  it('is in no list the pipeline walks, yet its code still resolves', () => {
    const doc = story()
    const g = deriveGraph(doc)
    const snips = [idOf(doc, 'Weather'), idOf(doc, 'Status')]
    for (const id of snips) {
      expect(g.ids).not.toContain(id)
      expect(g.byId.has(id)).toBe(false)
    }
    expect(g.snippetIds).toEqual(snips)
    expect(g.idByCode.get('P5')).toBe(snips[0])
  })

  it('makes no edge and no phantom of a link in it or to it', () => {
    const doc = story()
    setBody(doc, 'Weather', '[[Out|P1]] and [[Ghost]]')
    setBody(doc, 'End', 'The end. [[Peek|P6]]')
    const g = deriveGraph(doc)
    expect(g.phantoms).toEqual([])
    expect(g.edges.some((e) => e.sourceId === idOf(doc, 'Weather'))).toBe(false)
    expect(g.edges.some((e) => e.targetCode === 'P6')).toBe(false)
    expect(g.snippetLinks.map((l) => [l.kind, l.targetCode])).toEqual([
      ['to', 'P6'],
      ['in', 'P1'],
      ['in', 'Ghost'],
    ])
  })

  it('keeps edge ordinals as parseLinks gives them past a skipped link', () => {
    const doc = story()
    setBody(doc, 'Start', '[[Peek|P5]]\n[[L|P2]]')
    const g = deriveGraph(doc)
    expect(g.edges.filter((e) => e.sourceId === idOf(doc, 'Start')).map((e) => e.id)).toEqual([
      `${idOf(doc, 'Start')}|1`,
    ])
  })
})

/* ------------------------------------------------------------------ layout */

function storyGeometry(res: LayoutResult) {
  return {
    nodes: res.nodes
      .filter((n) => !n.isSnippet)
      .map((n) => `${n.id}:${n.x}:${n.y}:${n.level}:${n.layer}:${n.order}`)
      .sort(),
    edges: res.edges.map((e) => `${e.edgeId}:${e.d}`),
    layers: res.stats.layers,
  }
}

describe('a snippet on the canvas', () => {
  it('moves no story card, in any packing or scale', () => {
    for (const packing of ['balanced', 'aligned', 'straight'] as const) {
      for (const scale of [DEFAULT_CONFIG, COMPACT_CONFIG]) {
        const cfg = { ...scale, packing }
        // Codes that sort before the story's, too: canonical order is code order.
        for (const doc of [story(), story({ codes: { Weather: 'A1', Status: 'A2' } })]) {
          expect(storyGeometry(layoutStory(doc, cfg))).toEqual(storyGeometry(layoutStory(bare(), cfg)))
        }
      }
    }
  })

  it('sits on a level-0 row above the story, in code order, centred over the start', () => {
    const doc = story({ codes: { Weather: 'S2', Status: 'S1' } })
    const res = layoutStory(doc)
    const row = res.nodes.filter((n) => n.isSnippet).sort((a, b) => a.x - b.x)
    expect(row.map((n) => n.code)).toEqual(['S1', 'S2'])
    const cfg = DEFAULT_CONFIG
    for (const [i, n] of row.entries()) {
      expect(n).toMatchObject({ level: 0, layer: -1, order: i, isPhantom: false })
      expect(n.y).toBe(cfg.margin - cfg.layerSpacing + cfg.nodeHeight / 2)
    }
    expect(row[1]!.x - row[0]!.x).toBe(cfg.nodeWidth + cfg.nodeGap)
    const start = res.nodeById.get(doc.startNodeId!)!
    expect((row[0]!.x + row[1]!.x) / 2).toBe(start.x)
    expect(Math.max(...row.map((n) => n.y))).toBeLessThan(
      Math.min(...res.nodes.filter((n) => !n.isSnippet).map((n) => n.y)),
    )
  })

  it('stays over the start on a wide story, not over its left edge', () => {
    // A fragment whose codes sort first is packed leftmost, so the start sits
    // well to the right of x = 0 — where the row used to begin.
    const doc = docFrom(
      {
        Start: ['A', 'B', 'C', 'D'],
        A: [],
        B: [],
        C: [],
        D: [],
        Aside: ['Aside2', 'Aside3', 'Aside4'],
        Aside2: [],
        Aside3: [],
        Aside4: [],
        Snip: [],
      },
      { snippets: ['Snip'], codes: { Aside: 'A1', Aside2: 'A2', Aside3: 'A3', Aside4: 'A4' } },
    )
    const res = layoutStory(doc)
    const start = res.nodeById.get(doc.startNodeId!)!
    const snip = res.nodes.find((n) => n.isSnippet)!
    expect(start.x).toBeGreaterThan(DEFAULT_CONFIG.nodeWidth)
    expect(snip.x).toBe(start.x)
  })

  it('centres on the story when there is no start', () => {
    const doc = story()
    doc.startNodeId = null
    const res = layoutStory(doc)
    const xs = res.nodes.filter((n) => !n.isSnippet).map((n) => n.x)
    const row = res.nodes.filter((n) => n.isSnippet).map((n) => n.x)
    expect((Math.min(...row) + Math.max(...row)) / 2).toBe((Math.min(...xs) + Math.max(...xs)) / 2)
  })

  it('adds a level-0 band only while a snippet exists', () => {
    expect(layoutStory(story()).levels[0]).toMatchObject({ level: 0, count: 2 })
    expect(layoutStory(bare()).levels.map((b) => b.level)).toEqual([1, 2, 3])
    expect(layoutStory(story()).levels.map((b) => b.level)).toEqual([0, 1, 2, 3])
  })

  it('is drawn the same for any order of the nodes', () => {
    const doc = story()
    const hash = layoutStory(doc).stats.hash
    for (const seed of [1, 2, 3, 4]) {
      expect(layoutStory({ ...doc, nodes: shuffled(doc.nodes, seed) }).stats.hash).toBe(hash)
    }
  })

  it('moves on the canvas when flagged, so the flag is structure', () => {
    const doc = docFrom({ Start: [], Lone: [] })
    const made = M.setSnippet(doc, idOf(doc, 'Lone'), true).doc
    expect(layoutStory(made).stats.hash).not.toBe(layoutStory(doc).stats.hash)
    expect(layoutStory(made).nodeById.get(idOf(doc, 'Lone'))!.level).toBe(0)
  })
})

/* ------------------------------------------------------------------ recode */

const NODE: RecodeOptions = { mode: 'node', prefix: 'P', separator: '' }
const LEVEL_NODE: RecodeOptions = { mode: 'levelNode', prefix: '', separator: 'N' }

function recoded(doc: StoryDoc, opts: RecodeOptions): StoryDoc {
  const plan = planRecode(layoutStory(doc), opts)
  const { doc: next, error } = M.recodeAll(doc, plan.mapping)
  expect(error).toBeNull()
  return next
}

describe('a snippet in a recode', () => {
  it('is numbered after the whole story, so the start keeps the first number', () => {
    const doc = story({ codes: { Weather: 'A1', Status: 'A2' } })
    const next = recoded(doc, NODE)
    expect(nodeOf(next, 'Start').code).toBe('P01')
    expect(nodeOf(next, 'Weather').code).toBe('P05')
    expect(nodeOf(next, 'Status').code).toBe('P06')
  })

  it('carries level 0 in level-and-node codes', () => {
    const next = recoded(story(), LEVEL_NODE)
    expect(nodeOf(next, 'Start').code).toBe('1N01')
    expect([nodeOf(next, 'Weather').code, nodeOf(next, 'Status').code]).toEqual(['0N01', '0N02'])
  })

  it('is a fixed point in both modes, however many snippets there are', () => {
    const spec: Record<string, string[]> = { Start: ['Left', 'Right'], Left: [], Right: [] }
    const snippets: string[] = []
    for (let i = 0; i < 12; i++) {
      spec[`Snip${i}`] = []
      snippets.push(`Snip${i}`)
    }
    // Codes that sort every which way against the story's own.
    const codes = Object.fromEntries(snippets.map((s, i) => [s, i % 2 === 0 ? `A${i}` : `Z${i}`]))
    const doc = docFrom(spec, { snippets, codes })
    for (const opts of [NODE, LEVEL_NODE]) {
      const once = recoded(doc, opts)
      expect(planRecode(layoutStory(once), opts).changed).toBe(0)
      expect(recoded(once, opts)).toEqual(once)
    }
  })

  it('takes its displays with it', () => {
    const doc = story({ codes: { Weather: 'A1', Status: 'A2' } })
    setBody(doc, 'End', 'Done. (display: "A2")')
    const next = recoded(doc, NODE)
    expect(nodeOf(next, 'End').body).toBe('Done. (display: "P06")')
  })
})

/* ------------------------------------------------------------------ macros */

describe('reading a (display:)', () => {
  it('finds each one with its code and exact spans', () => {
    const body = `A (display: "P5") b ( display : 'P\\'6' ) c (display: $x)`
    const found = parseDisplays(body)
    expect(found.map((d) => d.code)).toEqual(['P5', "P'6", null])
    for (const d of found) {
      expect(body.slice(d.macro.start, d.macro.end)).toMatch(/^\(\s*display\s*:.*\)$/)
    }
    expect(body.slice(found[0]!.literal!.start, found[0]!.literal!.end)).toBe('"P5"')
    expect(body.slice(found[1]!.literal!.start, found[1]!.literal!.end)).toBe(`'P\\'6'`)
    expect(found[2]!.literal).toBeNull()
  })

  it('ignores one inside a string, and finds one inside a hook or arguments', () => {
    expect(parseDisplays(`(set: $v to "(display: 'X')")`)).toEqual([])
    expect(parseDisplays(`(if: $v is "a")[(display: "X")]`).map((d) => d.code)).toEqual(['X'])
    expect(parseDisplays(`(either: (display: "X"), "b")`).map((d) => d.code)).toEqual(['X'])
    // Prose is not an argument list: Harlowe runs a macro in quoted prose.
    expect(parseDisplays(`She said "(display: 'X')"`).map((d) => d.code)).toEqual(['X'])
  })

  it('quotes a code so it reads back exactly', () => {
    for (const code of ['P7', `a"b`, `a'b`, 'a\\b', `\\"`]) {
      expect(stringValue(quoteString(code))).toBe(code)
      expect(stringValue(quoteString(code, "'"))).toBe(code)
      const macro = buildDisplay(code)
      expect(displayCode(macro.slice('(display:'.length, -1))).toBe(code)
    }
  })

  it('rewrites a permutation of codes in one pass', () => {
    const body = `(display: "A")(display: 'B')(display: "C")`
    const out = remapDisplays(body, new Map([['A', 'B'], ['B', 'A']]))
    expect(out).toBe(`(display: "B")(display: 'A')(display: "C")`)
    expect(remapDisplays('no macros here', new Map([['A', 'B']]))).toBe('no macros here')
  })

  it('closes over nested displays, once each, in code order', () => {
    const bodies: Record<string, string> = {
      B: 'b (display: "A")',
      A: 'a (display: "B") (display: "A")',
      C: 'never shown',
    }
    const resolve = (code: string) => bodies[code] ?? null
    expect(displayClosure('(display: "B") (display: "Z")', resolve)).toEqual([
      ['A', bodies.A],
      ['B', bodies.B],
    ])
  })

  it('inserts the macro after the selection, caret past it', () => {
    const out = insertDisplay({ text: 'Hello world', start: 0, end: 5 }, 'P5')
    expect(out.text).toBe('Hello(display: "P5") world')
    expect(out.start).toBe(out.end)
    expect(out.start).toBe('Hello(display: "P5")'.length)
  })
})

describe('what a display does to the macro reading', () => {
  const nodes = (...list: [string, string, boolean?][]) =>
    list.map(([code, body, isSnippet], i) => ({
      id: String(i + 1),
      code,
      body,
      isSnippet: isSnippet ?? false,
    }))

  it('makes every write in a snippet opaque, and never an assigner', () => {
    const m = readStoryMacros(nodes(['P1', 'x'], ['S1', '(set: $v to "a")(put: "b" into $w)', true]))
    expect([...m.opaqueVars].sort()).toEqual(['v', 'w'])
    expect(m.assignersOf.has('v')).toBe(false)
  })

  it("makes a displayed story passage's writes opaque", () => {
    const m = readStoryMacros(nodes(['P1', '(display: "P2")'], ['P2', '(set: $v to "a")']))
    expect(m.opaqueVars.has('v')).toBe(true)
  })

  it('makes every write opaque once any display cannot be read', () => {
    const m = readStoryMacros(
      nodes(['P1', '(set: $v to "a")'], ['P2', '(set: $w to "b")'], ['P3', '(display: $x)']),
    )
    expect([...m.opaqueVars].sort()).toEqual(['v', 'w'])
  })

  it('leaves everything else as it was', () => {
    const m = readStoryMacros(nodes(['P1', '(set: $v to "a")'], ['P2', '(display: "P9")']))
    expect(m.opaqueVars.size).toBe(0)
    expect(m.assignersOf.get('v')).toEqual([{ nodeId: '1', value: 'a' }])
  })
})

/* ------------------------------------------------------------------ reader */

/** The rendered prose as one string, `{name}` for an unread chip. */
function prose(result: RunResult): string {
  return result.blocks
    .map(
      (b) =>
        b.kind[0] +
        ':' +
        b.inlines
          .map((n) =>
            n.kind === 'text'
              ? n.text
              : n.kind === 'link'
                ? `[${n.label}->${n.target}]`
                : n.kind === 'variable'
                  ? `<${n.name}=${n.state === 'set' ? n.value : n.state}>`
                  : `{${n.name}}`,
          )
          .join(''),
    )
    .join(' ¶ ')
}

function show(
  body: string,
  displays: Record<string, string>,
  vars: [string, string | null][] = [],
  answers: string[] = [],
): RunResult {
  return renderPassage(body, new Map(vars), answers, new Map(Object.entries(displays)))
}

describe('the reader showing a snippet', () => {
  it('shows it in place, mid-line', () => {
    expect(prose(show('Before (display: "S") after.', { S: 'the middle' }))).toBe(
      'p:Before the middle after.',
    )
  })

  it('reads its markup, since Harlowe re-parses what it displays', () => {
    expect(prose(show('(display: "S")', { S: '> quoted' }))).toBe('q:quoted')
  })

  it('runs its (set:) for the passage around it', () => {
    const result = show('(display: "S")(if: $v is "x")[yes]', { S: '(set: $v to "x")' })
    expect(prose(result)).toBe('p:yes')
    expect(result.vars.get('$v')).toBe('x')
  })

  it('reads the variables the passage carries', () => {
    expect(prose(show('(display: "S")', { S: '(if: $v is "a")[A](else:)[B]' }, [['$v', 'b']]))).toBe(
      'p:B',
    )
  })

  it('renders one it may not show as unread', () => {
    for (const body of ['(display: "Nope")', '(display: $x)', '(display: "S" + "T")']) {
      const result = show(body, { S: 'never' })
      expect(prose(result)).toBe('p:{display}')
      expect(result.unsupported).toEqual(['display'])
    }
  })

  it('ends a cycle, and a chain too long or too wide', () => {
    expect(prose(show('(display: "A")', { A: 'a(display: "A")' }))).toBe('p:a{display}')
    expect(prose(show('(display: "A")', { A: 'a(display: "B")', B: 'b(display: "A")' }))).toBe(
      'p:ab{display}',
    )
    const deep: Record<string, string> = {}
    for (let i = 0; i < 20; i++) deep[`D${i}`] = `${i} (display: "D${i + 1}")`
    expect(show('(display: "D0")', deep).unsupported).toEqual(['display'])
    // Inside the depth limit, over the budget.
    const wide: Record<string, string> = {}
    for (let i = 0; i < 6; i++) wide[`W${i}`] = `(display: "W${i + 1}")`.repeat(3)
    wide.W6 = 'x'
    const flooded = show('(display: "W0")', wide)
    expect(flooded.unsupported).toEqual(['display'])
    expect(prose(flooded).split('x').length - 1).toBeLessThanOrEqual(DISPLAY_BUDGET)
  })

  it("shows a link in it as its words, leaving the passage's choices alone", () => {
    const result = show('[[A|P2]] (display: "S") [[B|P3]]', { S: 'go [[there|P9]]' })
    expect(prose(result)).toBe('p:[A->P2] go there [B->P3]')
    expect(result.choices.map((c) => [c.ordinal, c.target])).toEqual([
      [0, 'P2'],
      [1, 'P3'],
    ])
  })

  it('runs nothing behind a false condition, and doubts what is behind an unread one', () => {
    const snippet = { S: '(set: $w to "1")seen' }
    const hidden = show('(if: $v is "a")[(display: "S")]', snippet, [['$v', 'b']])
    expect(prose(hidden)).not.toContain('seen')
    expect(hidden.vars.has('$w')).toBe(false)

    const doubted = show('(if: $v > 3)[(display: "S")]', snippet, [['$v', '1']])
    expect(prose(doubted)).toContain('seen')
    const seen = doubted.blocks.flatMap((b) => b.inlines).find((n) => n.kind === 'text' && n.text.includes('seen'))
    expect(seen!.uncertain).toBe(true)
  })

  it('asks a prompt inside it, and resumes past it on the next render', () => {
    const snippet = { S: '(set: $name to (prompt: "Name?", "Ann"))Hi $name' }
    expect(show('(display: "S")', snippet).pending).not.toBeNull()
    const answered = show('(display: "S")', snippet, [], ['Bo'])
    expect(answered.pending).toBeNull()
    expect(prose(answered)).toBe('p:Hi <$name=Bo>')
  })

  it('takes formatting in from the passage and lets none out', () => {
    const inside = show("''(display: \"S\")''", { S: 'in' })
    const word = inside.blocks[0]!.inlines.find((n) => n.kind === 'text' && n.text === 'in')
    expect(word?.bold).toBe(true)

    const leaky = show('(display: "S") after', { S: "''open" })
    const after = leaky.blocks[0]!.inlines.find((n) => n.kind === 'text' && n.text.includes('after'))
    expect(after?.bold).toBe(false)
  })
})

/* ------------------------------------------------------------------ stats */

describe('a snippet in Story Stats', () => {
  it('is never flagged as unhealthy', () => {
    const doc = story()
    const s = computeStoryStats(doc, layoutStory(doc))
    const flagged = [
      ...s.lint.unreachable,
      ...s.lint.strandedBehindEnding,
      ...s.lint.unmarkedDeadEnds,
      ...s.lint.endingsWithLinks,
    ].map((e) => e.title)
    expect(flagged).not.toContain('Weather')
    expect(flagged).not.toContain('Status')
  })

  it('makes the story no deeper and no wider, but its words count', () => {
    const with_ = story()
    setBody(with_, 'Weather', 'Rain on the tin roof.')
    const a = computeStoryStats(with_, layoutStory(with_))
    const b = computeStoryStats(bare(), layoutStory(bare()))
    expect(a.shape).toEqual({ ...b.shape, snippets: 2 })
    expect(a.words.total).toBe(b.words.total + 5)
    expect(a.totalRoutes).toBe(b.totalRoutes)
  })

  it('counts a snippet on a route every time it is displayed, and once in the total', () => {
    // A straight path of three short passages, each displaying its own long
    // snippet: a playthrough reads all of it.
    const doc = docFrom(
      { A: ['B'], B: ['C'], C: [], SA: [], SB: [], SC: [] },
      { snippets: ['SA', 'SB', 'SC'] },
    )
    const long = Array.from({ length: 200 }, () => 'w').join(' ')
    for (const [host, code] of [['A', 'P4'], ['B', 'P5'], ['C', 'P6']] as const) {
      nodeOf(doc, host).body += ` (display: "${code}")`
    }
    for (const s of ['SA', 'SB', 'SC']) setBody(doc, s, long)
    const own = ['A', 'B', 'C'].reduce((sum, t) => sum + wordCount(nodeOf(doc, t).body), 0)

    const s = computeStoryStats(doc, layoutStory(doc))
    expect(s.playthrough.shortestWords).toBe(own + 600)
    expect(s.playthrough.longestWords).toBe(own + 600)
    expect(s.playthrough.meanWords).toBe(own + 600)
    expect(s.words.total).toBe(own + 600)

    // One snippet shown by all three: read three times, written once.
    for (const host of ['A', 'B', 'C']) {
      nodeOf(doc, host).body = nodeOf(doc, host).body.replace(/"P[56]"/, '"P4"')
    }
    const shared = computeStoryStats(doc, layoutStory(doc))
    expect(shared.playthrough.longestWords).toBe(own + 600)
    expect(shared.words.total).toBe(own + 600)
  })

  it('puts a snippet only on the routes that display it', () => {
    const doc = story()
    setBody(doc, 'Weather', 'Rain on the tin roof.')
    const before = computeStoryStats(doc, layoutStory(doc)).playthrough
    nodeOf(doc, 'Left').body += ' (display: "P5")'
    const after = computeStoryStats(doc, layoutStory(doc)).playthrough
    // Two tokens of macro on the Left route, and the five words it shows.
    expect(after.shortestWords).toBe(before.shortestWords)
    expect(after.longestWords).toBe(before.longestWords + 7)
  })

  it('names links in or to a snippet', () => {
    const doc = story()
    setBody(doc, 'Weather', '[[Out|P1]] [[Also|P2]]')
    setBody(doc, 'End', '[[Peek|P6]]')
    const rows = computeStoryStats(doc, layoutStory(doc)).lint.snippetLinks
    expect(rows.map((r) => [r.title, r.code, r.detail])).toEqual([
      ['End', 'P4', 'links to snippet P6'],
      ['Weather', 'P5', '2 links inside'],
    ])
  })

  it('names displays the reader cannot show, in snippets too', () => {
    const doc = story()
    setBody(doc, 'Start', '(display: "P5") (display: "P2") (display: "Nope")')
    setBody(doc, 'Status', '(display: $x)')
    const rows = computeStoryStats(doc, layoutStory(doc)).lint.brokenDisplays
    expect(rows.map((r) => [r.title, r.detail])).toEqual([
      ['Start', '"P2" is not a snippet; no passage "Nope"'],
      ['Status', 'not a quoted code'],
    ])
  })
})

describe("a snippet's words, as a reader meets them", () => {
  const shownBy = (snippets: Record<string, string>) =>
    displayedWords((code) => snippets[code] ?? null)

  it('counts each display, nested ones included', () => {
    const shown = shownBy({ S: 'one two', T: 'three (display: "S")' })
    expect(shown('(display: "S")')).toBe(2)
    expect(shown('(display: "S") (display: "S")')).toBe(4)
    // T's own three tokens, and the S it shows.
    expect(shown('(display: "T")')).toBe(3 + 2)
  })

  it('adds nothing for a display the reader will not show', () => {
    const shown = shownBy({ S: 'one two' })
    expect(shown('(display: "Nope") (display: $x)')).toBe(0)
    expect(shown('<!-- (display: "S") -->')).toBe(0)
  })

  it('refuses a loop, as the reader does', () => {
    const shown = shownBy({ S: 'one (display: "T")', T: 'two (display: "S")' })
    // S, then T, then S again is refused.
    expect(shown('(display: "S")')).toBe(3 + 3)
    // Read as displayed, a snippet cannot show itself even once more.
    expect(shownBy({ S: 'one (display: "S")' })('one (display: "S")', 'S')).toBe(0)
  })

  it('stops where the reader stops, at its depth and its budget', () => {
    const chain: Record<string, string> = {}
    for (let i = 1; i <= DISPLAY_DEPTH + 2; i++) chain[`S${i}`] = `w (display: "S${i + 1}")`
    expect(shownBy(chain)('(display: "S1")')).toBe(DISPLAY_DEPTH * 3)

    const many = '(display: "S") '.repeat(DISPLAY_BUDGET + 10)
    expect(shownBy({ S: 'one two' })(many)).toBe(DISPLAY_BUDGET * 2)
  })
})

describe('a snippet in the Tags panel', () => {
  it('counts as using a tag, and is not off route', () => {
    const doc = docFrom(
      { Start: [], Weather: [] },
      { snippets: ['Weather'], tags: { Weather: ['mood'] } },
    )
    const row = computeTagStats(doc, layoutStory(doc)).rows.find((r) => r.key === 'mood')!
    expect(row.passages).toBe(1)
    expect(row.offRoute).toBe(0)
    expect(row.levels.map((l) => l.level)).toEqual([0])
  })
})

/* ------------------------------------------------------------------ publish */

describe('a snippet in a published story', () => {
  const OPTS = { theme: 'folio' } as const

  it('ships no blob of its own and is not reported as left out', () => {
    const doc = story()
    const { shipped, excluded } = partitionNodes(doc)
    expect(shipped.map((n) => n.title).sort()).toEqual(['End', 'Left', 'Right', 'Start'])
    expect(excluded).toEqual([])
  })

  it('rides in the envelope of each passage that displays it', async () => {
    const doc = story()
    setBody(doc, 'Start', 'Weather: (display: "P5") [[L|P2]] [[R|P3]] (display: "P2")')
    setBody(doc, 'Weather', 'rain, and (display: "P6")')
    setBody(doc, 'Status', 'all well')
    const payload = await buildPayload(doc, OPTS)
    expect(payload.blobs).toHaveLength(4)
    const envelope = await openPassage(indexPayload(payload), indexPayload(payload).start)
    // The closure, in code order, and never a story passage.
    expect(envelope!.d).toEqual([
      ['P5', 'rain, and (display: "P6")'],
      ['P6', 'all well'],
    ])
  })

  it('carries no displays field for a passage that shows none', async () => {
    const doc = story()
    const lookup = indexPayload(await buildPayload(doc, OPTS))
    expect((await openPassage(lookup, lookup.start))!.d).toBeUndefined()
  })

  it('refuses to be where reading starts', () => {
    const doc = story()
    expect(() => startOf(doc, idOf(doc, 'Weather'))).toThrow(PublishError)
  })

  it('leaks nothing into the file', async () => {
    const doc = story({ codes: { Weather: 'Qzsky' } })
    setBody(doc, 'Start', '(display: "Qzsky") [[L|P2]]')
    setBody(doc, 'Weather', 'A mackerel sky over the harbour.')
    nodeOf(doc, 'Weather').title = 'Qztitle'
    const html = assemble(
      'var StoryboardPlayer=(function(){return{start:function(){}}})();',
      await buildPayload(doc, OPTS),
    )
    for (const secret of ['mackerel', 'harbour', 'Qzsky', 'Qztitle']) {
      expect(html.toLowerCase()).not.toContain(secret.toLowerCase())
    }
  })
})

/* ------------------------------------------------------------------ review */

/**
 * One regression per defect a review found, each named for what it protects
 * rather than for how it failed.
 */
describe('a snippet, at the edges', () => {
  it('gives a story with no start one, when a snippet becomes its passage', () => {
    const { doc } = M.createNode(emptyDoc('T'), { isSnippet: true })
    const id = doc.nodes[0]!.id
    const { doc: back } = M.setSnippet(doc, id, false)
    expect(back.startNodeId).toBe(id)
    // And the file round-trips: `parseDoc` has nothing left to repair.
    expect(parseDoc(serializeDoc(back)).doc.startNodeId).toBe(id)

    const s = story()
    expect(M.setSnippet(s, idOf(s, 'Weather'), false).doc.startNodeId).toBe(s.startNodeId)
  })

  it("mints in the story's own code shape, whatever a dangling link names", () => {
    const doc = docFrom({ Start: ['X9'], Two: [] }, { codes: { Start: 'T001', Two: 'T002' } })
    expect(M.createNode(doc, { isSnippet: true }).node.code).toBe('T003')
    const near = docFrom({ Start: ['T003'], Two: [] }, { codes: { Start: 'T001', Two: 'T002' } })
    expect(M.createNode(near, { isSnippet: true }).node.code).toBe('T004')
  })

  it('keeps the level an old file gave a snippet that had to become the start', () => {
    const json = JSON.stringify({
      startNodeId: '1',
      nodes: [{ id: '1', code: 'P1', title: 'One', body: '', isSnippet: true, level: 2 }],
    })
    const { doc } = importDoc(json)
    expect(doc.nodes[0]).toMatchObject({ isSnippet: false, levelOffset: 1 })
  })

  it('reads no display the reader would not run', () => {
    const codes = (body: string) => parseDisplays(body).map((d) => d.code)
    expect(codes('<!-- (display: "S") --> `(display: "T")` (display: "U")')).toEqual(['U'])
    expect(codes('``(display: "S")`` and (display: "T")')).toEqual(['T'])
    // A hook after a macro is prose again, comments and all.
    expect(codes('(if: $v is "a")[<!-- (display: "S") -->(display: "T")]')).toEqual(['T'])
    // An unclosed fence is literal backticks, not verbatim.
    expect(codes('a ` (display: "S")')).toEqual(['S'])
    // A comment marker inside a macro's string opens no comment.
    expect(codes('(set: $v to "<!--")(display: "S")(set: $w to "-->")')).toEqual(['S'])

    const nodes = [
      { id: '1', code: 'P1', isSnippet: false, body: '(set: $v to "a")' },
      { id: '2', code: 'P2', isSnippet: false, body: 'Later. <!-- (display: $x) -->' },
    ]
    // A disabled line does not switch off every gate in the story.
    expect(readStoryMacros(nodes).opaqueVars.size).toBe(0)
    // Nor does a recode rewrite what the author made literal.
    expect(remapDisplays('`(display: "A")` (display: "A")', new Map([['A', 'B']]))).toBe(
      '`(display: "A")` (display: "B")',
    )
  })

  it('never recodes a snippet onto a code a dangling link names', () => {
    const doc = docFrom({ Start: ['P02'], Snip: [] }, { snippets: ['Snip'] })
    const plan = planRecode(layoutStory(doc), NODE)
    expect(plan.captures).toEqual([])
    const next = recoded(doc, NODE)
    expect(nodeOf(next, 'Snip').code).toBe('P03')
    expect(deriveGraph(next).phantoms.map((p) => p.code)).toEqual(['P02'])
    expect(planRecode(layoutStory(next), NODE).changed).toBe(0)

    const level = docFrom({ Start: ['0N01'], Snip: [] }, { snippets: ['Snip'] })
    expect(nodeOf(recoded(level, LEVEL_NODE), 'Snip').code).toBe('0N02')
  })

  it('widens the numbers rather than land on a dangling code, and settles', () => {
    const doc = docFrom({ Start: [], Snip: [] }, { snippets: ['Snip'] })
    // Every two-digit code a snippet could take is named by a dangling link.
    setBody(
      doc,
      'Start',
      Array.from({ length: 98 }, (_, i) => `[[x|P${String(i + 2).padStart(2, '0')}]]`).join(' '),
    )
    const next = recoded(doc, NODE)
    expect(nodeOf(next, 'Start').code).toBe('P001')
    expect(nodeOf(next, 'Snip').code).toBe('P002')
    expect(planRecode(layoutStory(next), NODE).changed).toBe(0)
  })

  it('counts a link to a snippet as one the author wrote', () => {
    const doc = story()
    setBody(doc, 'End', '[[Peek|P6]]')
    const res = layoutStory(doc)
    expect(authoredOut(res.graph, idOf(doc, 'End'))).toBe(1)
    expect(authoredIn(res.graph, idOf(doc, 'Status'))).toBe(1)
    const s = computeStoryStats(doc, res)
    // Named once, for what it is — not also as a branch left unwritten.
    expect(s.lint.unmarkedDeadEnds.map((e) => e.title)).not.toContain('End')
    expect(s.lint.snippetLinks.map((e) => e.title)).toEqual(['End'])
  })

  it('names a display the reader will stop at: a loop, a nest too deep, a render too wide', () => {
    const lint = (spec: Record<string, string>) => {
      const titles = Object.keys(spec)
      const doc = docFrom(
        Object.fromEntries(titles.map((t) => [t, []])),
        { snippets: titles.filter((t) => t !== 'Start'), codes: Object.fromEntries(titles.map((t) => [t, t])) },
      )
      for (const t of titles) setBody(doc, t, spec[t]!)
      return Object.fromEntries(
        computeStoryStats(doc, layoutStory(doc)).lint.brokenDisplays.map((r) => [r.title, r.detail]),
      )
    }
    const loop = 'a display loops back on itself'
    expect(lint({ Start: '(display: "A")', A: '(display: "B")', B: '(display: "A")' })).toEqual({
      Start: loop,
      A: loop,
      B: loop,
    })
    expect(lint({ Start: 'x', A: '(display: "A")' })).toEqual({ A: loop })

    const deep: Record<string, string> = { Start: '(display: "D0")' }
    for (let i = 0; i <= DISPLAY_DEPTH; i++) deep[`D${i}`] = i < DISPLAY_DEPTH ? `(display: "D${i + 1}")` : 'x'
    expect(lint(deep).Start).toBe(`displays nest more than ${DISPLAY_DEPTH} deep`)
    delete deep.D8
    deep.D7 = 'x'
    expect(lint(deep).Start).toBeUndefined()

    // Seven deep, inside the limit, but three to a level: over a thousand displays.
    const wide: Record<string, string> = { Start: '(display: "W0")' }
    for (let i = 0; i < 6; i++) wide[`W${i}`] = `(display: "W${i + 1}")`.repeat(3)
    wide.W6 = 'x'
    expect(lint(wide).Start).toBe(`more than ${DISPLAY_BUDGET} displays`)
  })

  it('shows one snippet twice with its branches decided afresh each time', () => {
    const shown = show('(display: "S")(set: $v to "b")(display: "S")', { S: '(if: $v is "a")[A](else:)[B]' }, [
      ['$v', 'a'],
    ])
    expect(prose(shown)).toBe('p:AB')
  })

  it('reuses what it learned about a snippet across passages', () => {
    let calls = 0
    const bodies: Record<string, string> = { A: 'a (display: "B")', B: 'b' }
    const resolve = (code: string) => {
      calls++
      return bodies[code] ?? null
    }
    const memo = new Map<string, (string | null)[]>()
    displayClosure('(display: "A")', resolve, memo)
    expect(memo.get('A')).toEqual(['B'])
    expect(displayClosure('(display: "A")', resolve, memo)).toEqual([
      ['A', 'a (display: "B")'],
      ['B', 'b'],
    ])
    expect(calls).toBe(4)
  })
})
