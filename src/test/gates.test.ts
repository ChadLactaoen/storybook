import { describe, expect, it } from 'vitest'
import { findBackEdges } from '../lib/graph/acyclic'
import { deriveGraph } from '../lib/graph/derive'
import { assignLevels } from '../lib/graph/layering'
import { readStoryMacros } from '../lib/harlowe/macros'
import { reachableFrom } from '../lib/graph/reachability'
import type { GateEntry } from '../lib/graph/gates'
import { gatesOf } from '../lib/graph/gates'
import type { StoryDoc } from '../types/story'
import { docFrom } from './helpers'

/**
 * Gates, wired the way the store wires them.
 *
 * Bodies carry the `(set:)`/`(if:)` macros; `docFrom` only writes plain links,
 * so a test supplies them through `bodies`.
 */
function gated(doc: StoryDoc, bodies: Record<string, string>): Record<string, GateEntry> {
  const withMacros: StoryDoc = {
    ...doc,
    nodes: doc.nodes.map((n) => (bodies[n.title] ? { ...n, body: bodies[n.title]! } : n)),
  }
  const g = deriveGraph(withMacros)
  const { backEdges } = findBackEdges(g, withMacros.startNodeId)
  const offsets = new Map(withMacros.nodes.map((n) => [n.id, n.levelOffset]))
  const lv = assignLevels(g, backEdges, (id) => offsets.get(id) ?? 0)
  const { guardOf, assignersOf, opaqueVars } = readStoryMacros(withMacros.nodes)

  const reach = new Map<string, Set<string>>()
  const isAncestor = (gate: string, node: string) => {
    let seen = reach.get(gate)
    if (!seen) {
      seen = reachableFrom(g, gate)
      reach.set(gate, seen)
    }
    return seen.has(node)
  }

  const out = gatesOf(g, {
    backEdges,
    levelOf: lv.level,
    guardOf,
    assignersOf,
    opaqueVars,
    isAncestor,
  })
  const byName: Record<string, GateEntry> = {}
  for (const id of g.ids) {
    const node = withMacros.nodes.find((n) => n.id === id)
    byName[node ? node.title : g.codeOf.get(id)!] = out.get(id)!
  }
  return byName
}

/**
 * The shape conditional links create: two early choices, a middle both reach,
 * and a late passage each early choice locks in.
 *
 * Levels: Start 1, Pick* 2, Mid* 3, End* 4. Every Mid links to both Ends, so
 * the link graph alone says four routes reach each End. The macros say two.
 */
const SPEC = {
  Start: ['PickP', 'PickQ'],
  PickP: ['MidA', 'MidB'],
  PickQ: ['MidA', 'MidB'],
  MidA: ['EndP', 'EndQ'],
  MidB: ['EndP', 'EndQ'],
  EndP: [],
  EndQ: [],
}
/** `docFrom` codes passages P1..Pn in declaration order. */
const CHAIN = '(if:$idol is "p")[[On|P6]]\n(else-if:$idol is "q")[[On|P7]]'
const SETTERS = {
  PickP: '[[A|P4]]\n[[B|P5]]\n(set:$idol to "p")',
  PickQ: '[[A|P4]]\n[[B|P5]]\n(set:$idol to "q")',
}
const GATED = { ...SETTERS, MidA: CHAIN, MidB: CHAIN }

