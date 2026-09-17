// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref } from 'vue'
import type { App as VueApp } from 'vue'
import TraitList from '../components/TraitList.vue'
import {
  renameNode,
  renameSetting,
  setCode,
  setStartNode,
  setStoryTitle,
  setTagColor,
} from '../lib/doc/mutations'
import { deriveGraph } from '../lib/graph/derive'
import { serializeDoc } from '../lib/doc/serialize'
import * as store from '../stores/story'
import { docFrom } from './helpers'

/** Findings from the code review, pinned so they cannot come back. */

let app: VueApp | null = null
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  localStorage.clear()
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  app?.unmount()
  app = null
  host.remove()
  vi.restoreAllMocks()
})

describe('TraitList', () => {
  /**
   * Mount the list the way the sheet does: the parent owns the committed
   * array, so a change event round-trips through a new prop identity.
   */
  function mountList(initial: string[] = []) {
    const points = ref<string[]>(initial)
    app = createApp({
      components: { TraitList },
      setup: () => ({ points, onChange: (next: string[]) => (points.value = next) }),
      template: '<TraitList :points="points" @change="onChange" />',
    })
    app.mount(host)
    return points
  }

  const inputs = () => [...host.querySelectorAll<HTMLInputElement>('.point .field')]
  const addButton = () => host.querySelector<HTMLButtonElement>('.add')!

  async function type(el: HTMLInputElement, text: string) {
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
  }

  it('keeps the new blank row after committing the previous one', async () => {
    const points = mountList()

    addButton().click()
    await nextTick()
    await type(inputs()[0]!, 'Guarded')

    // Commit, then ask for another row — the prop round-trip must not eat it.
    inputs()[0]!.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    addButton().click()
    await nextTick()

    expect(points.value).toEqual(['Guarded'])
    expect(inputs()).toHaveLength(2)
    expect(inputs()[0]!.value).toBe('Guarded')
    expect(inputs()[1]!.value).toBe('')
  })

  it('does not discard a half-typed row when the parent commits elsewhere', async () => {
    const points = mountList(['Guarded'])

    addButton().click()
    await nextTick()
    await type(inputs()[1]!, 'Dry humour')

    // An unrelated commit gives the prop a new identity mid-edit.
    points.value = ['Guarded']
    await nextTick()

    expect(inputs()).toHaveLength(2)
    expect(inputs()[1]!.value).toBe('Dry humour')
  })

  it('keeps the appended row when Enter also fires a change event', async () => {
    const points = mountList()
    addButton().click()
    await nextTick()

    for (const text of ['Guarded', 'Dry humour']) {
      const el = inputs()[inputs().length - 1]!
      await type(el, text)
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      // A real browser fires `change` on Enter; jsdom does not, so replay it —
      // that second commit is exactly what used to swallow the new row.
      el.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
      await new Promise((r) => requestAnimationFrame(r))
      await nextTick()
    }

    expect(points.value).toEqual(['Guarded', 'Dry humour'])
    expect(inputs().map((i) => i.value)).toEqual(['Guarded', 'Dry humour', ''])
  })

  it('commits a reorder', async () => {
    const points = mountList(['A', 'B'])
    host.querySelectorAll<HTMLButtonElement>('.op')[3]!.click() // second row, up
    await nextTick()
    expect(points.value).toEqual(['B', 'A'])
  })
})

describe('mutations that should be no-ops', () => {
  it('returns the same document when nothing actually changes', () => {
    const doc = docFrom({ One: [] })
    // Each of these feeds commit(), whose `next === state.doc` guard is the
    // only thing keeping empty entries off the undo stack.
    expect(setStoryTitle(doc, doc.storyTitle)).toBe(doc)
    expect(setStartNode(doc, doc.startNodeId!)).toBe(doc)
    expect(setTagColor(doc, 'nope', 'none')).not.toBe(doc) // a genuine addition
    const tagged = setTagColor(doc, 'combat', 'red')
    expect(setTagColor(tagged, 'combat', 'red')).toBe(tagged)
  })

  it('refuses to blank out a setting through rename', () => {
    const doc = docFrom({ A: [], B: [] }, { settings: { A: 'Tavern', B: 'Tavern' } })
    // The parallel renameCharacter rejects an empty name; this must too,
    // rather than silently stripping the setting off every passage.
    expect(renameSetting(doc, 'Tavern', '   ')).toBe(doc)
    expect(renameSetting(doc, 'Tavern', 'The Anchor').nodes.every((n) => n.setting === 'The Anchor'))
      .toBe(true)
  })
})

describe('passage codes and link syntax', () => {
  it('refuses a code that would corrupt the links pointing at it', () => {
    const doc = docFrom({ North: [], Start: ['North'] })
    const id = doc.nodes.find((n) => n.title === 'North')!.id

    for (const bad of ['North->South', 'South<-North', 'North|South', 'North]]']) {
      const { doc: after, error } = setCode(doc, id, bad)
      expect(error).toMatch(/link/i)
      expect(after).toBe(doc)
    }
  })

  it('accepts the same strings as a title, which no link ever reads', () => {
    const doc = docFrom({ North: [], Start: ['North'] })
    const id = doc.nodes.find((n) => n.title === 'North')!.id
    const before = doc.nodes.find((n) => n.title === 'Start')!.body

    const after = renameNode(doc, id, 'North->South')
    expect(after.nodes.find((n) => n.id === id)!.title).toBe('North->South')
    // The parent's prose is untouched, so the link still resolves.
    expect(after.nodes.find((n) => n.title === 'Start')!.body).toBe(before)
    expect(deriveGraph(after).phantoms).toHaveLength(0)
  })
})

