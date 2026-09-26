// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import type { App as VueApp } from 'vue'
import App from '../App.vue'
import { prefs, reloadPrefs, resetPrefs, setPref } from '../stores/prefs'
import * as store from '../stores/story'
import { serializeDoc } from '../lib/doc/serialize'
import { emptyDoc } from '../types/story'
import { COMMANDS, GROUP_LABELS } from '../lib/ui/commands'
import { wordCount } from '../lib/graph/stats'

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

/**
 * Runs a command from the menu bar.
 *
 * The toolbar used to be a flat row of twenty-six buttons; the long tail now
 * lives behind File / Edit / View / Story / Help, so reaching one means opening
 * its menu first. The group comes from the command table, so a command that
 * moves menus does not move these tests.
 */
async function runCommand(label: string) {
  const spec = COMMANDS.find((c) => c.label === label)
  if (!spec?.group) throw new Error(`No menu command labelled "${label}"`)
  const group = GROUP_LABELS[spec.group]
  const title = [...host.querySelectorAll<HTMLButtonElement>('.menubar .title')].find(
    (b) => b.textContent!.trim() === group,
  )
  if (!title) throw new Error(`No menu titled "${group}"`)
  title.click()
  await nextTick()
  const item = [...host.querySelectorAll<HTMLButtonElement>('.menu-item')].find(
    (b) => b.querySelector('.menu-label')!.textContent!.trim() === label,
  )
  if (!item) throw new Error(`No item "${label}" in the ${group} menu`)
  item.click()
  await nextTick()
}

/**
 * What a Story menu row looks like right now — dimmed, ticked — with the menu
 * opened to read it and closed again, so nothing is left standing in front of
 * the canvas for the assertions that follow.
 */
async function storyRow(label: string) {
  const title = [...host.querySelectorAll<HTMLButtonElement>('.menubar .title')].find(
    (b) => b.textContent!.trim() === 'Story',
  )!
  title.click()
  await nextTick()
  const row = [...host.querySelectorAll<HTMLButtonElement>('.menu-item')].find(
    (b) => b.querySelector('.menu-label')!.textContent!.trim() === label,
  )
  if (!row) throw new Error(`No item "${label}" in the Story menu`)
  const read = {
    disabled: row.disabled,
    tick: row.querySelector('.menu-check')!.textContent!.trim(),
  }
  title.click()
  await nextTick()
  return read
}

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
  store.setCompactCast(false)
  // Preferences are a module singleton too: without this, a toggle flipped by
  // one test silently changes what the next one creates.
  resetPrefs()
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

/**
 * Where the canvas is looking. The card layer carries the viewport transform,
 * so this is how a test sees that something travelled to a passage rather than
 * merely selecting it.
 */
function stageTransform(): string {
  return host.querySelector<HTMLElement>('.nodes')?.style.transform ?? ''
}

/**
 * Switch the passage sidebar to its Advanced half.
 *
 * Level, Mark as Ending, Code and the path counts live there. Keyed on the
 * `data-tab` attribute rather than the button's text, so a wording change does
 * not silently stop switching and leave every assertion below testing the Write
 * tab instead.
 */
