// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import type { App as VueApp } from 'vue'
import App from '../App.vue'
import * as store from '../stores/story'

/**
 * Mounts the real component tree against a DOM.
 *
 * Type checking can't see template-only mistakes (a missing `.value`, a prop
 * that doesn't exist, an event that's never handled), so this renders the app
 * for real and fails on any Vue warning or thrown error.
 */

let app: VueApp | null = null
let host: HTMLElement
let problems: string[] = []

beforeEach(() => {
  problems = []
  vi.spyOn(console, 'warn').mockImplementation((...args) => {
    problems.push(args.join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    problems.push(args.join(' '))
  })

  // jsdom has neither; the viewport composable and canvas measurement need them.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver

  host = document.createElement('div')
  document.body.appendChild(host)
  localStorage.clear()
  // The store is a module singleton; without this a filter set by one test
  // silently dims everything in the next.
  store.clearFilters()
  store.closeCharacterSheet()
})

afterEach(() => {
  app?.unmount()
  app = null
  host.remove()
  vi.restoreAllMocks()
})

function mount() {
  app = createApp(App)
  app.config.warnHandler = (msg) => problems.push(msg)
  app.mount(host)
}

/** What the editor does: type into the body, then leave the field. */
function writeBody(nodeId: string, body: string): void {
  const before = store.state.doc.nodes.find((n) => n.id === nodeId)!.body
  store.editBody(nodeId, body)
  store.resolveBody(nodeId, before)
}

describe('the app renders', () => {
  it('opens on the startup dialog when there is nothing saved', async () => {
    mount()
    await nextTick()
    expect(host.textContent).toContain('Storybook')
    expect(host.textContent).toContain('New story')
    expect(host.querySelector('.veil')).not.toBeNull()
    expect(problems).toEqual([])
  })

  it('draws the canvas, cards and edges once a story exists', async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    writeBody(startId, '[[Two]]\n[[Three]]')
    store.tagAdd(startId, 'opening')
    store.tagRecolor('opening', 'purple')
    store.select(startId)
    await nextTick()

    expect(host.querySelector('.veil')).toBeNull()
    expect(host.querySelectorAll('.card')).toHaveLength(3)
    // One edge per link, each with a real path.
    const wires = [...host.querySelectorAll<SVGPathElement>('.wire')]
    expect(wires).toHaveLength(2)
    for (const w of wires) expect(w.getAttribute('d')).toMatch(/^M [-\d.]+ [-\d.]+/)

    // Twine-style colour stripe from the tag registry.
    expect(host.querySelector('.stripe')).not.toBeNull()
    expect(host.textContent).toContain('opening')
    expect(problems).toEqual([])
  })

  it('shows the inspector for the selected passage', async () => {
    mount()
    store.newStory('Render Check')
    store.select(store.state.doc.nodes[0]!.id)
    await nextTick()

    const inspector = host.querySelector('.inspector')
    expect(inspector).not.toBeNull()
    expect(inspector!.querySelector<HTMLInputElement>('#passage-title')!.value).toBe('Start')
    expect(inspector!.textContent).toContain('Level 1')
    expect(inspector!.textContent).toContain('Unique paths from here')
    expect(problems).toEqual([])
  })

  it('paints Harlowe syntax in the body editor', async () => {
    mount()
    store.newStory('Render Check')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, '(set: $gold to 5)\n<!-- note -->\n[[Two]]')
    store.select(id)
    await nextTick()

    const pre = host.querySelector('.editor pre')!
    expect(pre.querySelector('.hl-macro')!.textContent).toBe('(set:')
    expect(pre.querySelector('.hl-variable')!.textContent).toBe('$gold')
    expect(pre.querySelector('.hl-comment')!.textContent).toBe('<!-- note -->')
    // Settling bound the bare link to the code it minted.
    expect(pre.querySelector('.hl-link')!.textContent).toBe('[[Two|P2]]')
    expect(problems).toEqual([])
  })

  it('renders a phantom card for a link with no passage behind it', async () => {
    mount()
    store.newStory('Render Check')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, '[[Cave]]')
    store.removePassage(store.state.doc.nodes.find((n) => n.title === 'Cave')!.id)
    await nextTick()

    const phantom = host.querySelector('.card.phantom')
    expect(phantom).not.toBeNull()
    expect(phantom!.textContent).toContain('Cave')
    expect(problems).toEqual([])
  })

  it('shows the Scene section with the cast and their per-passage notes', async () => {
    mount()
    store.newStory('Render Check')
    const id = store.state.doc.nodes[0]!.id
    store.settingSet(id, 'The Rusty Anchor')
    store.characterCreate('Mira')
    store.characterSetBio('Mira', "The innkeeper's daughter")
    store.castAdd(id, 'Mira')
    store.castSetNote(id, 'Mira', 'Furious.')
    store.select(id)
    await nextTick()

    const inspector = host.querySelector('.inspector')!
    expect(inspector.querySelector<HTMLInputElement>('#passage-setting')!.value).toBe(
      'The Rusty Anchor',
    )
    expect(inspector.textContent).toContain('Mira')
    // The global bio shows as context; the scene note is the editable field.
    expect(inspector.textContent).toContain("The innkeeper's daughter")
    expect(inspector.querySelector<HTMLInputElement>('.note')!.value).toBe('Furious.')
    expect(problems).toEqual([])
  })

  it('lists settings and cast with counts in the index panel', async () => {
    mount()
    store.newStory('Render Check')
    const start = store.state.doc.nodes[0]!.id
    writeBody(start, '[[Two]]')
    const two = store.state.doc.nodes.find((n) => n.title === 'Two')!.id
    store.settingSet(start, 'Tavern')
    store.settingSet(two, 'Tavern')
    store.characterCreate('Mira')
    store.characterCreate('Unseen')
    store.castAdd(start, 'Mira')
    await nextTick()

    // The panel is opened from the toolbar.
    const indexButton = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cast & Settings',
    )!
    indexButton.click()
    await nextTick()

    const panel = host.querySelector('.index')!
    const rows = [...panel.querySelectorAll('.row')].map((r) => r.textContent!.replace(/\s+/g, ' '))
    expect(rows.some((t) => t.includes('Mira') && t.includes('1'))).toBe(true)
    expect(rows.some((t) => t.includes('Unseen') && t.includes('0'))).toBe(true)
    expect(rows.some((t) => t.includes('Tavern') && t.includes('2'))).toBe(true)
    expect(problems).toEqual([])
  })

  it('reorders the cast from the index panel', async () => {
    mount()
    store.newStory('Render Check')
    store.characterCreate('Mira')
    store.characterCreate('Bandit')
    const indexButton = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cast & Settings',
    )!
    indexButton.click()
    await nextTick()

    const down = host.querySelector<HTMLButtonElement>('.index .arrow[title="Move down"]')!
    down.click()
    await nextTick()

    expect(store.state.doc.characters.map((c) => c.name)).toEqual(['Bandit', 'Mira'])
    // The top row can no longer move up, and the new bottom row cannot move down.
    const arrows = [...host.querySelectorAll<HTMLButtonElement>('.index .arrow')]
    expect(arrows[0]!.disabled).toBe(true)
    expect(arrows.at(-1)!.disabled).toBe(true)
    expect(problems).toEqual([])
  })

  it('dims non-matching passages when an index row is clicked', async () => {
    mount()
    store.newStory('Render Check')
    const start = store.state.doc.nodes[0]!.id
    writeBody(start, '[[Two]]')
    store.settingSet(start, 'Tavern')
    await nextTick()

    expect(host.querySelectorAll('.card.dimmed')).toHaveLength(0)
    store.toggleFilter('settingFilter', 'Tavern')
    await nextTick()

    // Two has no setting, so it dims; Start stays lit.
    expect(host.querySelectorAll('.card.dimmed')).toHaveLength(1)
    expect(problems).toEqual([])
  })

  it('offers help from the toolbar, and explains what tooltips cannot', async () => {
    mount()
    store.newStory('Help Check')
    await nextTick()

    const helpButton = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '?',
    )!
    helpButton.click()
    await nextTick()

    const panel = host.querySelector('[aria-label="How Storybook works"]')!
    expect(panel).not.toBeNull()
    const text = panel.textContent!.replace(/\s+/g, ' ')
    // The three things a tooltip has nowhere to say.
    expect(text).toContain('cards can’t be dragged')
    expect(text).toContain('[[Go north|3A]]')
    expect(text).toMatch(/New passage, linked from the selected one/)
    expect(problems).toEqual([])
  })

  it('pops the body editor out over the window, writing the same document', async () => {
    mount()
    store.newStory('Roomy')
    const id = store.state.doc.nodes[0]!.id
    store.select(id)
    await nextTick()

    const inspector = host.querySelector('.inspector')!
    inspector.querySelector<HTMLButtonElement>('.expand')!.click()
    await nextTick()

    const dialog = host.querySelector('[aria-label="Edit passage body"]')!
    expect(dialog).not.toBeNull()
    // Named by code and title, so it is clear which body is open even when two
    // passages share a title.
    expect(dialog.querySelector('.name')!.textContent).toBe('P1 · Start')

    // Typing in the pop-out edits the document directly — there is no draft to
    // commit, so closing can never lose text.
    const area = dialog.querySelector<HTMLTextAreaElement>('textarea.input')!
    area.value = 'Rewritten here.\n[[Two]]'
    area.dispatchEvent(new Event('input'))
    await nextTick()
    expect(store.state.doc.nodes.find((n) => n.id === id)!.body).toContain('Rewritten here.')
    expect(dialog.textContent).toContain('1 link')

    dialog.querySelector<HTMLButtonElement>('.btn-primary')!.click()
    await nextTick()
    expect(host.querySelector('[aria-label="Edit passage body"]')).toBeNull()
    // The link written in the pop-out is a real edge.
    expect(host.querySelectorAll('.card')).toHaveLength(2)
    expect(problems).toEqual([])
  })

  it('formats the selection from the pop-out toolbar', async () => {
    mount()
    store.newStory('Toolbar')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, 'She ran home.')
    store.select(id)
    await nextTick()

    // The narrow sidebar gets the shortcuts but not the buttons.
    expect(host.querySelector('.inspector .tool')).toBeNull()
    host.querySelector<HTMLButtonElement>('.inspector .expand')!.click()
    await nextTick()

    const dialog = host.querySelector('[aria-label="Edit passage body"]')!
    const area = dialog.querySelector<HTMLTextAreaElement>('textarea.input')!
    const tools = [...dialog.querySelectorAll<HTMLButtonElement>('.tool')]
    expect(tools).toHaveLength(4)

    area.setSelectionRange(4, 7)
    tools[0]!.click()
    await nextTick()
    expect(store.state.doc.nodes.find((n) => n.id === id)!.body).toBe("She ''ran'' home.")

    // Done stays the one primary button in the dialog; the toolbar is dense and
    // borderless on purpose, following `.expand` rather than `.btn`.
    expect(dialog.querySelectorAll('.btn-primary')).toHaveLength(1)
    expect(problems).toEqual([])
  })

  it('formats from the keyboard in the sidebar editor', async () => {
    mount()
    store.newStory('Keys')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, 'She ran home.')
    store.select(id)
    await nextTick()

    const area = host.querySelector<HTMLTextAreaElement>('.inspector textarea.input')!
    const press = async (key: string, shiftKey = false) => {
      area.dispatchEvent(
        new KeyboardEvent('keydown', { key, metaKey: true, shiftKey, bubbles: true }),
      )
      await nextTick()
    }
    const body = () => store.state.doc.nodes.find((n) => n.id === id)!.body

    area.setSelectionRange(4, 7)
    await press('i')
    expect(body()).toBe('She //ran// home.')

    // Quoting widens to the whole line, whatever the selection was.
    area.setSelectionRange(0, 0)
    await press('.', true)
    expect(body()).toBe('> She //ran// home.')
    expect(problems).toEqual([])
  })

  it('asks which passage to link to before writing anything', async () => {
    mount()
    store.newStory('Linking')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, 'Two ways out.\n[[Cave]]')
    store.select(id)
    await nextTick()
    const before = store.state.doc.nodes.length

    const area = host.querySelector<HTMLTextAreaElement>('.inspector textarea.input')!
    area.setSelectionRange(0, 3)
    area.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'K', metaKey: true, shiftKey: true, bubbles: true }),
    )
    await nextTick()

    const picker = host.querySelector('[aria-label="Link to a passage"]')!
    expect(picker).not.toBeNull()
    // Plain Cmd K is the cheat sheet's; the shifted one stops before reaching it.
    expect(host.querySelector('.cheat')).toBeNull()

    // Rows carry both halves: the code the link will contain, and the title the
    // author recognises.
    const rows = [...picker.querySelectorAll<HTMLButtonElement>('.item')]
    const cave = rows.find((r) => r.textContent!.includes('Cave'))!
    expect(cave).not.toBeUndefined()
    expect(cave.textContent).toContain('P2')
    cave.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await nextTick()

    // The selected words became the display text, the code became the target,
    // and picking a passage that already exists left no stray passage behind.
    expect(store.state.doc.nodes.find((n) => n.id === id)!.body).toContain('[[Two|P2]]')
    expect(store.state.doc.nodes).toHaveLength(before)
    expect(host.querySelector('[aria-label="Link to a passage"]')).toBeNull()
    expect(problems).toEqual([])
  })

  it('toggles the pop-out and the cheat sheet from the keyboard', async () => {
    mount()
    store.newStory('Keyed')
    const id = store.state.doc.nodes[0]!.id
    store.characterCreate('Mira')
    store.castAdd(id, 'Mira')
    store.select(id)
    await nextTick()

    // Both are modified keys on purpose: the cursor is usually inside the body
    // editor, where an unmodified key would type rather than close.
    const press = async (key: string) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true }))
      await nextTick()
    }

    await press('e')
    expect(host.querySelector('[aria-label="Edit passage body"]')).not.toBeNull()
    await press('e')
    expect(host.querySelector('[aria-label="Edit passage body"]')).toBeNull()

    await press('k')
    const cheat = host.querySelector('.cheat')!
    expect(cheat).not.toBeNull()
    expect(cheat.textContent).toContain('Mira')
    await press('k')
    expect(host.querySelector('.cheat')).toBeNull()

    // The sidebar can be closed with the passage still selected; the key
    // brings both back rather than doing nothing.
    host.querySelector<HTMLButtonElement>('.inspector header .btn-icon')!.click()
    await nextTick()
    expect(host.querySelector('.inspector')).toBeNull()
    await press('e')
    await nextTick()
    expect(host.querySelector('.inspector')).not.toBeNull()
    expect(host.querySelector('[aria-label="Edit passage body"]')).not.toBeNull()
    await press('e')

    // A phantom is selectable but is not a passage: neither panel should open.
    writeBody(id, '[[Cave]]')
    store.removePassage(store.state.doc.nodes.find((n) => n.title === 'Cave')!.id)
    store.select(store.layout.value.nodes.find((n) => n.isPhantom)!.id)
    await nextTick()
    await press('e')
    await press('k')
    expect(host.querySelector('[aria-label="Edit passage body"]')).toBeNull()
    expect(host.querySelector('.cheat')).toBeNull()

    // Nor with nothing selected at all.
    store.select(null)
    await nextTick()
    await press('e')
    await press('k')
    expect(host.querySelector('[aria-label="Edit passage body"]')).toBeNull()
    expect(host.querySelector('.cheat')).toBeNull()
    expect(problems).toEqual([])
  })

  it('points a first-time author at the help panel, once', async () => {
    localStorage.clear()
    mount()
    store.newStory('First Run')
    await nextTick()

    const hint = host.querySelector('.first-run')
    expect(hint).not.toBeNull()
    expect(hint!.textContent).toContain('New here?')

    hint!.querySelector<HTMLButtonElement>('.btn-icon')!.click()
    await nextTick()
    expect(host.querySelector('.first-run')).toBeNull()
    // ...and it stays gone on the next visit.
    expect(localStorage.getItem('storybook.helpSeen.v1')).toBe('1')
    expect(problems).toEqual([])
  })

  it('auto-saves, and a reload reproduces the identical drawing', async () => {
    mount()
    store.newStory('Persisted Story')
    writeBody(store.state.doc.nodes[0]!.id, '[[Two]]')
    const hash = store.layout.value.stats.hash

    // The store writes on a debounce; wait it out rather than reaching inside.
    await new Promise((r) => setTimeout(r, 400))
    const saved = localStorage.getItem('storybook.story.v1')
    expect(saved).toContain('Two')

    // Simulate a page reload: throw the in-memory story away, put the saved
    // bytes back, and resume the way the startup dialog does.
    store.discardStory()
    expect(store.layout.value.nodes).toHaveLength(0)
    localStorage.setItem('storybook.story.v1', saved!)

    expect(store.resumeStory()).toBe(true)
    expect(store.layout.value.stats.hash).toBe(hash)
    expect(problems).toEqual([])
  })

  it('creates a passage only once the author leaves the body editor', async () => {
    mount()
    store.newStory('Render Check')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, '')
    store.select(id)
    await nextTick()

    const area = host.querySelector<HTMLTextAreaElement>('.inspector textarea.input')!
    area.value = 'Two ways out. [[Head north]]'
    area.dispatchEvent(new Event('input'))
    await nextTick()

    // Still typing: the text is in the document, but nothing has been created and
    // the prose is exactly as written. Rewriting here would move the caret.
    expect(store.state.doc.nodes).toHaveLength(1)
    expect(store.state.doc.nodes[0]!.body).toBe('Two ways out. [[Head north]]')

    area.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }))
    await nextTick()

    // Blur settles it: the passage exists, and the bare link now names its code.
    expect(store.state.doc.nodes).toHaveLength(2)
    const made = store.state.doc.nodes.find((n) => n.id !== id)!
    expect([made.code, made.title]).toEqual(['P2', 'Head north'])
    expect(store.state.doc.nodes.find((n) => n.id === id)!.body).toBe(
      'Two ways out. [[Head north|P2]]',
    )
    expect(problems).toEqual([])
  })

  it('shows a passage code in the inspector and on its card', async () => {
    mount()
    store.newStory('Render Check')
    const id = store.state.doc.nodes[0]!.id
    expect(store.codeSet(id, 'A3')).toBeNull()
    store.select(id)
    await nextTick()

    const inspector = host.querySelector('.inspector')!
    expect(inspector.querySelector<HTMLInputElement>('#passage-code')!.value).toBe('A3')

    // 'P2' is the starter story's dashed card, which the sample link points at.
    const codes = [...host.querySelectorAll('.card .code')].map((el) => el.textContent)
    expect(codes).toEqual(['A3', 'P2'])
    expect(problems).toEqual([])
  })

  it('draws a code on every card, since a passage cannot be without one', async () => {
    mount()
    store.newStory('Render Check')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, '[[Two]]')
    store.select(id)
    await nextTick()

    const codes = [...host.querySelectorAll('.card .code')].map((el) => el.textContent)
    expect(codes).toEqual(['P1', 'P2'])
    expect(problems).toEqual([])
  })

  it('puts Code first, then Title, then the body', async () => {
    mount()
    store.newStory('Render Check')
    store.select(store.state.doc.nodes[0]!.id)
    await nextTick()

    // Code leads because it is the passage's identity — what links name, and
    // what every banner and picker row shows. The title is a label beneath it.
    const sections = [...host.querySelectorAll('.inspector .scroll > section')]
    expect(sections[0]!.querySelector('#passage-code')).not.toBeNull()
    expect(sections[1]!.querySelector('#passage-title')).not.toBeNull()
    expect(sections[2]!.querySelector('.editor')).not.toBeNull()
    expect(problems).toEqual([])
  })
})

