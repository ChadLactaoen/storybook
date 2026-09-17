// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import type { App as VueApp } from 'vue'
import { chordLabel, COMMANDS, commandsIn, GROUPS, type Chord } from '../lib/ui/commands'
import { useShortcuts, type ShortcutHandlers } from '../composables/useShortcuts'

/**
 * The command table describes; `useShortcuts` dispatches. This is what holds
 * the two together.
 *
 * The shortcut list used to live in four places and had already drifted — the
 * help panel was missing Cmd G, Cmd Y, `?` and Backspace — because nothing
 * asserted that a documented chord was a chord anybody listened for. That is
 * the check below: not *which* handler runs, which would make this a second
 * copy of the dispatch chain, but that the key arrives at all.
 */

let app: VueApp | null = null

afterEach(() => {
  app?.unmount()
  app = null
})

/** Every handler a spy, every predicate false — nothing is open. */
function spyHandlers() {
  const calls: string[] = []
  const act = (name: string) => vi.fn(() => void calls.push(name))
  const handlers: ShortcutHandlers = {
    zoomIn: act('zoomIn'),
    zoomOut: act('zoomOut'),
    zoomToFit: act('zoomToFit'),
    resetZoom: act('resetZoom'),
    undo: act('undo'),
    redo: act('redo'),
    addPassage: act('addPassage'),
    deletePassage: act('deletePassage'),
    focusSearch: act('focusSearch'),
    toggleBodyEditor: act('toggleBodyEditor'),
    toggleCheatSheet: act('toggleCheatSheet'),
    toggleNotes: act('toggleNotes'),
    toggleIndex: act('toggleIndex'),
    openHelp: act('openHelp'),
    openStats: act('openStats'),
    openTags: act('openTags'),
    togglePlay: act('togglePlay'),
    statsOpen: () => false,
    tagsOpen: () => false,
    playOpen: () => false,
    dialogOpen: () => false,
    modalOpen: () => false,
    menuOpen: () => false,
  }
  return { handlers, calls }
}

function listen(handlers: ShortcutHandlers) {
  app = createApp({
    setup() {
      useShortcuts(handlers)
      return () => null
    },
  })
  app.mount(document.createElement('div'))
}

function press(c: Chord) {
  const e = new KeyboardEvent('keydown', {
    // A shifted letter reaches the page upper-cased on Windows and Linux, so
    // the chords are pressed the strict way here: a handler that only matches
    // the macOS spelling fails this, which is the whole point of the check.
    key: c.shift === true && c.key.length === 1 ? c.key.toUpperCase() : c.key,
    metaKey: c.mod === true,
    shiftKey: c.shift === true,
    cancelable: true,
  })
  window.dispatchEvent(e)
  return e
}

describe('the command table', () => {
  it('names every command exactly once', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives no two commands the same chord', () => {
    const seen = COMMANDS.filter((c) => c.chord).map(
      (c) => `${c.chord!.mod ? 'M' : ''}${c.chord!.shift ? 'S' : ''}-${c.chord!.key}`,
    )
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('puts every grouped command in a real group, and every group in the bar', () => {
    for (const c of COMMANDS) {
      if (c.group) expect(GROUPS).toContain(c.group)
      // A grouped command needs a section, or the divider logic has nothing to
      // read and the whole menu collapses into one run.
      if (c.group) expect(typeof c.section).toBe('number')
    }
    for (const g of GROUPS) expect(commandsIn(g).length).toBeGreaterThan(0)
  })

  it('asks the platform what the modifier is called', () => {
    expect(chordLabel({ mod: true, key: 'z' }, true)).toBe('⌘ Z')
    expect(chordLabel({ mod: true, key: 'z' }, false)).toBe('Ctrl Z')
    expect(chordLabel({ mod: true, shift: true, key: 'z' }, true)).toBe('⌘ ⇧ Z')
    // The keys nobody thinks of by their browser name.
    expect(chordLabel({ mod: true, key: '=' }, true)).toBe('⌘ +')
    expect(chordLabel({ mod: true, key: '-' }, true)).toBe('⌘ −')
    expect(chordLabel({ key: 'Backspace' }, true)).toBe('Delete')
    expect(chordLabel({ mod: true, key: 'click' }, true)).toBe('⌘ click')
  })
})

describe('every chord the table documents', () => {
  const documented = COMMANDS.filter((c) => c.scope === 'global' && c.chord)

  it.each(documented.map((c) => [c.id, c.chord!] as const))(
    'arrives somewhere: %s',
    (_id, chord) => {
      const { handlers, calls } = spyHandlers()
      listen(handlers)
      const e = press(chord)
      // Exactly one, not merely one-or-more: a chord that fired two handlers
      // would be a collision the table could not show.
      expect(calls).toHaveLength(1)
      expect(e.defaultPrevented).toBe(true)
    },
  )

  it('leaves a chord the table does not claim alone', () => {
    const { handlers, calls } = spyHandlers()
    listen(handlers)
    press({ mod: true, key: 'q' })
    press({ key: 'x' })
    expect(calls).toEqual([])
  })
})

describe('an open menu', () => {
  it('stands the unmodified keys down, and leaves the canvas keys alone', () => {
    const { handlers, calls } = spyHandlers()
    const open: ShortcutHandlers = { ...handlers, menuOpen: () => true }
    listen(open)

    // Focus is on a menu button, so `isTyping` is false and `modalOpen` is
    // false. Without the guard these would act behind the open panel.
    press({ key: 'n' })
    press({ key: 'Backspace' })
    press({ key: '?' })
    expect(calls).toEqual([])

    // A menu is not a veil: undo and zoom still belong to the canvas.
    press({ mod: true, key: 'z' })
    press({ mod: true, key: '=' })
    expect(calls).toEqual(['undo', 'zoomIn'])
  })
})