function openAdvanced(): void {
  host.querySelector<HTMLButtonElement>('.inspector [data-tab="advanced"]')!.click()
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

  it('draws one stripe per distinct tag colour, in palette order', async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    // Stored alphabetically, so the colours interleave: purple, yellow, yellow, red.
    // 'zeta' stays `none` — a tag with no colour earns no stripe but still gets a chip.
    for (const t of ['alpha', 'beta', 'delta', 'gamma', 'zeta']) store.tagAdd(startId, t)
    store.tagRecolor('alpha', 'purple')
    store.tagRecolor('beta', 'yellow')
    store.tagRecolor('delta', 'yellow')
    store.tagRecolor('gamma', 'red')
    await nextTick()

    const stripes = [...host.querySelectorAll<HTMLElement>('.card .stripe')]
    // Four coloured tags, three colours: the second yellow is merged away.
    expect(stripes).toHaveLength(3)
    // Palette order (TAG_COLORS), not tag order — red sits left of purple on every card.
    expect(stripes.map((s) => s.getAttribute('style'))).toEqual([
      'background: var(--tag-red);',
      'background: var(--tag-yellow);',
      'background: var(--tag-purple);',
    ])
    // The uncoloured tag is still named below.
    expect(host.textContent).toContain('zeta')
    expect(problems).toEqual([])
  })

  it("lists a card's tag chips in palette order, not alphabetically", async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    // Stored alphabetically — the order that must not reach the screen. The
    // chips have to read the way the stripe above them is drawn, or the two
    // disagree about which tag is which colour.
    for (const t of ['alpha', 'beta', 'delta', 'gamma', 'zeta']) store.tagAdd(startId, t)
    store.tagRecolor('alpha', 'purple')
    store.tagRecolor('beta', 'yellow')
    store.tagRecolor('delta', 'yellow')
    store.tagRecolor('gamma', 'red')
    await nextTick()

    const chips = [...host.querySelectorAll<HTMLElement>('.card .chips .chip')]
    // Red, then both yellows alphabetically, then purple — and `zeta`, which
    // earns no stripe at all, last rather than first.
    expect(chips.map((c) => c.textContent?.trim())).toEqual([
      'gamma',
      'beta',
      'delta',
      'alpha',
      'zeta',
    ])
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

    openAdvanced()
    await nextTick()
    expect(inspector!.textContent).toContain('Level 1')
    expect(inspector!.textContent).toContain('Routes from here')
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

  it('puts the stored setting back in the field when only padding was typed', async () => {
    mount()
    store.newStory('Render Check')
    const id = store.state.doc.nodes[0]!.id
    store.settingSet(id, 'Tavern')
    store.select(id)
    await nextTick()

    const field = host.querySelector<HTMLInputElement>('#passage-setting')!
    const before = store.state.doc

    field.value = '  Tavern  '
    field.dispatchEvent(new Event('input'))
    await nextTick()

    // `setSetting` is `setSettingMany`'s one-entry case, so this stores nothing
    // and costs no undo entry — and the field must not go on showing padding
    // the document never took.
    expect(store.state.doc).toBe(before)

    field.dispatchEvent(new Event('blur'))
    await nextTick()
    expect(field.value).toBe('Tavern')
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

    // The panel is opened from the Story menu.
    await runCommand('Cast & Settings')

    const panel = host.querySelector('.index')!
    const rows = [...panel.querySelectorAll('.row')].map((r) => r.textContent!.replace(/\s+/g, ' '))
    expect(rows.some((t) => t.includes('Mira') && t.includes('1'))).toBe(true)
    expect(rows.some((t) => t.includes('Unseen') && t.includes('0'))).toBe(true)
    expect(rows.some((t) => t.includes('Tavern') && t.includes('2'))).toBe(true)
    expect(problems).toEqual([])
  })

  describe('the cast in the index panel', () => {
    const ROW_H = 40
    const roster = () => store.state.doc.characters.map((c) => c.name)
    const castRows = () => [...host.querySelectorAll<HTMLElement>('.index li[data-index]')]
    const grip = (name: string) => host.querySelector<HTMLElement>(`.index .grip[data-name="${name}"]`)!

    /**
     * jsdom has neither `DragEvent` nor `DataTransfer`, and lays nothing out, so
     * each row is given a 40px box stacked in order and each event a stand-in
     * transfer that only records what was set on it.
     */
    function fire(el: EventTarget, type: string, clientY = 0, relatedTarget: EventTarget | null = null) {
      const e = new Event(type, { bubbles: true, cancelable: true })
      const data = new Map<string, string>()
      const dataTransfer = {
        effectAllowed: 'none',
        dropEffect: 'none',
        setData: (k: string, v: string) => data.set(k, v),
        setDragImage: () => {},
        data,
      }
      Object.defineProperties(e, {
        dataTransfer: { value: dataTransfer },
        clientY: { value: clientY },
        relatedTarget: { value: relatedTarget },
      })
      el.dispatchEvent(e)
      return dataTransfer
    }

    async function setup(...names: string[]) {
      mount()
      store.newStory('Render Check')
      for (const n of names) store.characterCreate(n)
      await nextTick()
      await runCommand('Cast & Settings')
      for (const row of castRows()) {
        const top = Number(row.dataset.index) * ROW_H
        row.getBoundingClientRect = () => ({ top, height: ROW_H }) as DOMRect
      }
    }

    const lines = () => host.querySelectorAll('.index .drop-before, .index .drop-end').length

    /** Drag `name` by its handle and let go at `clientY`, over whichever row is there. */
    async function dragTo(name: string, clientY: number) {
      const transfer = fire(grip(name), 'dragstart')
      await nextTick()
      const over = castRows()[Math.min(Math.floor(clientY / ROW_H), castRows().length - 1)]!
      fire(over, 'dragover', clientY)
      await nextTick()
      const lined = lines()
      fire(over, 'drop', clientY)
      fire(grip(name), 'dragend')
      await nextTick()
      return { transfer, lined }
    }

    it('drops a character anywhere in one move, and undoes it in one step', async () => {
      await setup('Mira', 'Tam', 'Bandit')

      // Upper half of Mira's row: before her.
      const { transfer, lined } = await dragTo('Bandit', 10)
      expect(roster()).toEqual(['Bandit', 'Mira', 'Tam'])
      expect(lined).toBe(1)
      // Not text/plain, or a row dropped on the body editor would paste its name.
      expect([...transfer.data.keys()]).toEqual(['application/x-storyboard-character'])
      expect(host.querySelectorAll('.index .dragging')).toHaveLength(0)
      expect(lines()).toBe(0)

      store.undo()
      expect(roster()).toEqual(['Mira', 'Tam', 'Bandit'])
      expect(problems).toEqual([])
    })

    it('moves a character to the very end from below the last midpoint', async () => {
      await setup('Mira', 'Tam', 'Bandit')
      const { lined } = await dragTo('Mira', 3 * ROW_H - 5)
      expect(roster()).toEqual(['Tam', 'Bandit', 'Mira'])
      expect(lined).toBe(1)
      expect(problems).toEqual([])
    })

    it('records nothing for a drop back into its own slot', async () => {
      await setup('Mira', 'Tam', 'Bandit')
      const before = store.state.doc

      // Lower half of the row above Tam, and upper half of Tam's own row: both
      // are the slot Tam already sits in, so neither draws a line or commits.
      for (const y of [ROW_H - 5, ROW_H + 5]) {
        const { lined } = await dragTo('Tam', y)
        expect(lined).toBe(0)
      }
      expect(store.state.doc).toBe(before)
      expect(problems).toEqual([])
    })

    it('ignores a drag that did not start on a handle', async () => {
      await setup('Mira', 'Tam')
      const over = fire(castRows()[0]!, 'dragover', 5)
      expect(over.dropEffect).toBe('none')
      fire(castRows()[0]!, 'drop', 5)
      expect(roster()).toEqual(['Mira', 'Tam'])
    })

    const compactButton = () =>
      [...host.querySelectorAll<HTMLButtonElement>('.index .section-actions .mini')].find(
        (b) => b.textContent!.trim() === 'Compact',
      )!

    it('gives a name its own line, with only the count beside it', async () => {
      await setup('Mira')
      const row = castRows()[0]!
      const head = row.querySelector('.row-head')!
      expect(head.querySelector('.name')!.textContent!.trim()).toBe('Mira')
      expect(head.querySelector('.count')).not.toBeNull()
      expect(head.querySelectorAll('.mini')).toHaveLength(0)
      expect([...row.querySelectorAll('.actions .mini:not(.arrow)')].map((b) => b.textContent!.trim())).toEqual([
        'Open',
        'Rename',
        'Delete',
      ])
      expect(problems).toEqual([])
    })

    it('compacts every card to its handle and name, for the session only', async () => {
      await setup('Mira', 'Tam')
      compactButton().click()
      await nextTick()

      expect(compactButton().getAttribute('aria-pressed')).toBe('true')
      expect(store.state.compactCast).toBe(true)
      // Not a saved preference: a compact cast met again after a relaunch has
      // no Open, Rename or Delete in sight.
      expect(localStorage.getItem('storybook.prefs.v1') ?? '').not.toContain('compactCast')
      for (const row of castRows()) {
        expect(row.querySelector('.grip')).not.toBeNull()
        expect(row.querySelector('.name')).not.toBeNull()
        expect(row.querySelector('.count, .actions, .bio, .profile')).toBeNull()
      }

      // Still a drag list: compact is for ordering a long cast.
      await dragTo('Tam', 5)
      expect(roster()).toEqual(['Tam', 'Mira'])

      compactButton().click()
      await nextTick()
      expect(castRows()[0]!.querySelector('.actions')).not.toBeNull()
      expect(store.state.compactCast).toBe(false)
      expect(problems).toEqual([])
    })

    it('drops a pending delete rather than hiding it behind the compact view', async () => {
      await setup('Mira')
      castRows()[0]!.querySelector<HTMLButtonElement>('.actions .danger')!.click()
      await nextTick()
      expect(host.querySelector('.index .confirm')).not.toBeNull()

      compactButton().click()
      await nextTick()
      compactButton().click()
      await nextTick()
      expect(host.querySelector('.index .confirm')).toBeNull()
      expect(roster()).toEqual(['Mira'])
    })

    it('lands a drop in the gap between rows, or on a row\'s text', async () => {
      await setup('Mira', 'Tam', 'Bandit')
      const list = host.querySelector('.index .cast')!

      // Over the list itself, which is what a gap reports as the target.
      fire(grip('Bandit'), 'dragstart')
      fire(list, 'dragover', ROW_H)
      await nextTick()
      expect(lines()).toBe(1)
      fire(list, 'drop', ROW_H)
      await nextTick()
      expect(roster()).toEqual(['Mira', 'Bandit', 'Tam'])

      // Over a text node, which Firefox can report instead of its element.
      const text = castRows()[0]!.querySelector('.name')!.firstChild!
      expect(text.nodeType).toBe(Node.TEXT_NODE)
      fire(grip('Tam'), 'dragstart')
      fire(text, 'dragover', 5)
      fire(text, 'drop', 5)
      await nextTick()
      expect(roster()).toEqual(['Tam', 'Mira', 'Bandit'])
      expect(problems).toEqual([])
    })

    it('takes the line away when the drag leaves the list', async () => {
      await setup('Mira', 'Tam', 'Bandit')
      const list = host.querySelector('.index .cast')!
      fire(grip('Bandit'), 'dragstart')
      fire(castRows()[0]!, 'dragenter', 5)
      await nextTick()
      expect(lines()).toBe(1)

      // Into a row's own child: still in the list, so the line stays.
      fire(castRows()[0]!, 'dragleave', 5, grip('Mira'))
      await nextTick()
      expect(lines()).toBe(1)

      fire(list, 'dragleave', 5, host.querySelector('.index header'))
      await nextTick()
      expect(lines()).toBe(0)
      fire(grip('Bandit'), 'dragend')
      expect(roster()).toEqual(['Mira', 'Tam', 'Bandit'])
    })

    it('keeps the arrows in the full view, and reads out where a row went', async () => {
      await setup('Mira', 'Tam', 'Bandit')
      const arrow = (name: string, dir: 'up' | 'down') =>
        host.querySelector<HTMLButtonElement>(`.index .arrow[aria-label="Move ${name} ${dir}"]`)!

      expect(arrow('Mira', 'up').disabled).toBe(true)
      expect(arrow('Bandit', 'down').disabled).toBe(true)
      arrow('Mira', 'down').click()
      await nextTick()

      expect(roster()).toEqual(['Tam', 'Mira', 'Bandit'])
      expect(host.querySelector('.index [aria-live]')!.textContent!.trim()).toBe(
        'Mira moved to position 2 of 3.',
      )
      expect(grip('Mira').getAttribute('role')).toBe('button')
      expect(problems).toEqual([])
    })

    it('moves one place per arrow key on a focused handle, and keeps the focus', async () => {
      await setup('Mira', 'Tam', 'Bandit')
      grip('Mira').focus()
      grip('Mira').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await nextTick()
      await nextTick()

      expect(roster()).toEqual(['Tam', 'Mira', 'Bandit'])
      expect(document.activeElement).toBe(grip('Mira'))
      expect(problems).toEqual([])
    })
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

    await runCommand('How Storybook works')

    const panel = host.querySelector('[aria-label="How Storybook works"]')!
    expect(panel).not.toBeNull()
    const text = panel.textContent!.replace(/\s+/g, ' ')
    // The three things a tooltip has nowhere to say.
    expect(text).toContain('cards can’t be dragged')
    expect(text).toContain('[[Go north|3A]]')
    expect(text).toMatch(/New passage, linked from the selected one/)
    expect(problems).toEqual([])
  })

  it('opens the tag analyzer from the toolbar and counts routes through a tag', async () => {
    mount()
    store.newStory('Tag Check')
    await nextTick()

    const first = store.state.doc.nodes[0]!.id
    store.tagAdd(first, 'opening')
    await nextTick()

    await runCommand('Tags')

    const panel = host.querySelector('[aria-label="Tag analyzer"]')!
    expect(panel).not.toBeNull()
    const text = panel.textContent!.replace(/\s+/g, ' ')
    // The tag is on the only passage, so every route runs through it.
    expect(text).toContain('opening')
    expect(text).toContain('100%')

    // Expanding the row breaks it down by level. The one passage is on level 1
    // and is the only thing there, so it is `1 of 1`.
    const count = [...panel.querySelectorAll<HTMLButtonElement>('button.link')].find(
      (b) => b.textContent?.trim() === '1',
    )!
    count.click()
    await nextTick()
    const opened = panel.textContent!.replace(/\s+/g, ' ')
    expect(opened).toContain('Share of level')
    expect(opened).toContain('L1')
    expect(opened).toContain('1 of 1')
    expect(problems).toEqual([])
  })

  it('ticking one tag renders the collected-how-often rows', async () => {
    // The combination section only exists once a tag is ticked, so nothing
    // mounted its markup before this — and a template-only mistake in there is
    // exactly what this file is for.
    mount()
    store.newStory('Hit Check')
    await nextTick()

    store.tagAdd(store.state.doc.nodes[0]!.id, 'opening')
    await nextTick()
    await runCommand('Tags')

    const panel = host.querySelector('[aria-label="Tag analyzer"]')!
    const box = panel.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    box.click()
    await nextTick()

    const text = panel.textContent!.replace(/\s+/g, ' ')
    expect(text).toContain('Combination')
    // One passage carrying the tag: every route collects it exactly once.
    expect(text).toContain('exactly once')
    expect(text).toContain('exactly twice')
    expect(text).toContain('three or more times')
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
    openAdvanced()
    await nextTick()
    expect(inspector.querySelector<HTMLInputElement>('#passage-code')!.value).toBe('A3')

    setPref('showCodes', true)
    await nextTick()
    // 'P2' is the starter story's dashed card, which the sample link points at.
    const codes = [...host.querySelectorAll('.code-tag')].map((el) => el.textContent?.trim())
    expect(codes).toEqual(['A3', 'P2'])
    expect(problems).toEqual([])
  })

  it('draws a code above every card, since a passage cannot be without one', async () => {
    mount()
    store.newStory('Render Check')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, '[[Two]]')
    setPref('showCodes', true)
    await nextTick()

    const codes = [...host.querySelectorAll('.code-tag')].map((el) => el.textContent?.trim())
    expect(codes).toEqual(['P1', 'P2'])
    expect(problems).toEqual([])
  })

  it('gives the in-card line to the running slug, and collapses it when there is none', async () => {
    mount()
    store.newStory('Render Check')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, '[[Two]]')
    await nextTick()

    // Nothing marked yet, so no card spends a line on one.
    expect(host.querySelectorAll('.card .run')).toHaveLength(0)

    store.slugSet(id, 'A')
    await nextTick()

    // One card, not two. The passage downstream really does inherit the mark —
    // a running slug names the route so far rather than the passage at the end
    // of it, so both *are* `A` — but nothing below it carries a mark, so its
    // code is finished and the card stops repeating it.
    const runs = [...host.querySelectorAll('.card .run')].map((el) => el.textContent)
    expect(runs).toEqual(['A'])

    const other = store.state.doc.nodes.find((n) => n.id !== id)!.id
    expect(store.runningSlugs.value.get(other)).toBe('A')
    expect(problems).toEqual([])
  })

  it('drops the in-card line once nothing below carries a mark', async () => {
    mount()
    store.newStory('Render Check')
    const one = store.state.doc.nodes[0]!.id
    writeBody(one, '[[Two]]')
    const two = store.state.doc.nodes.find((n) => n.id !== one)!.id
    writeBody(two, '[[Three]]')
    const three = store.state.doc.nodes.find((n) => n.id !== one && n.id !== two)!.id

    store.slugSet(one, 'A')
    await nextTick()

    // Only the marked passage: the two below it would spell `A` for ever.
    const shown = () =>
      [...host.querySelectorAll('.card')].map((c) => c.querySelector('.run')?.textContent ?? null)
    expect(shown()).toEqual(['A', null, null])

    // Mark the far end and the middle is on the way somewhere again.
    store.slugSet(three, 'Z')
    await nextTick()
    expect(shown()).toEqual(['A', 'A', 'AZ'])

    // The code itself never went anywhere — the search box still has it.
    store.slugSet(three, '')
    await nextTick()
    expect(store.runningSlugs.value.get(three)).toBe('A')
    expect(store.cardSlugs.value.get(three)).toBe('')
    expect(problems).toEqual([])
  })

  it('shows the tail of a long running slug, and the whole of it on hover', async () => {
    mount()
    store.newStory('Render Check')

    // A chain long enough to outrun the card line, each passage marked.
    let prev = store.state.doc.nodes[0]!.id
    store.slugSet(prev, 'aaaa')
    for (let i = 2; i <= 8; i += 1) {
      const before = new Set(store.state.doc.nodes.map((n) => n.id))
      writeBody(prev, `[[Step ${i}]]`)
      const next = store.state.doc.nodes.find((n) => !before.has(n.id))!.id
      store.slugSet(next, 'aaaa')
      prev = next
    }
    await nextTick()

    const last = [...host.querySelectorAll('.card .run')].pop()!
    const full = 'aaaa'.repeat(8)
    // Cut from the front: the end is where this passage is, and the front is
    // what every sibling shares.
    expect(last.textContent).toBe('\u2026' + full.slice(full.length - 21))
    // The whole run, and the label with it: this line sits over the top of the
    // card, so its own tooltip replaces the card's for that strip. Dropping the
    // label there would leave the one region of the card that cannot say which
    // passage it is — and titles repeat, which is why the card has a tooltip.
    const title = last.getAttribute('title')!
    expect(title).toContain(full)
    expect(title).toContain(last.closest('.card')!.querySelector('.title')!.textContent!)
    expect(problems).toEqual([])
  })

  it('puts Title first, then the body, with the Note and the Code on the other tab', async () => {
    mount()
    store.newStory('Render Check')
    store.select(store.state.doc.nodes[0]!.id)
    await nextTick()

    // The body is the work, so it sits as high as a title allows. Everything
    // that is *about* the passage rather than part of it — what it is called to
    // the links, its mark, your notes on it — is on the other tab.
    //
    // Asserted as relative order, not as fixed indices: what this test is about
    // is the sequence, and a section added or moved above should not have to
    // renumber a row it says nothing about.
    const sections = [...host.querySelectorAll('.inspector .scroll > section')]
    const at = (sel: string) => sections.findIndex((s) => s.querySelector(sel) !== null)

    expect(at('#passage-title')).toBe(0)
    expect(at('.editor')).toBeGreaterThan(at('#passage-title'))

    expect(host.querySelector('.inspector #passage-code')).toBeNull()
    expect(host.querySelector('.inspector #passage-note')).toBeNull()
    openAdvanced()
    await nextTick()
    expect(host.querySelector('.inspector #passage-code')).not.toBeNull()
    expect(host.querySelector('.inspector #passage-note')).not.toBeNull()
    expect(host.querySelector('.inspector details')).toBeNull()
    expect(problems).toEqual([])
  })

  it('keeps a refused code on screen until the author deals with it', async () => {
    mount()
    store.newStory('Render Check')
    const first = store.state.doc.nodes[0]!.id
    writeBody(first, '[[Two]]')
    store.select(first)
    await nextTick()

    openAdvanced()
    await nextTick()

    expect(host.querySelector('.inspector .hint-error')).toBeNull()

    // Collide with the code the linked passage just took.
    const taken = store.state.doc.nodes.find((n) => n.id !== first)!.code
    const field = host.querySelector<HTMLInputElement>('#passage-code')!
    field.value = taken
    field.dispatchEvent(new Event('input'))
    field.dispatchEvent(new Event('blur'))
    await nextTick()

    // The field keeps the rejected text and says why. Anything that hid either
    // would leave the author wondering why the code never changed.
    expect(host.querySelector<HTMLInputElement>('#passage-code')!.value).toBe(taken)
    expect(host.querySelector('.inspector .hint-error')!.textContent).toContain(taken)

    // And it survives an edit elsewhere in the sidebar. The Note field commits
    // live on every keystroke, so a watcher on the node object rather than its
    // id would clear the refusal the moment the author typed anything — which is
    // why the watcher is keyed on the id. Note now sits on the Write tab, so this
    // reaches it through the store the way the field itself would.
    store.noteSet(first, 'a')
    await nextTick()
    expect(host.querySelector('.inspector .hint-error')!.textContent).toContain(taken)
    expect(problems).toEqual([])
  })

  it('says which passage a conditional link locks a route to', async () => {
    mount()
    store.newStory('Render Check')
    const first = store.state.doc.nodes[0]!.id
    const byTitle = (t: string) => store.state.doc.nodes.find((n) => n.title === t)!.id
    writeBody(first, '[[Pick]]\n(set:$idol to "p")')
    writeBody(byTitle('Pick'), '(if:$idol is "p")[[Onward]]')
    store.select(byTitle('Onward'))
    await nextTick()

    // One home for the inference, beside the route counts it explains — and the
    // only place it is offered as a jump.
    expect(host.querySelector('.inspector .jump')).toBeNull()
    openAdvanced()
    await nextTick()

    const hints = [...host.querySelectorAll('.inspector .hint')].map((h) =>
      h.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(hints.some((h) => h?.startsWith('Every route here passes'))).toBe(true)
    // The gate is the passage that *assigns* the value, not the one carrying the
    // (if:) — Start does the (set:), so every route here has been through it.
    expect(host.querySelector('.inspector .jump')!.textContent).toContain('Start')
    expect(problems).toEqual([])
  })

  it('says so when no route can satisfy a passage’s condition', async () => {
    mount()
    store.newStory('Render Check')
    const first = store.state.doc.nodes[0]!.id
    // The classic typo: the guard tests a value nothing ever assigns.
    writeBody(first, '(if:$idol is "nope")[[Onward]]')
    store.select(store.state.doc.nodes.find((n) => n.title === 'Onward')!.id)
    await nextTick()
    openAdvanced()
    await nextTick()

    // The graph still links here, so this is the macro-level claim rather than
    // the "no route reaches it" one that sits above it.
    const warn = host.querySelector('.inspector .hint-warn')
    expect(warn?.textContent).toContain('Nothing reaches this passage')
    expect(problems).toEqual([])
  })

  it('keeps a dashed card naming the passage it cannot find', async () => {
    mount()
    store.newStory('Render Check')
    const first = store.state.doc.nodes[0]!.id
    // A link to a code nothing carries: the phantom is never created.
    store.editBody(first, '[[Go on|Nowhere]]')
    setPref('showCodes', true)
    await nextTick()

    // A dashed card still names the target it could not find, so you can
    // double-click and create it.
    const codes = [...host.querySelectorAll('.code-tag')].map((c) => c.textContent?.trim())
    expect(codes).toContain('Nowhere')
    expect(problems).toEqual([])
  })
})