describe('the character cheat sheet', () => {
  /** A passage casting two characters, with the cheat sheet opened on it. */
  async function openOnCast() {
    mount()
    store.newStory('Cheat Check')
    const id = store.state.doc.nodes[0]!.id
    store.characterCreate('Mira')
    store.characterCreate('Tam')
    store.characterSetBio('Mira', "The innkeeper's daughter")
    store.characterSetTrait('Mira', 'personality', ['Guarded'])
    store.characterSetTrait('Mira', 'dialogue', ['Clipped sentences'])
    store.relationAdd('Mira', 'Tam')
    store.relationSetPoints('Mira', 'Tam', ['Owes him nothing'])
    // Off stage in this passage, so Mira's feelings about her stay off the panel.
    store.characterCreate('Wren')
    store.relationAdd('Mira', 'Wren')
    store.relationSetPoints('Mira', 'Wren', ['Has never forgiven her'])
    store.castAdd(id, 'Mira')
    store.castAdd(id, 'Tam')
    store.castSetNote(id, 'Mira', 'Furious.')
    store.select(id)
    await nextTick()

    host.querySelector<HTMLButtonElement>('.inspector .cheat-link')!.click()
    await nextTick()
    return id
  }

  function groupLabel(text: string) {
    return [...host.querySelectorAll<HTMLButtonElement>('.cheat .group-label')].find((b) =>
      b.textContent!.includes(text),
    )!
  }

  it('opens on the left from the passage sidebar, showing the cast', async () => {
    await openOnCast()

    const panel = host.querySelector('.cheat')!
    expect(panel).not.toBeNull()
    expect(host.querySelector('main')!.firstElementChild).toBe(panel)

    const text = panel.textContent!.replace(/\s+/g, ' ')
    expect(text).toContain('Cast of P1 · Start')
    expect(text).toContain('Mira')
    expect(text).toContain('Tam')
    expect(text).toContain("The innkeeper's daughter")
    expect(text).toContain('In this scene: Furious.')
    expect(text).toContain('Personality')
    expect(text).toContain('Guarded')
    expect(text).toContain('Dialogue characteristics')
    expect(text).toContain('Relations')
    expect(text).toContain('Owes him nothing')
    // Wren is not in the cast: neither she nor Mira's note about her appears.
    expect(text).not.toContain('Wren')
    expect(text).not.toContain('Has never forgiven her')
    // Tam has nothing written, so his card says so rather than rendering empty.
    expect(text).toContain('No direction written yet.')
    expect(problems).toEqual([])
  })

  it('shows only one left panel at a time', async () => {
    await openOnCast()

    const indexButton = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cast & Settings',
    )!
    indexButton.click()
    await nextTick()
    expect(host.querySelector('.cheat')).toBeNull()
    expect(host.querySelector('.index')).not.toBeNull()

    indexButton.click()
    await nextTick()
    expect(host.querySelector('.index')).toBeNull()
    expect(host.querySelector('.cheat')).toBeNull()
    expect(problems).toEqual([])
  })

  it('closes from its own button, leaving the passage sidebar up', async () => {
    await openOnCast()

    host.querySelector<HTMLButtonElement>('.cheat header .btn-icon')!.click()
    await nextTick()
    expect(host.querySelector('.cheat')).toBeNull()
    expect(host.querySelector('.inspector')).not.toBeNull()
    expect(problems).toEqual([])
  })

  it('folds one subsection without touching the others', async () => {
    await openOnCast()

    expect(groupLabel('Personality').nextElementSibling!.textContent).toContain('Guarded')

    groupLabel('Personality').click()
    await nextTick()
    expect(groupLabel('Personality').nextElementSibling).toBeNull()
    // The sibling group, and the same group on nobody else, stays open.
    expect(groupLabel('Dialogue characteristics').nextElementSibling!.textContent).toContain(
      'Clipped sentences',
    )

    groupLabel('Personality').click()
    await nextTick()
    expect(groupLabel('Personality').nextElementSibling!.textContent).toContain('Guarded')
    expect(problems).toEqual([])
  })

  it('follows the selection, and forgets the folds with it', async () => {
    const id = await openOnCast()
    groupLabel('Personality').click()
    await nextTick()
    expect(groupLabel('Personality').nextElementSibling).toBeNull()

    writeBody(id, '[[Two]]')
    const two = store.state.doc.nodes.find((n) => n.title === 'Two')!.id
    store.castAdd(two, 'Mira')
    store.select(two)
    await nextTick()

    const panel = host.querySelector('.cheat')!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('Cast of P2 · Two')
    expect(groupLabel('Personality').nextElementSibling!.textContent).toContain('Guarded')
    expect(problems).toEqual([])
  })

  it('closes with the passage sidebar, and does not come back with it', async () => {
    await openOnCast()

    host.querySelector<HTMLButtonElement>('.inspector header .btn-icon')!.click()
    await nextTick()
    expect(host.querySelector('.inspector')).toBeNull()
    expect(host.querySelector('.cheat')).toBeNull()

    const reopen = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Show passage',
    )!
    reopen.click()
    await nextTick()
    expect(host.querySelector('.inspector')).not.toBeNull()
    expect(host.querySelector('.cheat')).toBeNull()
    expect(problems).toEqual([])
  })

  it('closes when the selection is cleared', async () => {
    await openOnCast()

    store.select(null)
    await nextTick()
    expect(host.querySelector('.cheat')).toBeNull()
    expect(problems).toEqual([])
  })

  it('hides Relations entirely when no relation points at this cast', async () => {
    const id = await openOnCast()

    // A passage casting Mira alone: both her relations now point off stage.
    writeBody(id, '[[Two]]')
    const two = store.state.doc.nodes.find((n) => n.title === 'Two')!.id
    store.castAdd(two, 'Mira')
    store.select(two)
    await nextTick()

    const panel = host.querySelector('.cheat')!
    const text = panel.textContent!.replace(/\s+/g, ' ')
    expect(text).toContain('Cast of P2 · Two')
    expect(text).toContain('Guarded')
    expect(text).not.toContain('Relations')
    expect(text).not.toContain('Owes him nothing')
    expect(problems).toEqual([])
  })

  it('leaves the panel lit beside the body editor rather than under its veil', async () => {
    await openOnCast()

    host.querySelector<HTMLButtonElement>('.inspector .expand')!.click()
    await nextTick()

    // The dialog is up, the panel is still mounted, and the veil is inset past it.
    expect(host.querySelector('.veil')).not.toBeNull()
    expect(host.querySelector('.cheat')).not.toBeNull()
    expect(host.querySelector<HTMLElement>('.app')!.style.getPropertyValue('--veil-inset')).toBe(
      'var(--left-panel-w)',
    )
    expect(problems).toEqual([])
  })

  it('leaves the body editor alone when Escape dismisses a sheet stacked on it', async () => {
    await openOnCast()

    host.querySelector<HTMLButtonElement>('.inspector .expand')!.click()
    await nextTick()
    expect(host.querySelector('.veil')).not.toBeNull()

    // The cheat sheet is clickable beside the editor, so its "Edit" link can
    // stack a character sheet on top of it.
    host.querySelector<HTMLButtonElement>('.cheat .link')!.click()
    await nextTick()
    expect(store.state.openCharacter).toBe('Mira')

    // Escape belongs to the sheet on top; the editor underneath must survive.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(host.querySelector('.sheet[aria-label="Edit passage body"]')).not.toBeNull()

    // Closing that sheet hands Escape back.
    store.closeCharacterSheet()
    await nextTick()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(host.querySelector('.sheet[aria-label="Edit passage body"]')).toBeNull()
    expect(problems).toEqual([])
  })

  it('offers no way in from a passage with no cast', async () => {
    mount()
    store.newStory('Cheat Check')
    store.select(store.state.doc.nodes[0]!.id)
    await nextTick()

    expect(host.querySelector('.inspector .cheat-link')).toBeNull()
    expect(problems).toEqual([])
  })
})

