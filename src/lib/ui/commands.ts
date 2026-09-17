import { IS_MAC, MOD_LABEL, SHIFT_LABEL } from './platform'

/**
 * Every command the app offers, described exactly once.
 *
 * The shortcut list used to live in four places — `useShortcuts` held the
 * behaviour with no labels, `HelpPanel` held a hard-coded table, each toolbar
 * button hard-coded a `title`, and `HarloweEditor` owned the editor keys — and
 * they had already drifted: the help table was missing ⌘G, ⌘Y, `?` and
 * Backspace, and every tooltip said "Cmd" to Windows. This is the one
 * vocabulary all of them now read, the same move `forwardTargets` makes for
 * route edges and `remapLinks` for retargeting.
 *
 * It is *description*, not dispatch. `useShortcuts` still owns which key does
 * what and under which guards, because those guards are per-command and
 * subtle — `nativeEditing`, and the self-exempt checks that let a sheet close
 * with the key that opened it. A table cannot state them without becoming a
 * second implementation of the thing it describes. What a test can assert, and
 * `commands.test.ts` does, is that every chord named here actually arrives
 * somewhere — which is the check whose absence let the drift happen.
 */

export type CommandGroup = 'file' | 'edit' | 'view' | 'story' | 'help'

/**
 * Where a command is listened for, which decides who may render it.
 *
 * `editor` and `pointer` commands have no menu home — the first are the
 * textarea's own (`HarloweEditor` stops their propagation before the window
 * hears them), the second are not keys at all. They are here so the help panel
 * can render from this table without losing the rows it used to list.
 */
export type CommandScope = 'global' | 'editor' | 'pointer'

export interface Chord {
  mod?: boolean
  shift?: boolean
  /** The literal `KeyboardEvent.key`, so a test can dispatch it. */
  key: string
}

export interface CommandSpec {
  id: string
  label: string
  /** Absent for a command no menu holds. */
  group?: CommandGroup
  /** Items sharing a section render together; a divider separates sections. */
  section?: number
  scope: CommandScope
  chord?: Chord
  /** The longer sentence, reused as the menu hint and the button tooltip. */
  hint?: string
  /** Renders with a checkmark; the binding supplies whether it is ticked. */
  toggle?: boolean
}

/** What a screen supplies for a command: how to run it, and its current state. */
export interface CommandBinding {
  run: () => void
  /** Absent means enabled. */
  enabled?: boolean
  /** Only read for a `toggle` command. */
  checked?: boolean
}

export const GROUPS: readonly CommandGroup[] = ['file', 'edit', 'view', 'story', 'help']

export const GROUP_LABELS: Record<CommandGroup, string> = {
  file: 'File',
  edit: 'Edit',
  view: 'View',
  story: 'Story',
  help: 'Help',
}