describe('the Developer menu\u2019s screenshot mode', () => {
  /** A card with something in every text slot, and a code drawn above it. */
  async function withEverything() {
    mount()
    store.newStory('Textless')
    const id = store.state.doc.nodes[0]!.id
    setPref('showCodes', true)
    setPref('devMode', true)
    store.rename(id, 'The Rusty Anchor')
    store.tagAdd(id, 'quiet')
    // A tag with no colour draws no stripe, and the stripe is what has to
    // survive the text going away.
    store.tagRecolor('quiet', 'green')
    store.slugSet(id, 'A')
    store.makeStart(id)
    store.select(id)
    store.endingToggleSelected()
    await nextTick()
    return id
  }

  const card = () => host.querySelector('.card')!

  it('draws every glyph before it is turned on', async () => {
    await withEverything()
    expect(card().querySelector('.title')!.textContent).toContain('The Rusty Anchor')
    expect(card().querySelector('.run')).not.toBeNull()
    expect(card().querySelector('.chip')!.textContent).toContain('quiet')
    expect(card().querySelector('.flag')).not.toBeNull()
    expect(host.querySelector('.code-tag')).not.toBeNull()
    expect(problems).toEqual([])
  })

  /**
   * Every glyph goes, and nothing else does. The point of the mode is a
   * screenshot of the structure, so status and shape have to survive it — the
   * state dot, the tag stripes, the start card's accent edge and the ending's
   * bottom rule are all colour, and all stay.
   */
  it('strips the glyphs and keeps the colour', async () => {
    await withEverything()
    setPref('hideCardText', true)
    await nextTick()

    expect(card().querySelector('.title')).toBeNull()
    expect(card().querySelector('.run')).toBeNull()
    expect(card().querySelector('.chip')).toBeNull()
    expect(card().querySelector('.flag')).toBeNull()
    expect(card().querySelector('.foot')).toBeNull()
    expect(host.querySelector('.code-tag')).toBeNull()
    // Not one character left anywhere on the card.
    expect(card().textContent!.trim()).toBe('')

    expect(card().querySelector('.badge')).not.toBeNull()
    expect(card().querySelector('.stripe')).not.toBeNull()
    expect(card().classList.contains('start')).toBe(true)
    expect(card().classList.contains('ending')).toBe(true)
    expect(problems).toEqual([])
  })

  /**
   * The gutter's "Level 3" was the last glyph left in a screenshot taken with
   * the level bands on, which is the default.
   */
  it('takes the level tags in the gutter too', async () => {
    await withEverything()
    expect(host.querySelector('.level-tag')).not.toBeNull()

    setPref('hideCardText', true)
    await nextTick()
    expect(host.querySelector('.level-tag')).toBeNull()
    expect(problems).toEqual([])
  })

  /**
   * A stored pair can disagree — a hand-edited store, or a build from before
   * the rule existed. Left alone it is unrecoverable: blank cards, no menu to
   * fix them, and `setPref('devMode', false)` refused by its own no-op guard.
   */
  it('refuses to load hidden text without the mode that reaches it', async () => {
    localStorage.setItem(
      'storybook.prefs.v1',
      JSON.stringify({ devMode: false, hideCardText: true }),
    )
    reloadPrefs()
    expect(prefs.hideCardText).toBe(false)

    mount()
    store.newStory('Textless')
    await nextTick()
    expect(host.querySelector('.card .title')).not.toBeNull()
    expect(problems).toEqual([])
  })

  it('takes the phantom prompt and the wire captions too', async () => {
    mount()
    store.newStory('Textless')
    setPref('devMode', true)
    const id = store.state.doc.nodes[0]!.id
    // Writing the link creates the passage, so the phantom is what is left
    // after deleting it — the same way a dangling link happens in practice.
    writeBody(id, '[[Head north->Cave]]')
    store.removePassage(store.state.doc.nodes.find((n) => n.code === 'Cave')!.id)
    // A caption is drawn only for an edge touching the selection.
    store.select(id)
    await nextTick()
    expect(host.querySelector('.missing')).not.toBeNull()
    expect(host.querySelector('.edge-label')).not.toBeNull()

    setPref('hideCardText', true)
    await nextTick()
    expect(host.querySelector('.missing')).toBeNull()
    expect(host.querySelector('.edge-label')).toBeNull()
    // The dashed card is still drawn; only its words are gone.
    expect(host.querySelectorAll('.card.phantom')).toHaveLength(1)
    expect(problems).toEqual([])
  })
})