describe('a passage cast on screen', () => {
  /**
   * A roster whose author order runs backwards against the alphabet, cast whole
   * into one passage — so name order and roster order can never be confused.
   */
  async function openOnRoster() {
    mount()
    store.newStory('Order Check')
    const id = store.state.doc.nodes[0]!.id
    for (const name of ['Zeno', 'Mira', 'Bandit']) {
      store.characterCreate(name)
      store.castAdd(id, name)
    }
    store.select(id)
    await nextTick()
    host.querySelector<HTMLButtonElement>('.inspector .cheat-link')!.click()
    await nextTick()
    return id
  }

  const named = (selector: string) =>
    [...host.querySelectorAll<HTMLElement>(selector)].map((el) => el.textContent!.trim())

  const inSidebar = () => named('.inspector .cast .name')
  const inCheatSheet = () => named('.cheat .name')

  it('lists the cast in roster order, not alphabetically', async () => {
    const id = await openOnRoster()

    // Stored alphabetically — the order that must not reach the screen.
    expect(store.state.doc.nodes.find((n) => n.id === id)!.characters.map((c) => c.name)).toEqual([
      'Bandit',
      'Mira',
      'Zeno',
    ])
    expect(inSidebar()).toEqual(['Zeno', 'Mira', 'Bandit'])
    expect(inCheatSheet()).toEqual(['Zeno', 'Mira', 'Bandit'])
    expect(problems).toEqual([])
  })

  it('follows a move in the story index without an edit to the passage', async () => {
    const id = await openOnRoster()
    const before = store.state.doc.nodes.find((n) => n.id === id)!.characters

    store.characterMove('Bandit', -2)
    await nextTick()

    expect(inSidebar()).toEqual(['Bandit', 'Zeno', 'Mira'])
    expect(inCheatSheet()).toEqual(['Bandit', 'Zeno', 'Mira'])
    // The passage itself never moved; only the view over it did.
    expect(store.state.doc.nodes.find((n) => n.id === id)!.characters).toEqual(before)
    expect(problems).toEqual([])
  })

  it('falls in with the alphabet once the roster is sorted A-Z', async () => {
    await openOnRoster()

    store.characterSortByName()
    await nextTick()

    expect(inSidebar()).toEqual(['Bandit', 'Mira', 'Zeno'])
    expect(inCheatSheet()).toEqual(['Bandit', 'Mira', 'Zeno'])
    expect(problems).toEqual([])
  })
})

