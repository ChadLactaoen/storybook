import { describe, expect, it, vi } from 'vitest'
import { serializeDoc } from '../lib/doc/serialize'
import { layoutStory } from '../lib/graph/layout'
import { BIG_NODES, bigStory } from './fixtures/big-story'
import { docFrom, shuffled } from './helpers'

/**
 * The budget this file defends is the *typing* budget: what it costs to press
 * one key in a passage body on a story of a realistic size.
 *
 * Wall-clock in vitest is noisy, so the numbers here are coarse smoke budgets.
 * The assertions that actually protect against a regression are the counting
 * ones — how many times the pipeline runs, not how long it takes.
 */
describe('the big-story fixture', () => {
  const doc = bigStory()

  it('is the size it claims to be', () => {
    expect(doc.nodes.length).toBe(BIG_NODES)
    const prose = doc.nodes.reduce((n, x) => n + x.body.length, 0)
    expect(prose).toBeGreaterThan(150_000)
  })

  it('actually exercises the ordering sweeps', () => {
    const res = layoutStory(doc)
    // A tree seeds to zero crossings and `orderComponent` returns before the
    // sweep loop — which is exactly what the existing 255-node budget test
    // does, and why it never measured the stage that costs the most.
    expect(res.stats.crossings).toBeGreaterThan(0)
    expect(res.stats.layers).toBeGreaterThanOrEqual(16)
  })

  it('does not exceed the transpose bail-out width', () => {
    const res = layoutStory(doc)
    const perLayer = new Map<number, number>()
    for (const n of res.nodes) perLayer.set(n.layer, (perLayer.get(n.layer) ?? 0) + 1)
    // Over 200 and `transpose` skips itself entirely (graph/constants.ts),
    // which would make this fixture measure the wrong thing.
    expect(Math.max(...perLayer.values())).toBeLessThanOrEqual(200)
  })

  it('is deterministic under a shuffle, at a size that runs transpose', () => {
    const a = layoutStory(doc)
    for (let i = 0; i < 3; i++) {
      expect(layoutStory({ ...doc, nodes: shuffled(doc.nodes, i + 1) }).stats.hash).toBe(
        a.stats.hash,
      )
    }
  })
})

describe('layout cost', () => {
  it('lays the big story out inside the budget', () => {
    const doc = bigStory()
    layoutStory(doc) // warm
    const started = performance.now()
    layoutStory(doc)
    const ms = performance.now() - started
    console.log(`layoutStory(224 nodes): ${ms.toFixed(1)}ms`)
    // Was ~266ms before the transpose delta landed.
    expect(ms).toBeLessThan(80)
  })
})

/**
 * The assertions that actually defend the typing budget. They count pipeline
 * runs rather than milliseconds, so they mean the same thing on any machine.
 */
describe('typing in a body', () => {
  it('lays the story out for a link, and not for prose', async () => {
    vi.resetModules()
    const layoutMod = await import('../lib/graph/layout')
    const spy = vi.spyOn(layoutMod, 'layoutStory')
    const store = await import('../stores/story')

    store.loadStory(serializeDoc(bigStory()))
    const id = store.state.doc.nodes[40]!.id
    const original = store.state.doc.nodes[40]!.body

    spy.mockClear()
    const before = store.layoutVersion.value

    // Fifty characters of prose, one commit each, exactly as the editor sends them.
    for (let i = 1; i <= 50; i++) store.editBody(id, `${original} ${'x'.repeat(i)}`)

    expect(spy).not.toHaveBeenCalled()
    expect(store.layoutVersion.value).toBe(before)
    // The prose still reached the document; it is only the drawing that held.
    expect(store.state.doc.nodes.find((n) => n.id === id)!.body).toContain('x'.repeat(50))

    // A link is a different question, and must move the drawing exactly once.
    store.editBody(id, `${original}\n[[Somewhere new|P999]]`)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.layoutVersion.value).toBe(before + 1)
  })

  it('still notices a macro edit that moves no link', async () => {
    vi.resetModules()
    const store = await import('../stores/story')
    store.loadStory(serializeDoc(docFrom({ A: ['B'], B: [] }, { start: 'A' })))
    const a = store.state.doc.nodes[0]!.id
    store.editBody(a, '(set: $key to "yes")\n[[Go|P2]]')
    const first = store.gates.value
    const version = store.layoutVersion.value

    store.editBody(a, '(set: $key to "no")\n[[Go|P2]]')
    // No link moved, so no relayout — which is the point, and also the trap.
    expect(store.layoutVersion.value).toBe(version)
    // Gates must not be the stale map anyway.
    expect(store.gates.value).not.toBe(first)
  })
})

/**
 * Typing is one action to undo, not one per character.
 *
 * The counting matters as much as the behaviour: a hundred-deep history filled
 * with a hundred copies of one sentence being typed has effectively no history
 * in it, so the structural change the author actually wants back has already
 * fallen off the end.
 */