describe('editor settings', () => {
  const gear = () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '\u2699')!

  const panel = () => host.querySelector('[aria-label="Editor settings"]')

  const boxes = () => [
    ...host.querySelectorAll<HTMLInputElement>('[aria-label="Editor settings"] input[type="checkbox"]'),
  ]
  const themes = () => [
    ...host.querySelectorAll<HTMLInputElement>('[aria-label="Default player theme"] input[type="radio"]'),
  ]

  async function openSettings() {
    mount()
    store.newStory('Settings Check')
    await nextTick()
    gear().click()
    await nextTick()
  }

  it('opens from the toolbar with every toggle off', async () => {
    await openSettings()

    expect(panel()).not.toBeNull()
    // Inherit setting, inherit characters, show codes, developer mode. Counted
    // rather than named because the count is the assertion: a row added without
    // a default of `false` would move an author's editor on upgrade.
    expect(boxes()).toHaveLength(4)
    expect(boxes().map((b) => b.checked)).toEqual([false, false, false, false])
    expect(problems).toEqual([])
  })

  it('offers every player theme, with Folio picked until the author says otherwise', async () => {
    await openSettings()
    expect(themes().map((r) => r.value)).toEqual(['marquee', 'folio', 'phosphor', 'daylight'])
    expect(themes().filter((r) => r.checked).map((r) => r.value)).toEqual(['folio'])
    expect(problems).toEqual([])
  })

  it('persists a player theme without touching the story', async () => {
    await openSettings()
    const undoable = store.canUndo.value

    const phosphor = themes().find((r) => r.value === 'phosphor')!
    phosphor.checked = true
    phosphor.dispatchEvent(new Event('change'))
    await nextTick()

    expect(prefs.playerTheme).toBe('phosphor')
    expect(localStorage.getItem('storybook.prefs.v1')).toContain('"playerTheme":"phosphor"')
    expect(store.canUndo.value).toBe(undoable)
    expect(problems).toEqual([])
  })

  it('previews a theme in a new tab, on the sample story, without picking it', async () => {
    await openSettings()
    const stub = stubTab()

    const rows = [...host.querySelectorAll<HTMLElement>('.theme-row')]
    const marquee = rows.find((r) => r.textContent!.includes('Marquee'))!
    marquee.querySelector<HTMLButtonElement>('.preview')!.click()
    await nextTick()

    expect(stub.open).toHaveBeenCalledWith('', '_blank')
    const payload = await stub.payload()
    expect(payload.theme).toBe('marquee')
    expect(payload.title).toBe('The Lighthouse Keeper')
    // A preview is what a reader sees, so no author console.
    expect(payload.author).toBeUndefined()
    expect(prefs.playerTheme).toBe('folio')
    expect(problems).toEqual([])
  })

  it('persists a toggle without touching the story or its history', async () => {
    await openSettings()
    const hash = store.layout.value.stats.hash
    const undoable = store.canUndo.value

    boxes()[0]!.checked = true
    boxes()[0]!.dispatchEvent(new Event('change'))
    await nextTick()

    expect(boxes()[0]!.checked).toBe(true)
    expect(localStorage.getItem('storybook.prefs.v1')).toContain('"inheritSetting":true')
    // A preference is not a document edit: no undo step, no relayout.
    expect(store.canUndo.value).toBe(undoable)
    expect(store.layout.value.stats.hash).toBe(hash)
    expect(problems).toEqual([])
  })

  it('closes on Escape, and keeps the keyboard while it is up', async () => {
    await openSettings()
    const before = store.state.doc.nodes.length

    // `n` would otherwise create a passage behind the veil, out of sight.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }))
    await nextTick()
    expect(store.state.doc.nodes).toHaveLength(before)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(panel()).toBeNull()
    expect(problems).toEqual([])
  })

  it('carries the setting and the cast into a new passage once turned on', async () => {
    await openSettings()
    const id = store.state.doc.nodes[0]!.id

    // The two inheritance boxes, by name rather than by sweeping the panel:
    // this test is about inheritance, and ticking everything would also switch
    // developer mode on and put a menu in the bar it never asked for.
    for (const box of boxes().slice(0, 2)) {
      box.checked = true
      box.dispatchEvent(new Event('change'))
    }
    await nextTick()
    host.querySelector<HTMLButtonElement>('[aria-label="Editor settings"] .btn-primary')!.click()
    await nextTick()

    store.settingSet(id, 'The Rusty Anchor')
    store.characterCreate('Mira')
    store.castAdd(id, 'Mira')
    store.castSetNote(id, 'Mira', 'Furious.')

    const madeId = store.addPassage(id)
    const made = store.state.doc.nodes.find((n) => n.id === madeId)!
    expect(made.setting).toBe('The Rusty Anchor')
    expect(made.characters).toEqual([{ name: 'Mira', note: '' }])

    // The sidebar now says so, where a moment ago it said the opposite.
    store.select(id)
    await nextTick()
    expect(host.querySelector('.inspector')!.textContent).toContain(
      'New passages linked from here start with this cast',
    )
    expect(problems).toEqual([])
  })

  /**
   * The gate itself. `AppMenuBar` drops a group once nothing in it is visible,
   * so the title is the thing to assert on: a row hidden by dimming or by
   * omitting its binding would still leave "Developer" in the bar.
   */
  it('keeps the Developer menu out of the bar until the mode is on', async () => {
    const titles = () =>
      [...host.querySelectorAll('.menubar .title')].map((b) => b.textContent!.trim())

    await openSettings()
    expect(titles()).not.toContain('Developer')

    // The last box in the panel, by the order the sections are written.
    const dev = boxes()[boxes().length - 1]!
    dev.checked = true
    dev.dispatchEvent(new Event('change'))
    await nextTick()
    expect(titles()).toContain('Developer')

    dev.checked = false
    dev.dispatchEvent(new Event('change'))
    await nextTick()
    expect(titles()).not.toContain('Developer')
    expect(problems).toEqual([])
  })

  /**
   * Leaving developer mode has to take its effects with it: the row that puts
   * the text back is in the menu that just disappeared, so without this an
   * author is left looking at blank cards with no way to fix them.
   */
  it('puts the card text back when the mode goes off', async () => {
    mount()
    store.newStory('Settings Check')
    setPref('devMode', true)
    setPref('hideCardText', true)
    await nextTick()
    expect(host.querySelector('.card .title')).toBeNull()

    setPref('devMode', false)
    await nextTick()
    expect(prefs.hideCardText).toBe(false)
    expect(host.querySelector('.card .title')).not.toBeNull()
    expect(problems).toEqual([])
  })

  it('inherits nothing while the toggles are off', async () => {
    mount()
    store.newStory('Settings Check')
    const id = store.state.doc.nodes[0]!.id
    store.settingSet(id, 'The Rusty Anchor')
    store.characterCreate('Mira')
    store.castAdd(id, 'Mira')
    await nextTick()

    const madeId = store.addPassage(id)
    const made = store.state.doc.nodes.find((n) => n.id === madeId)!
    expect(made.setting).toBe('')
    expect(made.characters).toEqual([])
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
    // The gutter is on the left of the stage, and the cheat sheet is in it.
    const gutter = host.querySelector('main')!.firstElementChild!
    expect(gutter.classList.contains('left-gutter')).toBe(true)
    expect(gutter.firstElementChild).toBe(panel)

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

    await runCommand('Cast & Settings')
    expect(host.querySelector('.cheat')).toBeNull()
    expect(host.querySelector('.index')).not.toBeNull()

    await runCommand('Cast & Settings')
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

  it('folds a whole card down to its name, leaving the rest of the cast open', async () => {
    await openOnCast()

    const card = (name: string) =>
      [...host.querySelectorAll<HTMLElement>('.cheat .member')].find(
        (el) => el.querySelector('.name')!.textContent!.trim() === name,
      )!

    expect(card('Mira').textContent).toContain('Guarded')

    card('Mira').querySelector<HTMLButtonElement>('.head-fold')!.click()
    await nextTick()

    // The name and the way to the character sheet are what survive: the point
    // of the fold is a row you can still click, not a card that disappears.
    const shut = card('Mira')
    expect(shut.querySelector('.link')!.textContent!.trim()).toBe('Edit')
    expect(shut.querySelector('.group')).toBeNull()
    expect(shut.textContent).not.toContain('Guarded')
    expect(shut.textContent).not.toContain("The innkeeper's daughter")
    expect(shut.textContent).not.toContain('In this scene: Furious.')

    // Nobody else moved.
    expect(card('Tam').textContent).toContain('No direction written yet.')

    card('Mira').querySelector<HTMLButtonElement>('.head-fold')!.click()
    await nextTick()
    expect(card('Mira').textContent).toContain('Guarded')
    expect(problems).toEqual([])
  })

  it('shuts and reopens the whole cast from one header button', async () => {
    await openOnCast()

    const foldAll = () => host.querySelector<HTMLButtonElement>('.cheat .fold-all')!
    const open = () => host.querySelectorAll('.cheat .member .group').length

    expect(foldAll().textContent!.trim()).toBe('Collapse all')
    expect(open()).toBeGreaterThan(0)

    foldAll().click()
    await nextTick()
    // Every card is down to its name, and the button is now the way back.
    expect(open()).toBe(0)
    expect(host.querySelectorAll('.cheat .member .name')).toHaveLength(2)
    expect(foldAll().textContent!.trim()).toBe('Expand all')

    foldAll().click()
    await nextTick()
    expect(open()).toBeGreaterThan(0)
    expect(foldAll().textContent!.trim()).toBe('Collapse all')
    expect(problems).toEqual([])
  })

  /**
   * The mixed case resolves towards shutting: one card already folded is not
   * "all folded", so the button still offers to clear away the rest rather
   * than undoing the fold the author just made.
   */
  it('still offers to collapse while only some cards are folded', async () => {
    await openOnCast()
    host.querySelector<HTMLButtonElement>('.cheat .member .head-fold')!.click()
    await nextTick()

    const foldAll = () => host.querySelector<HTMLButtonElement>('.cheat .fold-all')!
    expect(foldAll().textContent!.trim()).toBe('Collapse all')

    foldAll().click()
    await nextTick()
    expect(host.querySelectorAll('.cheat .member .group')).toHaveLength(0)
    expect(problems).toEqual([])
  })

  it('offers nothing to collapse on a passage with no cast', async () => {
    mount()
    store.newStory('Cheat Check')
    store.select(store.state.doc.nodes[0]!.id)
    await nextTick()
    await runCommand('Character cheat sheet')

    expect(host.querySelector('.cheat .fold-all')).toBeNull()
    expect(problems).toEqual([])
  })

  /**
   * The two folds are separate sets on purpose: a card is a lid over the
   * groups, not a fourth group. Shutting one and opening it again must leave
   * the subsections exactly as they were, or the lid would silently undo the
   * folding underneath it.
   */
  it('leaves the subsection folds alone through a card fold', async () => {
    await openOnCast()
    groupLabel('Personality').click()
    await nextTick()
    expect(groupLabel('Personality').nextElementSibling).toBeNull()

    const head = () => host.querySelector<HTMLButtonElement>('.cheat .member .head-fold')!
    head().click()
    await nextTick()
    head().click()
    await nextTick()

    // And through the header's button, which folds the same set.
    const foldAll = () => host.querySelector<HTMLButtonElement>('.cheat .fold-all')!
    foldAll().click()
    await nextTick()
    foldAll().click()
    await nextTick()

    expect(groupLabel('Personality').nextElementSibling).toBeNull()
    expect(groupLabel('Dialogue characteristics').nextElementSibling!.textContent).toContain(
      'Clipped sentences',
    )
    expect(problems).toEqual([])
  })

  it('follows the selection, and forgets the folds with it', async () => {
    const id = await openOnCast()
    groupLabel('Personality').click()
    await nextTick()
    expect(groupLabel('Personality').nextElementSibling).toBeNull()

    host.querySelector<HTMLButtonElement>('.cheat .member .head-fold')!.click()
    await nextTick()

    writeBody(id, '[[Two]]')
    const two = store.state.doc.nodes.find((n) => n.title === 'Two')!.id
    store.castAdd(two, 'Mira')
    store.select(two)
    await nextTick()

    const panel = host.querySelector('.cheat')!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('Cast of P2 · Two')
    // Both folds, the card's and the subsection's, come back open.
    expect(panel.querySelector('.member .group')).not.toBeNull()
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

  /**
   * The inspector's link is behind the cast it sits under, so on a passage
   * nobody is cast in yet the menu row is the only way in — which is why the
   * command has a menu home where `passage.expand` beside it has none.
   */
  it('opens from the Story menu on a passage with no cast', async () => {
    mount()
    store.newStory('Cheat Check')
    store.select(store.state.doc.nodes[0]!.id)
    await nextTick()
    expect(host.querySelector('.inspector .cheat-link')).toBeNull()

    await runCommand('Character cheat sheet')
    expect(host.querySelector('.cheat')!.textContent).toContain('No cast in this passage yet')
    expect((await storyRow('Character cheat sheet')).tick).toBe('✓')

    // The same row closes it again, the way the chord does.
    await runCommand('Character cheat sheet')
    expect(host.querySelector('.cheat')).toBeNull()
    expect((await storyRow('Character cheat sheet')).tick).toBe('')
    expect(problems).toEqual([])
  })

  /**
   * The panel is bound to the selection, so with none the row dims rather than
   * opening a sheet about nothing — the same refusal `toggleCheatSheet` makes
   * for the chord. A phantom is the case that forces it: it is a selectable
   * card with no passage behind it, so `selected` is null there too.
   */
  it('dims its menu row with nothing selected, and on a phantom', async () => {
    mount()
    store.newStory('Cheat Check')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, '[[Cave]]')
    store.select(null)
    await nextTick()
    expect((await storyRow('Character cheat sheet')).disabled).toBe(true)

    store.removePassage(store.state.doc.nodes.find((n) => n.title === 'Cave')!.id)
    store.select(store.layout.value.nodes.find((n) => n.isPhantom)!.id)
    await nextTick()
    expect((await storyRow('Character cheat sheet')).disabled).toBe(true)

    store.select(id)
    await nextTick()
    expect((await storyRow('Character cheat sheet')).disabled).toBe(false)
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

  it('sets the state of the whole selection from the sidebar', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    const inspector = host.querySelector('.inspector')!
    const segs = [...inspector.querySelectorAll<HTMLElement>('.batch .seg')]
    expect(segs.map((el) => el.textContent!.trim())).toEqual(['TODO', 'Draft', 'Done'])
    // Everything selected is still TODO, so that segment is the lit one.
    expect(segs.filter((el) => el.classList.contains('on')).map((el) => el.textContent!.trim()))
      .toEqual(['TODO'])

    segs.find((el) => el.textContent!.includes('Done'))!.click()
    await nextTick()

    expect(store.state.doc.nodes.map((n) => n.state)).toEqual(['TODO', 'Done', 'Done'])
    // The badge is what the author actually reads, and only a real render
    // proves the class reached it.
    expect(host.querySelectorAll('.card.state-Done')).toHaveLength(2)
    expect(problems).toEqual([])
  })

  it('lights no state segment while the selection disagrees', async () => {
    await branchingStory()
    store.changeState(store.state.doc.nodes.find((n) => n.title === 'Three')!.id, 'Done')
    await click('Two', { metaKey: true })

    const inspector = host.querySelector('.inspector')!
    expect(inspector.querySelectorAll('.batch .seg.on')).toHaveLength(0)
    expect(inspector.textContent).toContain('Mixed')
    expect(problems).toEqual([])
  })

  it('marks and clears the whole selection as endings from one checkbox', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    const box = host.querySelector<HTMLInputElement>('.inspector .batch .pref input')!
    expect(box.checked).toBe(false)
    expect(box.indeterminate).toBe(false)

    box.click()
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.isEnding)).toEqual([false, true, true])
    expect(host.querySelectorAll('.card .flag-end')).toHaveLength(2)

    // The same box the other way: all-on clears.
    box.click()
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.isEnding)).toEqual([false, false, false])
    expect(host.querySelectorAll('.card .flag-end')).toHaveLength(0)
    expect(problems).toEqual([])
  })

  it('draws the ending box indeterminate while the selection disagrees', async () => {
    await branchingStory()
    store.endingSet(store.state.doc.nodes.find((n) => n.title === 'Three')!.id, true)
    await click('Two', { metaKey: true })

    const box = host.querySelector<HTMLInputElement>('.inspector .batch .pref input')!
    // A dash, not a tick: the selection is one of each, and the box says so
    // rather than claiming either. `render` is the only check that can see it.
    expect(box.indeterminate).toBe(true)
    expect(box.checked).toBe(false)

    // Mixed marks everything rather than clearing the one that is already set.
    box.click()
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.isEnding)).toEqual([false, true, true])
    expect(problems).toEqual([])
  })

  it('puts the whole selection in one setting from the sidebar', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    const field = host.querySelector<HTMLInputElement>('.inspector #batch-setting')!
    const apply = () =>
      [...host.querySelectorAll<HTMLButtonElement>('.inspector .batch .apply')][0]!

    // Nothing to apply yet: the whole selection agrees on having no setting.
    expect(apply().disabled).toBe(true)
    expect(apply().textContent!.trim()).toBe('Clear on 0 passages')

    field.value = 'The cellar'
    field.dispatchEvent(new Event('input'))
    await nextTick()
    expect(apply().disabled).toBe(false)
    expect(apply().textContent!.trim()).toBe('Apply to 2 passages')

    apply().click()
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.setting)).toEqual(['', 'The cellar', 'The cellar'])

    // Applied, so there is nothing left to do — and the reason is on the page,
    // not only in the tooltip.
    expect(apply().disabled).toBe(true)
    expect(host.querySelector('.inspector')!.textContent).toContain('already in this setting')
    expect(problems).toEqual([])
  })

  it('clears the whole selection from an empty field, and says how many', async () => {
    await branchingStory()
    store.settingSet(store.state.doc.nodes.find((n) => n.title === 'Three')!.id, 'Docks')
    await click('Two', { metaKey: true })

    const inspector = host.querySelector('.inspector')!
    // One of each, so the field seeds blank and the hint names the split
    // rather than claiming either setting.
    const field = inspector.querySelector<HTMLInputElement>('#batch-setting')!
    expect(field.value).toBe('')
    // The hint agrees with the button: it does not claim a replace while the
    // button offers a clear.
    expect(inspector.textContent).toContain('Clear the setting on 1 of these 2')
    expect(inspector.textContent).not.toContain('Applying replaces all of them')

    const apply = inspector.querySelector<HTMLButtonElement>('.batch .apply')!
    expect(apply.textContent!.trim()).toBe('Clear on 1 passage')
    expect(apply.disabled).toBe(false)

    apply.click()
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.setting)).toEqual(['', '', ''])
    expect(problems).toEqual([])
  })

  it('keeps the typed setting while the document changes underneath it', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    const field = host.querySelector<HTMLInputElement>('.inspector #batch-setting')!
    field.value = 'The cellar'
    field.dispatchEvent(new Event('input'))
    await nextTick()

    // Every mutation clones, so a draft watching the selected *nodes* would be
    // reset by an edit anywhere in the story — including one the author made
    // with this half-typed.
    store.changeState(store.state.doc.nodes[0]!.id, 'Done')
    await nextTick()
    expect(host.querySelector<HTMLInputElement>('.inspector #batch-setting')!.value).toBe(
      'The cellar',
    )

    // Changing what is selected does reset it, which is the point of the key.
    await click('Start')
    await click('Two', { metaKey: true })
    expect(host.querySelector<HTMLInputElement>('.inspector #batch-setting')!.value).toBe('')
    expect(problems).toEqual([])
  })

  it('toggles the whole selection as endings from the keyboard', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }))
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.isEnding)).toEqual([false, true, true])
    expect(host.querySelectorAll('.card .flag-end')).toHaveLength(2)

    // The box the key stands in for has to follow it, or the sidebar would say
    // one thing while the document said another.
    const box = host.querySelector<HTMLInputElement>('.inspector .batch .pref input')!
    expect(box.checked).toBe(true)
    expect(box.indeterminate).toBe(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }))
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.isEnding)).toEqual([false, false, false])
    expect(problems).toEqual([])
  })

  it('toggles a single passage with the same key', async () => {
    await branchingStory()
    await click('Two')
    expect(store.state.selectedIds).toHaveLength(1)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'E' }))
    await nextTick()
    // Upper case deliberately: a host that reports a shifted letter must not be
    // one where the key does nothing.
    expect(store.state.doc.nodes.map((n) => n.isEnding)).toEqual([false, true, false])
    expect(problems).toEqual([])
  })

  it('leaves the key alone while the author is typing a body', async () => {
    await branchingStory()
    await click('Two')

    const area = host.querySelector<HTMLTextAreaElement>('.inspector textarea.input')!
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }))
    await nextTick()

    // `isTyping` catches it. Writing the word "ending" in a passage must not
    // mark it as one.
    expect(store.state.doc.nodes.map((n) => n.isEnding)).toEqual([false, false, false])
    expect(problems).toEqual([])
  })

  it('sets the state of the whole selection from the digit keys', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }))
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.state)).toEqual(['TODO', 'Done', 'Done'])
    expect(host.querySelectorAll('.card.state-Done')).toHaveLength(2)

    // The segment the key stands in for has to follow it.
    const on = [...host.querySelectorAll<HTMLElement>('.inspector .batch .seg.on')]
    expect(on.map((el) => el.textContent!.trim())).toEqual(['Done'])

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }))
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.state)).toEqual(['TODO', 'Draft', 'Draft'])

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }))
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.state)).toEqual(['TODO', 'TODO', 'TODO'])
    expect(problems).toEqual([])
  })

  it('sets a single passage with the same digits', async () => {
    await branchingStory()
    await click('Two')
    expect(store.state.selectedIds).toHaveLength(1)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }))
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.state)).toEqual(['TODO', 'Done', 'TODO'])
    expect(problems).toEqual([])
  })

  it('ignores a digit no state sits at', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    // `NODE_STATES` has three entries, so 4 and 0 index past and before it. A
    // bare `Number(key)` without the bounds the lookup gives would read 0 as a
    // state and set the first one.
    for (const key of ['0', '4', '9']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key }))
    }
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.state)).toEqual(['TODO', 'TODO', 'TODO'])
    expect(problems).toEqual([])
  })

  it('leaves the digits alone while the author is typing a body', async () => {
    await branchingStory()
    await click('Two')

    const area = host.querySelector<HTMLTextAreaElement>('.inspector textarea.input')!
    area.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }))
    await nextTick()

    // Writing "3 doors" in a passage must not mark it Done.
    expect(store.state.doc.nodes.map((n) => n.state)).toEqual(['TODO', 'TODO', 'TODO'])
    expect(problems).toEqual([])
  })

  it('stands the key down behind the character sheet', async () => {
    await branchingStory()
    store.characterCreate('Mira')
    await click('Two', { metaKey: true })
    store.openCharacterSheet('Mira')
    await nextTick()
    expect(host.querySelector('.veil')).not.toBeNull()

    // The sheet's own controls are buttons, so `isTyping` is false and nothing
    // else catches them. Without the sheet in `modalOpen` these would reach the
    // canvas underneath and edit a selection nobody can see.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }))
    await nextTick()

    expect(store.state.doc.nodes.map((n) => n.isEnding)).toEqual([false, false, false])
    expect(store.state.doc.nodes.map((n) => n.state)).toEqual(['TODO', 'TODO', 'TODO'])
    expect(store.state.doc.nodes).toHaveLength(3)
    expect(problems).toEqual([])
  })

  it('nudges the whole selection from the sidebar', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    const arrows = () => [...host.querySelectorAll<HTMLButtonElement>('.inspector .level-btns .btn')]
    const [up, down] = arrows() as [HTMLButtonElement, HTMLButtonElement]
    expect(up.disabled).toBe(true)
    expect(down.disabled).toBe(false)

    down.click()
    await nextTick()

    expect(store.state.doc.nodes.map((n) => n.levelOffset)).toEqual([0, 1, 1])
    // Three drops two, not one: Two's nudge raised the floor under it first.
    expect(store.layout.value.nodes.map((n) => n.level)).toEqual([1, 3, 5])

    const [up2, down2] = arrows() as [HTMLButtonElement, HTMLButtonElement]
    expect(up2.disabled).toBe(false)
    expect(down2.disabled).toBe(true)

    up2.click()
    await nextTick()
    expect(store.state.doc.nodes.map((n) => n.levelOffset)).toEqual([0, 0, 0])
    expect(problems).toEqual([])
  })

  it('dims both arrows and says why while the selection disagrees', async () => {
    await branchingStory()
    await click('Three')
    host.querySelector<HTMLButtonElement>('.inspector [data-tab="advanced"]')!.click()
    await nextTick()
    host.querySelectorAll<HTMLButtonElement>('.inspector .level-btns .btn')[1]!.click()
    await nextTick()

    await click('Two', { metaKey: true })
    const arrows = [...host.querySelectorAll<HTMLButtonElement>('.inspector .level-btns .btn')]
    expect(arrows.map((b) => b.disabled)).toEqual([true, true])

    // A disabled control whose reason is invisible is the failure this whole
    // file exists to catch, so the hint has to name it.
    const level = host.querySelector('.inspector .level')!.closest('section')!
    expect(level.textContent).toContain('Mixed')
    expect(level.textContent).toContain('1 of 2')
    expect(problems).toEqual([])
  })

  it('moves a single passage through the same action', async () => {
    await branchingStory()
    await click('Three')
    expect(store.state.selectedIds).toEqual([store.state.selectedId])
    host.querySelector<HTMLButtonElement>('.inspector [data-tab="advanced"]')!.click()
    await nextTick()

    const [up, down] = [
      ...host.querySelectorAll<HTMLButtonElement>('.inspector .level-btns .btn'),
    ] as [HTMLButtonElement, HTMLButtonElement]
    expect(up.disabled).toBe(true)
    down.click()
    await nextTick()

    expect(store.state.doc.nodes.map((n) => n.levelOffset)).toEqual([0, 0, 1])
    expect(problems).toEqual([])
  })

  it('keeps no empty section above the footer while nothing is pending', async () => {
    await branchingStory()
    await click('Two', { metaKey: true })

    // `.scroll` is a flex column with a gap, so a section rendering nothing
    // still costs 16px of dead space above the footer.
    const sections = host.querySelectorAll('.inspector .scroll > section')
    expect([...sections].every((el) => el.textContent!.trim().length > 0)).toBe(true)
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

describe('story notes', () => {
  async function withStory() {
    mount()
    store.newStory('Notes Check')
    await nextTick()
  }

  function type(text: string) {
    const pad = host.querySelector<HTMLTextAreaElement>('.notes .pad')!
    pad.value = text
    pad.dispatchEvent(new Event('input'))
  }

  it('opens from the toolbar and writes straight to the document', async () => {
    await withStory()
    expect(host.querySelector('.left-gutter')).toBeNull()

    await runCommand('Story notes')
    expect(host.querySelector('.notes')).not.toBeNull()

    type('Mira never learns the truth.')
    await nextTick()
    expect(store.state.doc.notes).toBe('Mira never learns the truth.')
    expect(problems).toEqual([])
  })

  it('closes on a second Cmd J pressed from inside its own textarea', async () => {
    await withStory()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true }))
    await nextTick()
    const pad = host.querySelector<HTMLTextAreaElement>('.notes .pad')!
    expect(pad).not.toBeNull()

    // The panel focuses its own field, so a shortcut that stood down while
    // typing could open it and never close it again.
    pad.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true }))
    await nextTick()
    expect(host.querySelector('.notes')).toBeNull()
    expect(host.querySelector('.left-gutter')).toBeNull()
    expect(problems).toEqual([])
  })

  it('stacks under the index, always at the bottom, and outlives it', async () => {
    await withStory()
    await runCommand('Story notes')
    await runCommand('Cast & Settings')

    const gutter = host.querySelector('.left-gutter')!
    expect(gutter.children).toHaveLength(2)
    expect(gutter.firstElementChild!.classList.contains('index')).toBe(true)
    expect(gutter.lastElementChild!.classList.contains('notes')).toBe(true)

    await runCommand('Cast & Settings')
    expect(host.querySelector('.index')).toBeNull()
    expect(host.querySelector('.notes')).not.toBeNull()
    expect(problems).toEqual([])
  })

  it('survives a cleared selection that closes the cheat sheet', async () => {
    await withStory()
    const id = store.state.doc.nodes[0]!.id
    store.select(id)
    await runCommand('Story notes')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await nextTick()
    expect(host.querySelector('.cheat')).not.toBeNull()

    store.select(null)
    await nextTick()
    // The cheat sheet belongs to a passage; the notes belong to the story.
    expect(host.querySelector('.cheat')).toBeNull()
    expect(host.querySelector('.notes')).not.toBeNull()
    expect(problems).toEqual([])
  })

  it('stays lit beside the body editor, unless the index is up beside it', async () => {
    await withStory()
    const id = store.state.doc.nodes[0]!.id
    store.select(id)
    await runCommand('Story notes')

    const inset = () =>
      host.querySelector<HTMLElement>('.app')!.style.getPropertyValue('--veil-inset')

    host.querySelector<HTMLButtonElement>('.inspector .expand')!.click()
    await nextTick()
    expect(host.querySelector('.veil')).not.toBeNull()
    expect(inset()).toBe('var(--left-panel-w)')

    // The index selects passages, and the open dialog is bound to the
    // selection — so while it is up the whole column dims, notes included.
    await runCommand('Cast & Settings')
    expect(inset()).toBe('0px')
    expect(problems).toEqual([])
  })
})