describe('gates inferred from conditional links', () => {
  const doc = docFrom(SPEC)
  const idOf = (title: string) => doc.nodes.find((n) => n.title === title)!.id

  it('names the early choice a condition locks a passage to', () => {
    // The link graph alone says four routes reach each End and cannot tell that
    // picking P is what decides which End you arrive at.
    const out = gated(doc, GATED)
    expect(out.EndP!.gateId).toBe(idOf('PickP'))
    expect(out.EndQ!.gateId).toBe(idOf('PickQ'))
  })

  it('infers nothing when nothing is conditional', () => {
    expect(gated(doc, {}).EndP!.gateId).toBeNull()
  })

  it('refuses a gate when one route in is unguarded', () => {
    // MidB links to EndP with no condition, so a reader can arrive having
    // picked either — the gate would be claiming something untrue.
    expect(gated(doc, { ...GATED, MidB: '[[On|P6]]\n[[On|P7]]' }).EndP!.gateId).toBeNull()
  })

  it('refuses a gate when two passages set the same value', () => {
    const out = gated(doc, { ...GATED, PickQ: '[[A|P4]]\n[[B|P5]]\n(set:$idol to "p")' })
    expect(out.EndP!.gateId).toBeNull()
  })

  it('refuses a gate when something writes the variable unreadably', () => {
    // `(put:)` reverses its operands and this parser declines to read it. One
    // unseen write means a route exists that never passed the assumed gate.
    const out = gated(doc, { ...GATED, MidA: `(put: "p" into $idol)${'\n'}${CHAIN}` })
    expect(out.EndP!.gateId).toBeNull()
  })

  it('refuses a gate when the variable is reassigned further down', () => {
    const out = gated(doc, { ...GATED, MidB: `(set:$idol to "p")${'\n'}${CHAIN}` })
    expect(out.EndP!.gateId).toBeNull()
  })

  it('refuses a gate when a loop offers an unguarded way in', () => {
    // `Loop -> X` is classified as a back edge, but that is a layering
    // artefact: `Start -> Loop -> X` is an ordinary route a reader can take,
    // and it never passes the setter. Counting only forward edges would name
    // a gate every looping reader disproves.
    const looped = docFrom({ Start: ['Pick', 'Loop'], Pick: ['X'], X: ['Loop'], Loop: ['X'] })
    const out = gated(looped, { Pick: '(set:$idol to "p")\n(if:$idol is "p")[[On|P3]]' })
    expect(out.X!.gateId).toBeNull()
  })

  it('refuses a gate whose setter cannot reach the passage', () => {
    // The only setter of "z" sits in its own component, so no route here has
    // ever passed it — splicing its tokens in would describe an impossible run.
    const island = docFrom({ ...SPEC, Island: [] })
    const out = gated(island, {
      ...GATED,
      Island: '(set:$idol to "z")',
      MidA: '(if:$idol is "z")[[On|P6]]',
      MidB: '(if:$idol is "z")[[On|P6]]',
    })
    expect(out.EndP!.gateId).toBeNull()
  })

  it('reports a passage no route can satisfy as unreachable', () => {
    // The classic version of this is a mistyped literal: the branch is dead in
    // the played story and nothing else in the tool would say so.
    const typo = '(if:$idol is "P")[[On|P6]]'
    const out = gated(doc, { ...GATED, MidA: typo, MidB: typo })
    expect(out.EndP!.dead).toBe(true)
    // "Dead" is a proof, not a shrug: an unprovable case reports `dead: false`.
    expect(out.EndQ!.dead).toBe(false)
  })

  it('composes with the gate of its own gate', () => {
    // An extra level above shifts every level, and the gate still resolves —
    // nothing about it depends on where in the story the pair happens to sit.
    const deep = docFrom({ Open: ['Start'], ...SPEC }, { start: 'Open' })
    const out = gated(deep, {
      PickP: '[[A|P5]]\n[[B|P6]]\n(set:$idol to "p")',
      PickQ: '[[A|P5]]\n[[B|P6]]\n(set:$idol to "q")',
      MidA: '(if:$idol is "p")[[On|P7]]\n(else-if:$idol is "q")[[On|P8]]',
      MidB: '(if:$idol is "p")[[On|P7]]\n(else-if:$idol is "q")[[On|P8]]',
    })
    expect(out.EndP!.gateId).toBe(deep.nodes.find((n) => n.title === 'PickP')!.id)
  })
})