describe('store hygiene across stories', () => {
  it('clears filters and closes the sheet when a story is replaced', () => {
    store.newStory('First')
    store.characterCreate('Mira')
    store.openCharacterSheet('Mira')
    store.state.search = 'anything'
    store.toggleFilter('characterFilter', 'Mira')

    const json = serializeDoc(store.state.doc)
    store.loadStory(json)

    // Carrying a filter or an open sheet into a different document leaves the
    // whole tree dimmed, or a sheet describing a character who may not exist.
    expect(store.state.characterFilter).toEqual([])
    expect(store.state.search).toBe('')
    expect(store.state.openCharacter).toBeNull()
    expect(store.matches.value).toBeNull()
  })

  it('closes the sheet when undo removes the character it describes', () => {
    store.newStory('Undo Sheet')
    store.characterCreate('Mira')
    store.openCharacterSheet('Mira')

    store.undo()

    expect(store.characterMap.value.has('Mira')).toBe(false)
    expect(store.state.openCharacter).toBeNull()
  })

  it('treats a whitespace-only search as no filter at all', () => {
    store.newStory('Whitespace')
    store.state.search = '   '
    expect(store.matches.value).toBeNull()
    expect(store.filtering.value).toBe(false)
  })

  it('does not resurrect a discarded story through a pending autosave', async () => {
    store.newStory('Doomed')
    store.editBody(store.state.doc.nodes[0]!.id, 'edited')
    store.discardStory()

    await new Promise((r) => setTimeout(r, 400))
    expect(localStorage.getItem('storybook.story.v1')).toBeNull()
  })
})

describe('CharacterSheet reverse relations', () => {
  it('shows someone who regards this character even with nothing back', async () => {
    const { default: CharacterSheet } = await import('../components/CharacterSheet.vue')
    store.newStory('Reverse')
    store.characterCreate('Mira')
    store.characterCreate('Tam')
    // Tam regards Mira; Mira has recorded nothing about Tam.
    store.relationAdd('Tam', 'Mira')
    store.relationSetPoints('Tam', 'Mira', ['Afraid of her'])

    app = createApp(CharacterSheet, { name: 'Mira' })
    app.mount(host)
    await nextTick()

    const text = host.textContent ?? ''
    expect(text).toContain('Tam')
    expect(text).toContain('Afraid of her')
    // ...and it is offered as context, not as an editable relation of Mira's.
    expect(host.querySelector('.inbound-only')).not.toBeNull()
    expect(host.querySelectorAll('.relation:not(.inbound-only)')).toHaveLength(0)
  })

  it('does not duplicate a relation that exists in both directions', async () => {
    const { default: CharacterSheet } = await import('../components/CharacterSheet.vue')
    store.newStory('Reverse Both')
    store.characterCreate('Mira')
    store.characterCreate('Tam')
    store.relationAdd('Mira', 'Tam')
    store.relationSetPoints('Mira', 'Tam', ['Owes him nothing'])
    store.relationAdd('Tam', 'Mira')
    store.relationSetPoints('Tam', 'Mira', ['Afraid of her'])

    app = createApp(CharacterSheet, { name: 'Mira' })
    app.mount(host)
    await nextTick()

    expect(host.querySelectorAll('.inbound-only')).toHaveLength(0)
    expect(host.querySelector('.reverse')!.textContent).toContain('Afraid of her')
  })
})

describe('CharacterPicker error reporting', () => {
  it('surfaces a failed inline create instead of silently clearing the field', async () => {
    const { default: CharacterPicker } = await import('../components/CharacterPicker.vue')
    store.newStory('Picker')

    let picker: { setError: (m: string | null) => void } | null = null
    app = createApp({
      components: { CharacterPicker },
      setup: () => ({
        cast: [],
        roster: [],
        onCreate: () => picker?.setError('Nope.'),
        bind: (el: unknown) => (picker = el as typeof picker),
      }),
      template:
        '<CharacterPicker :ref="bind" :cast="cast" :roster="roster" @create="onCreate" />',
    })
    app.mount(host)
    await nextTick()

    const input = host.querySelector<HTMLInputElement>('.entry .field')!
    input.value = 'Mira'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()

    expect(host.querySelector('.hint-error')?.textContent).toContain('Nope.')
    // The typed name survives so it can be corrected.
    expect(host.querySelector<HTMLInputElement>('.entry .field')!.value).toBe('Mira')
  })
})

describe('the undo and redo buttons', () => {
  /**
   * `canUndo` was a computed over a plain array, so it had nothing reactive to
   * invalidate on: whatever it answered the first time it was read, it went on
   * answering forever. Both buttons were dimmed from mount and never lit, in
   * every build that had them.
   */
  it('light as soon as there is something to undo', () => {
    store.newStory('History Check')
    expect(store.canUndo.value).toBe(false)
    expect(store.canRedo.value).toBe(false)

    store.addPassage()
    expect(store.canUndo.value).toBe(true)
    expect(store.canRedo.value).toBe(false)

    store.undo()
    expect(store.canRedo.value).toBe(true)

    store.redo()
    expect(store.canRedo.value).toBe(false)
    expect(store.canUndo.value).toBe(true)
  })

  it('go dark again when a new story replaces the history', () => {
    store.newStory('History Check')
    store.addPassage()
    expect(store.canUndo.value).toBe(true)

    store.newStory('Another Story')
    expect(store.canUndo.value).toBe(false)
    expect(store.canRedo.value).toBe(false)
  })
})