describe('the recode panel', () => {
  async function withBranch() {
    mount()
    store.newStory('Recode Check')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, '[[Two]]\n[[Three]]')
    setPref('showCodes', true)
    await nextTick()

    await runCommand('Recode…')
    return host.querySelector('[aria-label="Recode passages"]')!
  }

  it('previews every passage, and re-reads the tree as the separator is typed', async () => {
    const panel = await withBranch()
    expect(panel).not.toBeNull()

    const rows = [...panel.querySelectorAll('.row')].map((r) => r.textContent!.replace(/\s+/g, ' ').trim())
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('P1')
    expect(rows[0]).toContain('1N01')

    const separator = panel.querySelectorAll<HTMLInputElement>('input.field')[1]!
    separator.value = '/'
    separator.dispatchEvent(new Event('input'))
    await nextTick()
    expect(panel.querySelector('.row')!.textContent).toContain('1/01')

    expect(problems).toEqual([])
  })

  it('switches numbering scheme from the segmented control', async () => {
    const panel = await withBranch()
    const [, node] = panel.querySelectorAll<HTMLButtonElement>('.seg')
    node!.click()
    await nextTick()

    expect(panel.querySelector('.row')!.textContent).toContain('P01')
    // Node mode offers one field, not two.
    expect(panel.querySelectorAll('input.field')).toHaveLength(1)
    expect(problems).toEqual([])
  })

  it('writes every code and closes when applied', async () => {
    const panel = await withBranch()
    panel.querySelector<HTMLButtonElement>('.btn-primary')!.click()
    await nextTick()

    expect(host.querySelector('[aria-label="Recode passages"]')).toBeNull()
    const codes = [...host.querySelectorAll('.code-tag')].map((el) => el.textContent?.trim())
    expect(codes.sort()).toEqual(['1N01', '2N01', '2N02'])
    expect(problems).toEqual([])
  })
})

describe('endings and the stats panel', () => {
  it('marks a passage as an ending from the inspector and shows it on the card', async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    writeBody(startId, '[[Two]]\n[[Three]]')
    const twoId = store.state.doc.nodes.find((n) => n.title === 'Two')!.id
    store.select(twoId)
    await nextTick()

    openAdvanced()
    await nextTick()

    const box = [...host.querySelectorAll<HTMLInputElement>('.inspector input[type=checkbox]')]
    expect(box).toHaveLength(1)
    expect(box[0]!.checked).toBe(false)

    box[0]!.checked = true
    box[0]!.dispatchEvent(new Event('change'))
    await nextTick()

    expect(store.state.doc.nodes.find((n) => n.id === twoId)!.isEnding).toBe(true)
    expect(host.querySelectorAll('.card.ending')).toHaveLength(1)
    expect(host.querySelector('.card.ending .flag-end')!.textContent).toBe('END')
    expect(problems).toEqual([])
  })

  it('opens the stats panel from the toolbar and reports the story', async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    writeBody(startId, '[[Two]]\n[[Three]]')
    const twoId = store.state.doc.nodes.find((n) => n.title === 'Two')!.id
    store.endingSet(twoId, true)
    await nextTick()

    // The menu item, not the pill: this is the discoverable way in.
    await runCommand('Stats')

    const sheet = host.querySelector('[aria-label="Story statistics"]')
    expect(sheet).not.toBeNull()
    expect(sheet!.textContent).toContain('Story stats')
    expect(sheet!.textContent).toContain('Endings')
    expect(sheet!.textContent).toContain('Draft health')
    // One route of the two reaches the marked ending; the other stops at an
    // unmarked dead end, so the reconciling row has to be there too.
    expect(sheet!.textContent).toContain('50%')
    expect(sheet!.textContent).toContain('Stopping at an unmarked dead end')
    expect(problems).toEqual([])
  })

  it('expands a lint group and jumps to the passage it names', async () => {
    mount()
    store.newStory('Render Check')
    writeBody(store.state.doc.nodes[0]!.id, '[[Two]]')
    await nextTick()

    const before = stageTransform()
    host.querySelector<HTMLButtonElement>('.pill.paths')!.click()
    await nextTick()

    const heads = [...host.querySelectorAll<HTMLButtonElement>('.lint-head')]
    const deadEnds = heads.find((h) => h.textContent!.includes('Dead ends not marked'))!
    expect(deadEnds.disabled).toBe(false)
    deadEnds.click()
    await nextTick()

    const entry = host.querySelector<HTMLButtonElement>('.entries .link')!
    expect(entry.textContent).toContain('Two')
    entry.click()
    await nextTick()

    // Following a row closes the panel and selects what it named.
    expect(host.querySelector('[aria-label="Story statistics"]')).toBeNull()
    expect(store.state.selectedId).toBe(store.state.doc.nodes.find((n) => n.title === 'Two')!.id)
    // Selecting alone is not jumping: the panel closes over whatever the author
    // was looking at, so the canvas has to travel to the card as well.
    expect(host.querySelector('.inspector')).not.toBeNull()
    expect(host.querySelector('.inspector input')).toHaveProperty('value', 'Two')
    expect(stageTransform()).not.toBe(before)
    expect(problems).toEqual([])
  })

  it('jumps to a broken link without opening the inspector on nothing', async () => {
    mount()
    store.newStory('Render Check')
    writeBody(store.state.doc.nodes[0]!.id, '[[Cave]]')
    store.removePassage(store.state.doc.nodes.find((n) => n.title === 'Cave')!.id)
    await nextTick()

    const before = stageTransform()
    host.querySelector<HTMLButtonElement>('.pill.paths')!.click()
    await nextTick()

    const heads = [...host.querySelectorAll<HTMLButtonElement>('.lint-head')]
    heads.find((h) => h.textContent!.includes('Broken links'))!.click()
    await nextTick()
    host.querySelector<HTMLButtonElement>('.entries .link')!.click()
    await nextTick()

    // A phantom is a card on the canvas, not a passage: selecting it is what
    // shows the author where the broken link is, and the inspector must stay
    // shut rather than render an empty column.
    const phantom = store.layout.value.nodes.find((n) => n.isPhantom)!
    expect(store.state.selectedId).toBe(phantom.id)
    expect(host.querySelector('[aria-label="Story statistics"]')).toBeNull()
    expect(host.querySelector('.inspector')).toBeNull()
    expect(stageTransform()).not.toBe(before)
    expect(problems).toEqual([])
  })

  it('will not stack the stats sheet on the modal the author is typing in', async () => {
    mount()
    store.newStory('Render Check')
    store.select(store.state.doc.nodes[0]!.id)
    await nextTick()

    const press = async (key: string) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true }))
      await nextTick()
    }

    await press('e')
    expect(host.querySelector('[aria-label="Edit passage body"]')).not.toBeNull()

    // Both listen for Escape on the window, so one press would close the sheet
    // and the editor underneath it — losing the author's place mid-sentence.
    await press('/')
    expect(host.querySelector('[aria-label="Story statistics"]')).toBeNull()
    expect(host.querySelector('[aria-label="Edit passage body"]')).not.toBeNull()

    // With nothing else up the key still works, and still closes what it opened.
    await press('e')
    await press('/')
    expect(host.querySelector('[aria-label="Story statistics"]')).not.toBeNull()
    await press('/')
    expect(host.querySelector('[aria-label="Story statistics"]')).toBeNull()
    expect(problems).toEqual([])
  })
})

