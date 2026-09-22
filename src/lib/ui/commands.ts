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
    id: 'edit.passageEnding',
    label: 'Mark as Ending',
    group: 'edit',
    section: 2,
    scope: 'global',
    chord: { key: 'e' },
    // Ticked only when the whole selection is already marked, so a mixed set
    // reads as "not yet", which is also the direction the key will take it.
    toggle: true,
    hint: 'Mark every selected passage as an ending, or clear it',
  },
  // One per state, in the order `NODE_STATES` gives them, keyed by the digit at
  // that position — so the keys run left to right across the sidebar's segmented
  // control. `commands.test.ts` pins that pairing, because `useShortcuts` reads
  // the digit as an index into `NODE_STATES` rather than naming the states again.
  {
    id: 'edit.stateTODO',
    label: 'TODO',
    group: 'edit',
    section: 3,
    scope: 'global',
    chord: { key: '1' },
    toggle: true,
    hint: 'Set every selected passage to TODO',
  },
  {
    id: 'edit.stateDraft',
    label: 'Draft',
    group: 'edit',
    section: 3,
    scope: 'global',
    chord: { key: '2' },
    toggle: true,
    hint: 'Set every selected passage to Draft',
  },
  {
    id: 'edit.stateDone',
    label: 'Done',
    group: 'edit',
    section: 3,
    scope: 'global',
    chord: { key: '3' },
    toggle: true,
    hint: 'Set every selected passage to Done',
  },
  // A pair, not a toggle: the direction *is* the command, and `enabled` is what
  // a mixed selection dims. After the states rather than beside Ending because
  // a level is positional and a state is not. No chord — `[`, `]` and the
  // arrows stay free, and a chordless row enrols nothing in `commands.test.ts`.
  {
    id: 'edit.levelDown',
    label: 'Nudge down a level',
    group: 'edit',
    section: 4,
    scope: 'global',
    hint: 'Nudge every selected passage one level below its floor',
  },
  {
    id: 'edit.levelUp',
    label: 'Move up a level',
    group: 'edit',
    section: 4,
    scope: 'global',
    hint: 'Return every selected passage to the earliest level its links allow',
  },
  {
    id: 'edit.recode',
    label: 'Recode…',
    group: 'edit',
    section: 5,
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

  /*
   * Two ticked rows over one boolean, the way `edit.state*` spells one-of-N.
   * A menu here has dividers and no headings, so the labels carry the whole
   * meaning and both say "view" — a bare "Balanced" in a View menu could be
   * about anything.
   *
   * Chordless on purpose. These are settings, reached once and left alone, and
   * a chordless row enrols nothing in `commands.test.ts` and adds no row to the
   * help sheet — which is right, since there is no key to press.
   */
  {
    id: 'view.packBalanced',
    label: 'Balanced view',
    group: 'view',
    section: 3,
    scope: 'global',
    toggle: true,
    hint: 'Draw as narrowly as the story allows',
  },
  {
    id: 'view.packAligned',
    label: 'Aligned view',
    group: 'view',
    section: 3,
    scope: 'global',
    toggle: true,
    hint: 'Free up room for parents crowded by a merge, by shifting the cards beside them. Draws wider',
  },
  {
    id: 'view.compact',
    label: 'Compact spacing',
    group: 'view',
    section: 4,
    scope: 'global',
    toggle: true,
    hint: 'Smaller cards and tighter gaps, to fit more on screen',
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
  // No chord. Every mnemonic worth having is spoken for — Chrome keeps Cmd T
  // and Cmd W, Cmd K is the per-passage cheat sheet, Cmd ; is Cast & Settings —
  // and a binding nobody can guess is worth less than the menu row that is
  // already there. A chordless row enrols nothing in `commands.test.ts`, which
  // is exactly right: there is no key to assert arrives.
  {
    id: 'story.characters',
    label: 'Characters',
    group: 'story',
    section: 1,
    scope: 'global',
    hint: 'How many routes meet each character, and which routes bring several together',
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
  /*
   * The one per-passage command with a menu home, where `passage.expand` beside
   * it has none. The reason is the pointer: the cheat sheet's only other way in
   * is the link under the inspector's cast list, which is itself behind a cast
   * — so on a passage nobody is cast in yet there was no visible way to reach
   * it at all, and nothing anywhere saying ⌘K existed. Dimmed without a
   * selection, like Delete and Mark as Ending, rather than absent.
   *
   * Section 2 because it is a left-gutter panel: `leftPanel` makes it and Cast &
   * Settings structurally exclusive, and Story notes shares the column.
   */
  {
    id: 'passage.cheatSheet',
    label: 'Character cheat sheet',
    group: 'story',
    section: 2,
    scope: 'global',
    toggle: true,
    chord: { mod: true, key: 'k' },
    hint: "Every cast member's traits and relations for the selected passage, side by side",
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