export const COMMANDS: readonly CommandSpec[] = [
  // File
  {
    id: 'file.import',
    label: 'Import…',
    group: 'file',
    section: 1,
    scope: 'global',
    hint: 'Open a story JSON file',
  },
  {
    id: 'file.export',
    label: 'Export',
    group: 'file',
    section: 1,
    scope: 'global',
    hint: 'Download the story as JSON',
  },

  // Edit
  {
    id: 'edit.undo',
    label: 'Undo',
    group: 'edit',
    section: 1,
    scope: 'global',
    chord: { mod: true, key: 'z' },
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    group: 'edit',
    section: 1,
    scope: 'global',
    chord: { mod: true, shift: true, key: 'z' },
  },
  // The alias, listed so the help panel stops hiding it. No menu home: one
  // command with two rows in the same menu reads as two commands.
  {
    id: 'edit.redoAlt',
    label: 'Redo',
    scope: 'global',
    chord: { mod: true, key: 'y' },
  },
  {
    id: 'edit.passageAdd',
    label: 'New passage',
    group: 'edit',
    section: 2,
    scope: 'global',
    chord: { key: 'n' },
    hint: 'New passage, linked from the selected one',
  },
  {
    id: 'edit.passageDelete',
    label: 'Delete passage',
    group: 'edit',
    section: 2,
    scope: 'global',
    chord: { key: 'Backspace' },
    hint: 'Delete every selected passage',
  },
  {
    id: 'edit.passageAddFree',
    label: 'New unlinked passage',
    group: 'edit',
    section: 2,
    scope: 'global',
    hint: 'Add a passage with no links to it yet',
  },
  {
    id: 'edit.recode',
    label: 'Recode…',
    group: 'edit',
    section: 3,
    scope: 'global',
    hint: "Renumber every passage's code from the tree",
  },

  // View
  {
    id: 'view.zoomIn',
    label: 'Zoom in',
    group: 'view',
    section: 1,
    scope: 'global',
    chord: { mod: true, key: '=' },
  },
  {
    id: 'view.zoomOut',
    label: 'Zoom out',
    group: 'view',
    section: 1,
    scope: 'global',
    chord: { mod: true, key: '-' },
  },
  {
    id: 'view.zoomReset',
    label: 'Reset to 100%',
    group: 'view',
    section: 1,
    scope: 'global',
    chord: { mod: true, key: '1' },
  },
  {
    id: 'view.zoomFit',
    label: 'Zoom to fit',
    group: 'view',
    section: 1,
    scope: 'global',
    chord: { mod: true, key: '0' },
    hint: 'Fit the whole story on screen',
  },
  {
    id: 'view.levels',
    label: 'Level guides',
    group: 'view',
    section: 2,
    scope: 'global',
    toggle: true,
    hint: 'Show or hide the level guide lines',
  },
  {
    id: 'view.minimap',
    label: 'Minimap',
    group: 'view',
    section: 2,
    scope: 'global',
    toggle: true,
    hint: 'Show or hide the minimap',
  },

  // Story
  {
    id: 'story.play',
    label: 'Play',
    group: 'story',
    section: 1,
    scope: 'global',
    chord: { mod: true, key: 'p' },
    hint: 'Read the story back, a choice at a time',
  },
  {
    id: 'story.stats',
    label: 'Stats',
    group: 'story',
    section: 1,
    scope: 'global',
    chord: { mod: true, key: '/' },
    hint: 'Routes, endings, word count, draft health',
  },
  {
    id: 'story.tags',
    label: 'Tags',
    group: 'story',
    section: 1,
    scope: 'global',
    chord: { mod: true, key: 'g' },
    hint: 'How many routes run through each tag, and which routes collect several',
  },
  {
    id: 'story.index',
    label: 'Cast & Settings',
    group: 'story',
    section: 2,
    scope: 'global',
    toggle: true,
    chord: { mod: true, key: ';' },
    hint: 'Every character and setting, with passage counts',
  },
  {
    id: 'story.notes',
    label: 'Story notes',
    group: 'story',
    section: 2,
    scope: 'global',
    toggle: true,
    chord: { mod: true, key: 'j' },
    hint: 'A scratchpad for the story as a whole',
  },

  // Help
  {
    id: 'help.about',
    label: 'How Storybook works',
    group: 'help',
    section: 1,
    scope: 'global',
    chord: { key: '?' },
  },
  {
    id: 'help.settings',
    label: 'Editor settings…',
    group: 'help',
    section: 1,
    scope: 'global',
  },

  // Global, but no menu home: each needs a selection or a field to act on, so a
  // menu item would be dimmed more often than not.
  {
    id: 'search.focus',
    label: 'Jump to search',
    scope: 'global',
    chord: { mod: true, key: 'f' },
  },
  {
    id: 'passage.expand',
    label: 'Expand the selected passage’s body editor',
    scope: 'global',
    chord: { mod: true, key: 'e' },
  },
  {
    id: 'passage.cheatSheet',
    label: 'Character cheat sheet for the selected passage',
    scope: 'global',
    chord: { mod: true, key: 'k' },
  },

  // The editor's own, handled in `HarloweEditor` and never seen by the window.
  {
    id: 'editor.bold',
    label: 'Bold the selected prose',
    scope: 'editor',
    chord: { mod: true, key: 'b' },
  },
  {
    id: 'editor.italic',
    label: 'Italicise the selected prose',
    scope: 'editor',
    chord: { mod: true, key: 'i' },
  },
  {
    id: 'editor.quote',
    label: 'Quote the selected lines',
    scope: 'editor',
    chord: { mod: true, shift: true, key: '.' },
  },
  {
    id: 'editor.link',
    label: 'Link the selected prose to a passage',
    scope: 'editor',
    chord: { mod: true, shift: true, key: 'k' },
  },

  // Not keys at all.
  {
    id: 'select.subtree',
    label: 'Select a passage and everything it leads to',
    scope: 'pointer',
    chord: { mod: true, key: 'click' },
  },
  {
    id: 'select.toggle',
    label: 'Add or remove one passage from the selection',
    scope: 'pointer',
    chord: { shift: true, key: 'click' },
  },
]

/**
 * How a key reads to a person, where that differs from what the browser calls
 * it. `=` is the unshifted key that zooms in, but nobody thinks of it as `=`.
 */
const KEY_LABELS: Record<string, string> = {
  '=': '+',
  '-': '−',
  Backspace: 'Delete',
  click: 'click',
}

export function chordLabel(c: Chord, isMac: boolean = IS_MAC): string {
  const parts: string[] = []
  if (c.mod) parts.push(isMac ? '⌘' : 'Ctrl')
  if (c.shift) parts.push(SHIFT_LABEL)
  const named = KEY_LABELS[c.key]
  parts.push(named ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key))
  return parts.join(' ')
}

/**
 * One command by id, or `undefined`.
 *
 * Callers used to reach for `COMMANDS.find(...)!` and then `c.chord!`, which
 * `vue-tsc` is happy with and which throws during render if an id is ever
 * renamed — taking the whole panel down rather than dropping a tooltip.
 */
export function commandById(id: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.id === id)
}

/** A command's label with its chord appended, for a tooltip. Empty if unknown. */
export function commandTip(id: string): string {
  const c = commandById(id)
  if (!c) return ''
  const text = c.hint ?? c.label
  return c.chord ? `${text} (${chordLabel(c.chord)})` : text
}

/** The commands one menu holds, in section order, ready to render. */
export function commandsIn(group: CommandGroup): readonly CommandSpec[] {
  return COMMANDS.filter((c) => c.group === group)
}

export { MOD_LABEL }