describe('the advanced tab', () => {
  /** Select the starter story's first passage with the sidebar open. */
  async function openStart(): Promise<string> {
    mount()
    store.newStory('Render Check')
    const id = store.state.doc.nodes[0]!.id
    store.select(id)
    await nextTick()
    return id
  }

  it('splits the sidebar, keeping prose on Write and structure on Advanced', async () => {
    await openStart()

    // Write: the passage as prose. Nothing structural competes for the top of
    // the column any more.
    const write = host.querySelector('.inspector .scroll')!
    expect(write.querySelector('#passage-title')).not.toBeNull()
    expect(write.querySelector('.editor')).not.toBeNull()
    expect(write.querySelector('#passage-note')).toBeNull()
    expect(write.querySelector('#passage-code')).toBeNull()
    expect(write.querySelector('#passage-slug')).toBeNull()
    expect(write.textContent).not.toContain('Level 1')

    openAdvanced()
    await nextTick()

    // Advanced: the claims about where this passage sits in the story.
    const advanced = host.querySelector('.inspector .scroll')!
    expect(advanced.querySelector('#passage-code')).not.toBeNull()
    expect(advanced.querySelector('#passage-slug')).not.toBeNull()
    expect(advanced.querySelector('#passage-note')).not.toBeNull()
    expect(advanced.textContent).toContain('Level 1')
    expect(advanced.textContent).toContain('Mark as Ending')
    expect(advanced.textContent).toContain('Routes from here')
    expect(advanced.querySelector('#passage-title')).toBeNull()
    expect(advanced.querySelector('.editor')).toBeNull()

    expect(problems).toEqual([])
  })

  it('switches back to a working body editor', async () => {
    const id = await openStart()
    openAdvanced()
    await nextTick()

    host.querySelector<HTMLButtonElement>('.inspector [data-tab="write"]')!.click()
    await nextTick()

    const area = host.querySelector<HTMLTextAreaElement>('.inspector textarea.input')!
    area.value = 'Back at it.'
    area.dispatchEvent(new Event('input'))
    await nextTick()

    expect(store.state.doc.nodes.find((n) => n.id === id)!.body).toBe('Back at it.')
    expect(problems).toEqual([])
  })

  /**
   * The one real hazard in the tab split.
   *
   * Switching unmounts the editor, and whether a focused-then-removed textarea
   * fires `blur` is browser- and jsdom-dependent — so a tab that left link
   * resolution to `@settle` would skip it intermittently, and the passage the
   * link names would never be created. `pickTab` settles explicitly instead.
   */
  it('resolves a link the author leaves by switching tabs', async () => {
    const id = await openStart()
    writeBody(id, '')
    await nextTick()

    const area = host.querySelector<HTMLTextAreaElement>('.inspector textarea.input')!
    area.value = 'One way out. [[Head north]]'
    area.dispatchEvent(new Event('input'))
    await nextTick()

    // Still mid-edit: written, not yet bound.
    expect(store.state.doc.nodes).toHaveLength(1)

    openAdvanced()
    await nextTick()

    const made = store.state.doc.nodes.find((n) => n.title === 'Head north')
    expect(made).toBeDefined()
    expect(store.state.doc.nodes.find((n) => n.id === id)!.body).toBe(
      `One way out. [[Head north|${made!.code}]]`,
    )
    expect(problems).toEqual([])
  })

  /**
   * Every field here commits on blur, and the swap unmounts the one being typed
   * in. Clicking a `<button>` moves focus on Chrome but not on Safari or Firefox
   * for macOS, and no browser fires `blur` for a focused element removed from
   * the DOM — so a draft left to `@blur` survives on some browsers and not
   * others. jsdom fires no blur here at all, which is exactly the bad case.
   */
  it('commits a half-typed title rather than dropping it', async () => {
    const id = await openStart()

    const title = host.querySelector<HTMLInputElement>('#passage-title')!
    title.value = 'The Long Road'
    title.dispatchEvent(new Event('input'))

    openAdvanced()
    await nextTick()

    expect(store.state.doc.nodes.find((x) => x.id === id)!.title).toBe('The Long Road')
    expect(problems).toEqual([])
  })

  it('commits a half-typed note and slug rather than dropping them', async () => {
    const id = await openStart()
    openAdvanced()
    await nextTick()

    // Advanced holds three fields that commit on blur — note, slug and code —
    // and `v-if` unmounts all three at once. Whether a focused-then-removed
    // field fires `blur` is browser-dependent, so the swap commits them itself.
    const note = host.querySelector<HTMLTextAreaElement>('#passage-note')!
    note.value = 'needs a rewrite\n\nand a name for the innkeeper'
    note.dispatchEvent(new Event('input'))
    const slug = host.querySelector<HTMLInputElement>('#passage-slug')!
    slug.value = 'LY'
    slug.dispatchEvent(new Event('input'))

    host.querySelector<HTMLButtonElement>('.inspector [data-tab="write"]')!.click()
    await nextTick()

    const n = store.state.doc.nodes.find((x) => x.id === id)!
    expect(n.note).toBe('needs a rewrite\n\nand a name for the innkeeper')
    expect(n.slug).toBe('LY')
    expect(problems).toEqual([])
  })

  it('shows the note filter chip only when a note exists, and filters on it', async () => {
    mount()
    store.newStory('Render Check')
    const id = store.state.doc.nodes[0]!.id
    writeBody(id, '[[Two]]')
    await nextTick()

    const chip = () =>
      [...host.querySelectorAll('.bar .chip')].find((c) => c.textContent?.trim() === 'Note')
    expect(chip()).toBeUndefined()

    store.noteSet(id, 'the innkeeper still needs a name')
    await nextTick()
    expect(chip()).not.toBeUndefined()

    ;(chip() as HTMLButtonElement).click()
    await nextTick()
    expect(store.state.noteFilter).toBe(true)
    expect([...(store.matches.value ?? [])]).toEqual([id])
    expect(chip()!.getAttribute('aria-pressed')).toBe('true')

    store.clearFilters()
    await nextTick()
    expect(problems).toEqual([])
  })

  it('marks the Advanced tab when the passage is carrying a note', async () => {
    const id = await openStart()
    const dot = () => host.querySelector('.inspector [data-tab="advanced"] .dot')

    // Nothing to say yet.
    expect(dot()).toBeNull()

    store.noteSet(id, 'the innkeeper still needs a name')
    await nextTick()
    // The note lives behind this tab now, so the tab is the only thing that can
    // say it is there without opening it.
    expect(dot()).not.toBeNull()
    expect(
      host.querySelector('.inspector [data-tab="advanced"]')!.getAttribute('title'),
    ).toContain('note')

    store.noteSet(id, '')
    await nextTick()
    expect(dot()).toBeNull()
    expect(problems).toEqual([])
  })

  it('reads the route out without contradicting itself', async () => {
    const id = await openStart()
    writeBody(id, '[[Two]]')
    const two = store.state.doc.nodes.find((n) => n.id !== id)!.id
    store.slugSet(id, 'A')
    store.slugSet(two, 'B')
    store.select(two)
    await nextTick()
    openAdvanced()
    await nextTick()

    // The readout is one chain. Written as two, the `v-else` meant for "no
    // route arrives" paired with the note above it and fired for every marked
    // passage the canvas was drawing — printing the route and then denying it.
    const readout = host.querySelector('.readout')!.textContent!.replace(/\s+/g, ' ')
    expect(readout).toContain('AB')
    expect(readout).not.toContain('No route')
    expect(readout).not.toContain('Not on the card')
    expect(problems).toEqual([])
  })

  it('lets an undo take the field back with the document', async () => {
    const id = await openStart()
    openAdvanced()
    await nextTick()

    const field = () => host.querySelector<HTMLInputElement>('#passage-slug')!
    field().value = 'LY'
    field().dispatchEvent(new Event('input'))
    field().dispatchEvent(new Event('blur'))
    await nextTick()
    expect(store.state.doc.nodes.find((n) => n.id === id)!.slug).toBe('LY')

    store.undo()
    await nextTick()

    // Keyed on the passage's id rather than the passage, the draft would still
    // be holding `LY` here — and the next blur would commit it back over the
    // undo, which is a mutation the author never made.
    expect(field().value).toBe('')
    field().dispatchEvent(new Event('blur'))
    await nextTick()
    expect(store.state.doc.nodes.find((n) => n.id === id)!.slug).toBe('')
    expect(problems).toEqual([])
  })

  it('will not carry a refused code away to the other tab', async () => {
    const id = await openStart()
    writeBody(id, '[[Two]]')
    const taken = store.state.doc.nodes.find((n) => n.id !== id)!.code
    openAdvanced()
    await nextTick()

    const field = host.querySelector<HTMLInputElement>('#passage-code')!
    field.value = taken
    field.dispatchEvent(new Event('input'))

    // Leaving would unmount the field holding the rejected text along with the
    // only explanation of why the code never changed.
    host.querySelector<HTMLButtonElement>('.inspector [data-tab="write"]')!.click()
    await nextTick()

    expect(host.querySelector('.inspector #passage-code')).not.toBeNull()
    expect(host.querySelector('.inspector .hint-error')!.textContent).toContain(taken)
    expect(store.state.doc.nodes.find((n) => n.id === id)!.code).not.toBe(taken)

    // Escape reverts the draft, which clears the refusal and unblocks the tab.
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    host.querySelector<HTMLButtonElement>('.inspector [data-tab="write"]')!.click()
    await nextTick()
    expect(host.querySelector('.inspector #passage-title')).not.toBeNull()
    expect(problems).toEqual([])
  })

  it('opens the expanded editor from either tab', async () => {
    await openStart()
    openAdvanced()
    await nextTick()

    // The dialog is a sibling of both panels, so the tab underneath is
    // irrelevant to it — and closing returns the author where they were.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', metaKey: true }))
    await nextTick()
    expect(host.querySelector('[aria-label="Edit passage body"]')).not.toBeNull()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', metaKey: true }))
    await nextTick()
    expect(host.querySelector('[aria-label="Edit passage body"]')).toBeNull()
    expect(host.querySelector('.inspector #passage-code')).not.toBeNull()
    expect(problems).toEqual([])
  })

  it('counts routes in both directions, and links as written', async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    writeBody(startId, '[[Two]]\n[[Three]]')
    const twoId = store.state.doc.nodes.find((n) => n.title === 'Two')!.id
    writeBody(twoId, '[[Three]]')
    store.select(twoId)
    await nextTick()
    openAdvanced()
    await nextTick()

    const tiles = [...host.querySelectorAll('.inspector .stat')].map((el) => [
      el.querySelector('.muted')!.textContent!.trim(),
      el.querySelector('strong')!.textContent!.trim(),
    ])
    expect(Object.fromEntries(tiles)).toMatchObject({
      'Routes from here': '1',
      'Routes leading here': '1',
      'Links out': '1',
      'Links in': '1',
    })
    expect(problems).toEqual([])
  })

  /**
   * The word tile, and the one thing worth pinning about it: the count is the
   * story's count. A second rule written in the component would let the tile and
   * Story Stats disagree about one passage, which is the drift the shared
   * `wordCount` exists to prevent — so the assertion is against that function's
   * answer, syntax included, and it tracks the body as it is typed.
   */
  it('counts the passage\u2019s own words, syntax included, as the author types', async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    writeBody(startId, 'The road forks here. [[Head north|Two]]')
    store.select(startId)
    await nextTick()
    openAdvanced()
    await nextTick()

    const words = () =>
      [...host.querySelectorAll('.inspector .stat')]
        .find((el) => el.querySelector('.muted')!.textContent!.trim() === 'Words')!
        .querySelector('strong')!.textContent!.trim()

    // Six: four words of prose, and the link splits at the space inside it,
    // because the count is of the raw source rather than of the rendered page.
    expect(words()).toBe(String(wordCount('The road forks here. [[Head north|Two]]')))
    expect(words()).toBe('6')

    // A keystroke moves it, with no blur in between.
    store.editBody(startId, 'The road forks here again. [[Head north|Two]]')
    await nextTick()
    expect(words()).toBe('7')

    // An empty body is zero, not one.
    store.editBody(startId, '   \n  ')
    await nextTick()
    expect(words()).toBe('0')
    expect(problems).toEqual([])
  })

  /**
   * The number the sidebar could not show before, and the reason it is worth a
   * tile: zero means the author cannot get here, which nothing on the canvas says.
   */
  it('reports the share of complete routes running through a passage', async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    // Start branches to A and B; A branches again to C and D. Three complete
    // routes: Start->A->C, Start->A->D, Start->B.
    writeBody(startId, '[[A]]\n[[B]]')
    const aId = store.state.doc.nodes.find((n) => n.title === 'A')!.id
    writeBody(aId, '[[C]]\n[[D]]')

    const sub = () =>
      host.querySelector('.inspector .stat .sub')?.textContent!.replace(/\s+/g, ' ').trim()

    store.select(aId)
    await nextTick()
    openAdvanced()
    await nextTick()
    expect(sub()).toBe('on 66.7% of all routes')

    // A leaf is on exactly the routes that reach it.
    store.select(store.state.doc.nodes.find((n) => n.title === 'C')!.id)
    await nextTick()
    expect(sub()).toBe('on 33.3% of all routes')

    // Every route passes the start.
    store.select(startId)
    await nextTick()
    expect(sub()).toBe('on 100% of all routes')
    expect(problems).toEqual([])
  })

  /**
   * An Ending that still has links leaving it is allowed — `setEnding` has no
   * guard, and the app reports it rather than refusing it. So "leaf" and
   * "terminal" can disagree, and the share has to agree with the count beside
   * it rather than counting straight through.
   */
  it('stops counting at a marked Ending, the way the count beside it does', async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    writeBody(startId, '[[A]]')
    const aId = store.state.doc.nodes.find((n) => n.title === 'A')!.id
    writeBody(aId, '[[B]]')
    const bId = store.state.doc.nodes.find((n) => n.title === 'B')!.id

    store.select(bId)
    await nextTick()
    openAdvanced()
    await nextTick()
    const sub = () =>
      host.querySelector('.inspector .stat .sub')?.textContent!.replace(/\s+/g, ' ').trim()
    expect(sub()).toBe('on 100% of all routes')

    store.endingSet(aId, true)
    await nextTick()

    // B is stranded now. Both halves of the tile must say so together.
    expect(sub()).toBe('on 0% of all routes')
    expect(host.querySelector('.inspector')!.textContent).toContain(
      'No route from the start reaches this passage',
    )
    expect(problems).toEqual([])
  })

  it('reports a passage no route reaches, and exempts the start', async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    writeBody(startId, '[[Two]]')
    const twoId = store.state.doc.nodes.find((n) => n.title === 'Two')!.id

    // Marking the start as an Ending strands everything past it.
    store.endingSet(startId, true)
    store.select(twoId)
    await nextTick()
    openAdvanced()
    await nextTick()

    expect(host.querySelector('.inspector')!.textContent).toContain(
      'No route from the start reaches this passage',
    )

    // The start itself counts zero because routes begin there rather than
    // arriving, so it must never be accused.
    store.select(startId)
    await nextTick()
    expect(host.querySelector('.inspector')!.textContent).not.toContain(
      'No route from the start reaches this passage',
    )
    expect(problems).toEqual([])
  })

  it('jumps to the passage a gate names', async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    writeBody(startId, '[[Camp]]')
    const campId = store.state.doc.nodes.find((n) => n.title === 'Camp')!.id
    writeBody(campId, '(set: $lantern to "lit")\n[[Cellar]]')
    const cellarId = store.state.doc.nodes.find((n) => n.title === 'Cellar')!.id
    writeBody(cellarId, '(if: $lantern is "lit")[ [[Deeper]] ]')
    store.select(store.state.doc.nodes.find((n) => n.title === 'Deeper')!.id)
    await nextTick()
    openAdvanced()
    await nextTick()

    const jump = host.querySelector<HTMLButtonElement>('.inspector .jump')
    expect(jump).not.toBeNull()
    expect(jump!.textContent!.trim()).toContain('Camp')

    // Revealing is App.openPassage, not a bare select: it centres the canvas too.
    jump!.click()
    await nextTick()
    expect(store.state.selectedId).toBe(campId)
    expect(problems).toEqual([])
  })

  /**
   * `share` divides in BigInt before rounding, so anything under 0.05% comes
   * back as exactly 0 — and a tile reading "Routes leading here: 1" above "on
   * 0% of all routes" looks like a broken sum rather than a small number.
   */
  it('says <0.1% rather than 0% under a count that is not zero', async () => {
    mount()
    store.newStory('Render Check')
    const startId = store.state.doc.nodes[0]!.id
    const idOf = (t: string) => store.state.doc.nodes.find((n) => n.title === t)!.id
    const codeOf = (t: string) => store.state.doc.nodes.find((n) => n.title === t)!.code

    // Eleven diamonds in a chain double the routes each time, so 2048 run to the
    // end. The side branch off the start sits on exactly one of the 2049 — which
    // is 0.049%, under the tenth `share` can express.
    writeBody(startId, '[[Side]]\n[[N0]]')
    for (let i = 0; i < 11; i++) {
      writeBody(idOf(`N${i}`), `[[A${i}]]\n[[B${i}]]`)
      writeBody(idOf(`A${i}`), `[[N${i + 1}]]`)
      writeBody(idOf(`B${i}`), `[[N${i + 1}|${codeOf(`N${i + 1}`)}]]`)
    }

    store.select(idOf('Side'))
    await nextTick()
    openAdvanced()
    await nextTick()

    const tile = [...host.querySelectorAll('.inspector .stat')].find((e) =>
      e.textContent!.includes('leading here'),
    )!
    expect(tile.querySelector('strong')!.textContent!.trim()).toBe('1')
    expect(tile.querySelector('.sub')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'on <0.1% of all routes',
    )
    expect(problems).toEqual([])
  })

  it('stays on the tab the author chose when the selection changes', async () => {
    const id = await openStart()
    writeBody(id, '[[Two]]')
    openAdvanced()
    await nextTick()

    // Structuring several passages in a row is the workflow; a tab that snapped
    // back to Write on every click would make it impossible.
    store.select(store.state.doc.nodes.find((n) => n.title === 'Two')!.id)
    await nextTick()

    expect(host.querySelector('.inspector #passage-code')).not.toBeNull()
    expect(host.querySelector('.inspector .editor')).toBeNull()
    expect(problems).toEqual([])
  })
})