describe('undo through a run of typing', () => {
  const bodyOf = (store: typeof import('../stores/story'), id: string) =>
    store.state.doc.nodes.find((n) => n.id === id)!
  const load = async () => {
    vi.resetModules()
    const store = await import('../stores/story')
    store.loadStory(serializeDoc(docFrom({ A: ['B'], B: [] }, { start: 'A' })))
    return store
  }

  it('takes the whole run back at once, and leaves earlier actions reachable', async () => {
    const store = await load()
    const a = store.state.doc.nodes[0]!.id
    store.rename(a, 'Renamed')
    const before = bodyOf(store, a).body

    for (let i = 1; i <= 30; i++) store.editBody(a, `${before}${'y'.repeat(i)}`)

    // One press, thirty characters — the observable meaning of "one entry".
    store.undo()
    expect(bodyOf(store, a).body).toBe(before)
    // And the rename underneath the run is still there to undo.
    expect(bodyOf(store, a).title).toBe('Renamed')
    store.undo()
    expect(bodyOf(store, a).title).toBe('A')
  })

  it('starts a new entry when the author moves to another passage', async () => {
    const store = await load()
    const [a, b] = [store.state.doc.nodes[0]!.id, store.state.doc.nodes[1]!.id]
    store.editBody(a, 'first')
    store.select(b)
    store.editBody(b, 'second')

    // A run belongs to one passage, so this is two entries and not one.
    store.undo()
    expect(bodyOf(store, b).body).not.toBe('second')
    expect(bodyOf(store, a).body).toBe('first')
  })

  it('does not let a run swallow another kind of edit', async () => {
    const store = await load()
    const a = store.state.doc.nodes[0]!.id
    store.editBody(a, 'one')
    store.changeState(a, 'Done')
    store.editBody(a, 'one two')

    store.undo()
    // The typing after the state change comes back on its own...
    expect(bodyOf(store, a).body).toBe('one')
    expect(bodyOf(store, a).state).toBe('Done')
    store.undo()
    // ...and the state change is its own entry underneath it.
    expect(bodyOf(store, a).state).toBe('TODO')
  })
})

/**
 * A link's display text is not cosmetic to the memo.
 *
 * These assert the rendered strings rather than `stats.hash`, and have to: the
 * hash covers node coordinates and edge path data only, so a label left stale by
 * a too-narrow memo key would pass every hash-equality test in the suite while
 * the canvas showed the wrong caption.
 */
describe('the link signature', () => {
  const load = async (spec: Parameters<typeof docFrom>[0]) => {
    vi.resetModules()
    const store = await import('../stores/story')
    store.loadStory(serializeDoc(docFrom(spec, { start: Object.keys(spec)[0]! })))
    return store
  }

  it('notices a label change on a link to a real passage', async () => {
    const store = await load({ A: ['B'], B: [] })
    const a = store.state.doc.nodes[0]!.id
    store.editBody(a, '[[Old words|P2]]')
    expect(store.layout.value.edges.find((e) => e.label !== null)?.label).toBe('Old words')

    store.editBody(a, '[[New words|P2]]')
    expect(store.layout.value.edges.find((e) => e.label !== null)?.label).toBe('New words')
  })

  it('notices a label change on a link to a phantom, which names its card', async () => {
    const store = await load({ A: [] })
    const a = store.state.doc.nodes[0]!.id
    store.editBody(a, '[[Cave|Ghost]]')
    expect(store.layout.value.nodeById.get('phantom:Ghost')?.title).toBe('Cave')

    store.editBody(a, '[[Cavern|Ghost]]')
    expect(store.layout.value.nodeById.get('phantom:Ghost')?.title).toBe('Cavern')
  })

  it('notices two links swapping places', async () => {
    const store = await load({ A: ['B', 'C'], B: [], C: [] })
    const a = store.state.doc.nodes[0]!.id
    store.editBody(a, '[[one|P2]]\n[[two|P3]]')
    const first = store.layout.value.graph.edges.map((e) => e.targetCode)

    store.editBody(a, '[[two|P3]]\n[[one|P2]]')
    // Ordinals are positional, so reordering renumbers the edges even though the
    // set of targets is unchanged.
    expect(store.layout.value.graph.edges.map((e) => e.targetCode)).not.toEqual(first)
  })

  it('holds when prose moves a link without changing it', async () => {
    const store = await load({ A: ['B'], B: [] })
    const a = store.state.doc.nodes[0]!.id
    store.editBody(a, '[[Go|P2]]')
    const version = store.layoutVersion.value

    // Text inserted *ahead* of the link shifts its offset in the body. Nothing
    // structural moved, so nothing should be redrawn — which is only sound
    // because no offset is retained anywhere in the result.
    store.editBody(a, 'Some prose first.\n\n[[Go|P2]]')
    expect(store.layoutVersion.value).toBe(version)
    expect(store.layout.value.graph.edges).toHaveLength(1)
  })
})
