/**
 * Which modifier this keyboard calls its own.
 *
 * One home for a test that used to be copy-pasted three times — in
 * `useShortcuts`, where it decides behaviour, and in `HelpPanel` and
 * `HarloweEditor`, where it only picks a glyph. The two display copies had
 * drifted to different conventions ("Cmd" against "⌘"), and the toolbar's
 * tooltips skipped the test altogether and said "Cmd" to everyone.
 *
 * `navigator.platform` is deprecated, and the replacement — `userAgentData` —
 * is not on Safari, which is exactly the browser this has to be right about.
 * The expression is left as it was found: `nativeEditing` depends on it, and a
 * wrong answer there hands macOS text fields' Ctrl-E and Ctrl-K to the canvas.
 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl'
export const SHIFT_LABEL = '⇧'