/**
 * A stand-in for the tab `window.open` returns, and a way to read the page the
 * app sent to it. jsdom has no `URL.createObjectURL`, so the Blob is caught on
 * its way there, which is also the most direct way to see what was built.
 */
function stubTab() {
  const tab = {
    document: document.implementation.createHTMLDocument(''),
    location: { replace: vi.fn() },
    close: vi.fn(),
    // Closed from the start, so the release poll stops at its first tick
    // rather than outliving the test.
    closed: true,
    opener: {} as unknown,
  }
  const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)

  const blobs: Blob[] = []
  // Assigned rather than spied, since jsdom has neither to spy on, so
  // `restoreAllMocks` cannot undo them. Put back when the test ends instead.
  const { createObjectURL, revokeObjectURL } = URL
  onTestFinished(() => {
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  })
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob)
    return 'blob:stub'
  })
  URL.revokeObjectURL = vi.fn()
  return {
    tab,
    open,
    /** The payload of the page that reached the tab. */
    async payload(): Promise<Record<string, unknown>> {
      await vi.waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith('blob:stub'), {
        timeout: 5000,
      })
      const html = await blobs[0]!.text()
      const encoded = /id="story-payload">([^<]*)</.exec(html)![1]!
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
      return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    },
  }
}

describe('playing the story', () => {
  async function withStory(): Promise<void> {
    mount()
    store.newStory('Render Check')
    writeBody(store.state.doc.nodes[0]!.id, 'Prose here.\n\n[[Onward|Two]]')
    await nextTick()
  }

  const playButton = () =>
    [...host.querySelectorAll<HTMLButtonElement>('.toolbar button')].find(
      (b) => b.textContent!.trim() === 'Play',
    )!

  it('opens the player in a new tab from the toolbar, with no sheet over the canvas', async () => {
    await withStory()
    const stub = stubTab()

    playButton().click()
    await nextTick()

    // Synchronously, inside the click: a popup blocker allows nothing later.
    expect(stub.open).toHaveBeenCalledWith('', '_blank')
    expect(host.querySelector('.veil')).toBeNull()

    const payload = await stub.payload()
    expect(payload.theme).toBe(prefs.playerTheme)
    expect(payload.author).toBe(true)
    expect(payload.midStory).toBeUndefined()
    expect(problems).toEqual([])
  })

  it('plays in the theme picked in settings', async () => {
    setPref('playerTheme', 'daylight')
    await withStory()
    const stub = stubTab()

    playButton().click()
    expect((await stub.payload()).theme).toBe('daylight')
    expect(problems).toEqual([])
  })

  it('opens from the passage the author is on with Play from here', async () => {
    await withStory()
    const two = store.state.doc.nodes.find((n) => n.code === 'Two')!
    store.select(two.id)
    await nextTick()
    openAdvanced()
    await nextTick()
    const stub = stubTab()

    const here = [...host.querySelectorAll<HTMLButtonElement>('.inspector button')].find(
      (b) => b.textContent!.trim() === 'Play from here',
    )!
    here.click()
    await nextTick()

    expect(stub.open).toHaveBeenCalledTimes(1)
    expect((await stub.payload()).midStory).toBe(true)
    expect(problems).toEqual([])
  })

  it('opens from Cmd P as well', async () => {
    await withStory()
    const stub = stubTab()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true }))
    await nextTick()

    expect(stub.open).toHaveBeenCalledTimes(1)
    await stub.payload()
    expect(problems).toEqual([])
  })

  it('opens from the selected passage with P', async () => {
    await withStory()
    const two = store.state.doc.nodes.find((n) => n.code === 'Two')!
    store.select(two.id)
    await nextTick()
    const stub = stubTab()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }))
    await nextTick()

    expect(stub.open).toHaveBeenCalledTimes(1)
    expect((await stub.payload()).midStory).toBe(true)
    expect(problems).toEqual([])
  })

  it('leaves P alone with no passage selected, or while typing', async () => {
    await withStory()
    store.select(null)
    await nextTick()
    const stub = stubTab()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }))
    await nextTick()
    expect(stub.open).not.toHaveBeenCalled()

    // A `p` typed into prose is a letter, not a command.
    const two = store.state.doc.nodes.find((n) => n.code === 'Two')!
    store.select(two.id)
    await nextTick()
    const field = document.createElement('textarea')
    host.appendChild(field)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }))
    await nextTick()

    expect(stub.open).not.toHaveBeenCalled()
    expect(problems).toEqual([])
  })

  it('leaves Cmd P alone when there is no start passage, as the menu does', async () => {
    mount()
    store.loadStory(serializeDoc({ ...emptyDoc('No Start') }))
    await nextTick()
    const open = vi.spyOn(window, 'open')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true }))
    await nextTick()

    expect(open).not.toHaveBeenCalled()
    // Not merely a different wording: nothing ran, so there is nothing to say.
    expect(store.state.warnings.join(' ')).not.toMatch(/start passage/)
    expect(problems).toEqual([])
  })

  it('says so when the browser blocks the tab', async () => {
    await withStory()
    vi.spyOn(window, 'open').mockReturnValue(null)

    playButton().click()
    await vi.waitFor(() => expect(store.state.warnings.join(' ')).toMatch(/blocked the new tab/))
    expect(problems).toEqual([])
  })
})