describe('selecting more than one passage', () => {
  /** Cards are laid out by code order, so find by text rather than by index. */
  function card(title: string): HTMLElement {
    const found = [...host.querySelectorAll<HTMLElement>('.card')].find((el) =>
      el.textContent?.includes(title),
    )
    if (!found) throw new Error(`no card for ${title}`)
    return found
  }

  const click = async (title: string, init: MouseEventInit = {}) => {
    card(title).dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
    await nextTick()
  }

  async function branchingStory() {
    mount()
    store.newStory('Select Check')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, '[[Two]]')
    writeBody(store.state.doc.nodes.find((n) => n.title === 'Two')!.id, '[[Three]]')
    await nextTick()
  }

  it('takes a subtree from a Cmd-click and a single card from Shift-click', async () => {
    // The whole point of this test: a dropped second emit payload compiles
    // fine and only shows up when the real chain runs.
    await branchingStory()

    await click('Two', { metaKey: true })
    expect(store.selectedNodes.value.map((n) => n.title)).toEqual(['Two', 'Three'])
    expect(host.querySelectorAll('.card.selected')).toHaveLength(2)
    expect(host.querySelectorAll('.card.anchor')).toHaveLength(1)

    await click('Start', { shiftKey: true })
    expect(store.selectedNodes.value.map((n) => n.title)).toEqual(['Start', 'Two', 'Three'])

    await click('Start', { shiftKey: true })
    expect(store.selectedNodes.value.map((n) => n.title)).toEqual(['Two', 'Three'])

    // A plain click is still a plain click.
    await click('Start')
    expect(store.state.selectedIds).toHaveLength(1)
    expect(problems).toEqual([])
  })

  it('summarises the selection in the sidebar instead of the passage editor', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    const inspector = host.querySelector('.inspector')!
    expect(inspector.querySelector('.eyebrow')!.textContent).toBe('Selection')
    expect([...inspector.querySelectorAll('.picked .row')].map((el) => el.textContent!.trim()))
      .toEqual(['P2 · Two', 'P3 · Three'])
    expect(inspector.textContent).toContain('Delete 2 passages')
    expect(problems).toEqual([])
  })

  it('deletes the whole selection from the keyboard', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }))
    await nextTick()

    expect(store.state.doc.nodes.map((n) => n.title)).toEqual(['Start'])
    expect(problems).toEqual([])
  })

  it('refuses a delete that would strand a passage and says so in the banner', async () => {
    await branchingStory()
    await click('Two')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }))
    await nextTick()

    expect(store.state.doc.nodes.map((n) => n.title)).toEqual(['Start', 'Two', 'Three'])
    expect(host.querySelector('.notices')!.textContent).toContain('"P3 · Three"')
    expect(problems).toEqual([])
  })

  it('clears the selection when the background is clicked', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    host
      .querySelector('[data-canvas-background]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    expect(store.state.selectedIds).toEqual([])
    expect(host.querySelector('.card.selected')).toBeNull()
    expect(problems).toEqual([])
  })
})