describe('the menu bar', () => {
  async function withStory() {
    mount()
    store.newStory('Menu Check')
    await nextTick()
  }

  function title(group: string) {
    return [...host.querySelectorAll<HTMLButtonElement>('.menubar .title')].find(
      (b) => b.textContent!.trim() === group,
    )!
  }

  function items() {
    return [...host.querySelectorAll<HTMLButtonElement>('.menu-item')]
  }

  function labelled(label: string) {
    return items().find((b) => b.querySelector('.menu-label')!.textContent!.trim() === label)
  }

  it('opens on click and closes on Escape, returning focus to the title', async () => {
    await withStory()
    expect(host.querySelector('.menu-panel')).toBeNull()

    title('Story').click()
    await nextTick()
    expect(host.querySelector('.menu-panel')).not.toBeNull()
    expect(title('Story').getAttribute('aria-expanded')).toBe('true')

    host.querySelector('.menubar')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await nextTick()
    expect(host.querySelector('.menu-panel')).toBeNull()
    expect(document.activeElement).toBe(title('Story'))
    expect(problems).toEqual([])
  })

  it('closes when a pointer lands outside it', async () => {
    await withStory()
    title('View').click()
    await nextTick()
    expect(host.querySelector('.menu-panel')).not.toBeNull()

    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(host.querySelector('.menu-panel')).toBeNull()
    expect(problems).toEqual([])
  })

  /**
   * Hovering a sibling switches to it, so by the time the click arrives that
   * menu is already open — and a plain toggle read the click as "close the
   * thing you are pointing at", which made a menu impossible to open by
   * dragging across the bar and clicking.
   */
  it('stays open when a browsed-to title is then clicked', async () => {
    await withStory()
    title('Story').click()
    await nextTick()

    title('View').dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    expect(labelled('Level guides')).toBeDefined()

    title('View').click()
    await nextTick()
    expect(host.querySelector('.menu-panel')).not.toBeNull()
    expect(labelled('Level guides')).toBeDefined()

    // A second click on the same title does close it.
    title('View').click()
    await nextTick()
    expect(host.querySelector('.menu-panel')).toBeNull()
    expect(problems).toEqual([])
  })

  /**
   * Three rows over one setting, which is a radio group spelled as ticks. The
   * thing that can go wrong is not that a row fails to work — `binds every
   * command it offers` already covers that — but that the group stops being
   * one-of-three: two ticks at once, or none, from a `checked` that compares
   * against the wrong value. Neither is visible to any test that only presses
   * the row and reads the layout back.
   */
  it('ticks exactly one packing row, and moves the tick when another is picked', async () => {
    await withStory()
    const PACKINGS = ['Balanced view', 'Aligned view', 'Straight view']
    const ticked = () =>
      PACKINGS.filter((l) => labelled(l)!.querySelector('.menu-check')!.textContent!.trim() === '✓')

    title('View').click()
    await nextTick()
    for (const label of PACKINGS) expect(labelled(label), label).toBeDefined()
    expect(ticked()).toEqual(['Balanced view'])

    labelled('Straight view')!.click()
    await nextTick()
    expect(prefs.packing).toBe('straight')

    title('View').click()
    await nextTick()
    expect(ticked()).toEqual(['Straight view'])

    // Clicking the row that is already on is a no-op, not a way to end up with
    // no packing at all: these rows set their mode outright rather than toggle.
    labelled('Straight view')!.click()
    await nextTick()
    title('View').click()
    await nextTick()
    expect(ticked()).toEqual(['Straight view'])
    expect(problems).toEqual([])
  })

  it('walks its items with the arrow keys', async () => {
    await withStory()
    title('View').click()
    await nextTick()

    const bar = host.querySelector('.menubar')!
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await nextTick()
    expect(document.activeElement).toBe(items()[0])

    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await nextTick()
    expect(document.activeElement).toBe(items()[1])

    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await nextTick()
    expect(document.activeElement).toBe(items()[0])
    expect(problems).toEqual([])
  })

  /**
   * The guard the open menu exists to need: focus is on a `<button>`, so
   * neither `isTyping` nor `modalOpen` catches these.
   */
  it('stands the canvas keys down while it is up', async () => {
    await withStory()
    const before = store.state.doc.nodes.length

    title('Edit').click()
    await nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }))
    await nextTick()
    expect(store.state.doc.nodes).toHaveLength(before)
    expect(problems).toEqual([])
  })

  it('ticks a toggle that is on, and clears it when it goes off', async () => {
    await withStory()
    title('View').click()
    await nextTick()

    const check = () => labelled('Level guides')!.querySelector('.menu-check')!.textContent!.trim()
    expect(check()).toBe('✓')

    labelled('Level guides')!.click()
    await nextTick()
    title('View').click()
    await nextTick()
    expect(check()).toBe('')
    expect(problems).toEqual([])
  })

  /**
   * Safari and Firefox on macOS do not focus a `<button>` when it is clicked,
   * so a menu opened with the mouse can leave focus on `<body>`. The key
   * handler is on `document` for that reason — bound to the bar, Escape would
   * never arrive and the menu could only be dismissed by clicking away, while
   * `menuOpen` went on swallowing the canvas keys.
   */
  it('closes on Escape even when focus never entered the bar', async () => {
    await withStory()
    title('Story').click()
    await nextTick()
    expect(host.querySelector('.menu-panel')).not.toBeNull()

    // Whatever the browser did with focus, the key arrives at the document.
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(host.querySelector('.menu-panel')).toBeNull()
    expect(problems).toEqual([])
  })

  /** Every chord begins with one of these arriving on its own. */
  it('survives a modifier pressed on its own', async () => {
    await withStory()
    title('Edit').click()
    await nextTick()

    for (const key of ['Shift', 'Meta', 'Control', 'Alt']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      await nextTick()
      expect(`${key}: ${host.querySelector('.menu-panel') !== null}`).toBe(`${key}: true`)
    }
    expect(problems).toEqual([])
  })

  it('ticks the panels that are open, not just the view toggles', async () => {
    await withStory()
    title('Story').click()
    await nextTick()
    const tick = (label: string) =>
      labelled(label)!.querySelector('.menu-check')!.textContent!.trim()
    expect(tick('Cast & Settings')).toBe('')

    labelled('Cast & Settings')!.click()
    await nextTick()
    title('Story').click()
    await nextTick()
    expect(tick('Cast & Settings')).toBe('✓')
    expect(problems).toEqual([])
  })

  /**
   * The toolbar's "+ Passage" made one with no links; folding it into the `n`
   * command removed the only way to make an unlinked passage while something
   * was selected.
   */
  it('still makes an unlinked passage while one is selected', async () => {
    await withStory()
    const id = store.state.doc.nodes[0]!.id
    store.select(id)
    await nextTick()

    const bodyBefore = store.state.doc.nodes[0]!.body
    const countBefore = store.state.doc.nodes.length

    await runCommand('New unlinked passage')

    // A passage was added, and the selected one's prose was not touched — the
    // seed body already names a `P2` in its example, so the code alone proves
    // nothing.
    expect(store.state.doc.nodes).toHaveLength(countBefore + 1)
    expect(store.state.doc.nodes[0]!.body).toBe(bodyBefore)
    expect(problems).toEqual([])
  })

  /**
   * A command in the table with no binding renders as a permanently dimmed
   * row, which is exactly the kind of thing `vue-tsc` cannot see.
   *
   * So the story is first put in a state where every command is genuinely
   * available — something to undo, something to redo, a selection to delete
   * and a start to play from — and anything still dimmed is unbound.
   *
   * Two sweeps, not one, because the level pair is mutually exclusive by
   * design: a passage sits at its floor or one below it, so exactly one of
   * ↑ and ↓ is live in any single state. Asserting that every label comes up
   * live in *some* state still catches the unbound row, which is dimmed in
   * both.
   */
  it('binds every command it offers', async () => {
    await withStory()
    // With developer mode off its two rows do not render, so the sweep would
    // never see them and an unbound one would go unnoticed.
    setPref('devMode', true)
    const id = store.state.doc.nodes[0]!.id
    store.makeStart(id)
    store.addPassage()
    store.addPassage()
    store.undo()
    store.select(id)
    await nextTick()

    const seen = new Set<string>()
    const live = new Set<string>()

    async function sweep() {
      for (const group of ['File', 'Edit', 'View', 'Story', 'Help', 'Developer']) {
        title(group).click()
        await nextTick()
        expect(items().length).toBeGreaterThan(0)
        for (const item of items()) {
          const label = item.querySelector('.menu-label')!.textContent!.trim()
          seen.add(label)
          if (!item.disabled) live.add(label)
        }
      }
    }

    await sweep()
    // The other side of the level pair: nudged down, ↑ is the live one.
    store.levelNudgeSelected(1)
    await nextTick()
    await sweep()

    expect([...seen].filter((label) => !live.has(label))).toEqual([])
    expect(problems).toEqual([])
  })
})

describe('Cast & Settings from the keyboard', () => {
  it('opens and closes on its own chord, even from inside its rename field', async () => {
    mount()
    store.newStory('Index Check')
    store.characterCreate('Mira')
    await nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ';', metaKey: true }))
    await nextTick()
    expect(host.querySelector('.index')).not.toBeNull()

    // The panel's rename fields focus themselves, so a key that stood down
    // while typing could open this and never close it again.
    const field = host.querySelector<HTMLInputElement>('.index input')
    const target = field ?? window
    target.dispatchEvent(new KeyboardEvent('keydown', { key: ';', metaKey: true, bubbles: true }))
    await nextTick()
    expect(host.querySelector('.index')).toBeNull()
    expect(problems).toEqual([])
  })

  it('stands down under a modal', async () => {
    mount()
    store.newStory('Index Check')
    await nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true }))
    await nextTick()
    expect(host.querySelector('[aria-label="Story statistics"]')).not.toBeNull()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ';', metaKey: true }))
    await nextTick()
    expect(host.querySelector('.index')).toBeNull()
    expect(problems).toEqual([])
  })
})

/**
 * What a stored preference does on upgrade, which is a `prefs.ts` question
 * rather than a component one — it is in this file only because `localStorage`
 * is, and every other test file runs in vitest's `node` environment.
 */
describe('a preference store written by an older build', () => {
  beforeEach(() => resetPrefs())
  afterEach(() => resetPrefs())

  /**
   * `packing` was the boolean `alignedView` until a third mode existed, so an
   * author who had ticked Aligned has the old key in their store and nothing
   * else. Without the carry-over their canvas silently reverts to Balanced on
   * upgrade — quiet, and indistinguishable from the setting having been
   * forgotten, which is the reason it is worth a test rather than a comment.
   */
  it('carries a stored alignedView over to the packing it named', () => {
    localStorage.setItem('storybook.prefs.v1', JSON.stringify({ alignedView: true }))
    reloadPrefs()
    expect(prefs.packing).toBe('aligned')

    // The author who never ticked it was on `balanced` already, so there is
    // nothing to carry and the default stands.
    localStorage.setItem('storybook.prefs.v1', JSON.stringify({ alignedView: false }))
    reloadPrefs()
    expect(prefs.packing).toBe('balanced')

    // A real `packing` wins over the old key, so a store written by this build
    // is never reinterpreted through the previous one.
    localStorage.setItem(
      'storybook.prefs.v1',
      JSON.stringify({ alignedView: true, packing: 'straight' }),
    )
    reloadPrefs()
    expect(prefs.packing).toBe('straight')

    // And a mode this build does not know is refused rather than cast. It
    // would reach `assignX`, where the exhaustive switch throws — so the
    // canvas would not render at all, on a value a hand-edited store or a
    // downgrade can produce.
    localStorage.setItem('storybook.prefs.v1', JSON.stringify({ packing: 'diagonal' }))
    reloadPrefs()
    expect(prefs.packing).toBe('balanced')
  })
})

describe('snippets', () => {
  async function withStory(): Promise<void> {
    mount()
    store.newStory('Snippet Check')
    // Replaced first: the starter text names `P2` in its example link, and the
    // first passage made below would capture it.
    store.editBody(store.state.doc.startNodeId!, 'Your story begins here.')
    await nextTick()
  }

  const toggle = () => host.querySelector<HTMLButtonElement>('.inspector [data-snippet-toggle]')!

  it('adds one from the Edit menu, drawn on level 0 with its badge', async () => {
    await withStory()
    await runCommand('New snippet')
    await nextTick()

    const snip = store.state.doc.nodes.find((n) => n.isSnippet)!
    expect(store.state.selectedId).toBe(snip.id)
    expect(host.querySelectorAll('.card.snippet')).toHaveLength(1)
    expect(host.querySelector('.card.snippet .flag-snippet')!.textContent).toBe('SNIPPET')
    const bands = [...host.querySelectorAll('.level-tag')].map((el) => el.textContent!.trim())
    // Just the number, like every other band: the gutter is a card's margin
    // wide, and the card's own SNIPPET flag says the rest.
    expect(bands[0]).toBe('Level 0')
    expect(bands[1]).toBe('Level 1')
    expect(problems).toEqual([])
  })

  it('gives a snippet its own inspector, and opens the passage that displays it', async () => {
    await withStory()
    const startId = store.state.doc.startNodeId!
    const snipId = store.addSnippet()
    const code = store.state.doc.nodes.find((n) => n.id === snipId)!.code
    store.editBody(startId, `Outside: (display: "${code}")`)
    store.select(snipId)
    await nextTick()

    const footer = [...host.querySelectorAll('.inspector footer .btn')].map((b) => b.textContent!.trim())
    expect(footer).toEqual(['Delete'])
    expect(host.querySelectorAll('.inspector .hosts .jump')).toHaveLength(1)

    openAdvanced()
    await nextTick()
    const text = host.querySelector('.inspector')!.textContent!
    expect(text).not.toContain('Play from here')
    expect(text).not.toContain('Mark as Ending')
    expect(text).toContain('Level 0')
    expect(toggle().textContent!.trim()).toBe('Make it a passage again')
    expect(host.querySelectorAll('.inspector input[type=checkbox]')).toHaveLength(0)

    host.querySelector<HTMLButtonElement>('.inspector [data-tab="write"]')!.click()
    await nextTick()
    host.querySelector<HTMLButtonElement>('.inspector .hosts .jump')!.click()
    await nextTick()
    expect(store.state.selectedId).toBe(startId)
    expect(problems).toEqual([])
  })

  it('makes an unlinked passage a snippet, and says why the start cannot be one', async () => {
    await withStory()
    openAdvanced()
    await nextTick()
    expect(toggle().disabled).toBe(true)
    expect(toggle().title).toMatch(/start/)
    // Still exactly the one box: the snippet control is a button.
    expect(host.querySelectorAll('.inspector input[type=checkbox]')).toHaveLength(1)

    const lone = store.addPassage()
    await nextTick()
    expect(toggle().disabled).toBe(false)
    toggle().click()
    await nextTick()
    expect(store.state.doc.nodes.find((n) => n.id === lone)!.isSnippet).toBe(true)
    expect(host.querySelectorAll('.card.snippet')).toHaveLength(1)
    expect(toggle().textContent!.trim()).toBe('Make it a passage again')

    toggle().click()
    await nextTick()
    expect(store.state.doc.nodes.find((n) => n.id === lone)!.isSnippet).toBe(false)
    expect(host.querySelectorAll('.card.snippet')).toHaveLength(0)
    expect(problems).toEqual([])
  })

  it('offers only snippets to the (display:) picker, and writes the macro', async () => {
    await withStory()
    const startId = store.state.doc.startNodeId!
    const snipId = store.addSnippet()
    store.addPassage()
    const code = store.state.doc.nodes.find((n) => n.id === snipId)!.code
    store.select(startId)
    await nextTick()

    host.querySelector<HTMLButtonElement>('.inspector .body-tools [data-display]')!.click()
    await nextTick()
    const picker = host.querySelector('[aria-label="Display a snippet"]')!
    const rows = [...picker.querySelectorAll('.row-code')].map((el) => el.textContent)
    expect(rows).toEqual([code])
    expect(picker.querySelector('.create')).toBeNull()

    picker.querySelector<HTMLButtonElement>('.item')!.dispatchEvent(new MouseEvent('mousedown'))
    await nextTick()
    expect(store.state.doc.nodes.find((n) => n.id === startId)!.body).toContain(
      `(display: "${code}")`,
    )
    expect(problems).toEqual([])
  })

  it('keeps focus in the editor when the (display:) button is pressed', async () => {
    await withStory()
    store.addSnippet()
    store.select(store.state.doc.startNodeId!)
    await nextTick()
    // Losing focus would settle the body first, and a settle that binds a link
    // moves the caret to the end — where the macro would then land.
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    host.querySelector<HTMLButtonElement>('.inspector .body-tools [data-display]')!.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    expect(problems).toEqual([])
  })

  it('leaves snippets out of a selection level range and ending count', async () => {
    await withStory()
    const start = store.state.doc.startNodeId!
    const snip = store.addSnippet()
    store.select(start)
    store.toggleSelected(snip)
    await nextTick()
    expect(host.querySelector('.inspector .batch .level-now strong')!.textContent!.trim()).toBe(
      'Level 1',
    )

    // A set of snippets alone has no level to nudge and nothing to mark.
    const other = store.addSnippet()
    store.select(snip)
    store.toggleSelected(other)
    await nextTick()
    expect(host.querySelector('.inspector .batch .level-now')).toBeNull()
    expect(host.querySelector('.inspector input[type=checkbox]')).toBeNull()
    expect(problems).toEqual([])
  })

  it('lists snippet problems in Story Stats, and no snippet as unreachable', async () => {
    await withStory()
    const startId = store.state.doc.startNodeId!
    store.addSnippet()
    store.editBody(startId, '(display: "Nope")')
    await nextTick()
    await runCommand('Stats')
    await nextTick()

    const sheet = host.querySelector('[aria-label="Story statistics"]')!
    const count = (label: string) =>
      [...sheet.querySelectorAll('.lint-head')]
        .find((b) => b.querySelector('.what')!.firstChild!.textContent!.trim() === label)!
        .querySelector('.count')!.textContent
    expect(count('Broken displays')).toBe('1')
    expect(count('Unreachable passages')).toBe('0')
    expect(count('Dead ends not marked as an Ending')).toBe('1')
    expect(problems).toEqual([])
  })
})
