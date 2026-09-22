import { reactive } from 'vue'
import { isPackingMode } from '../lib/graph/types'
import type { PackingMode } from '../lib/graph/types'

/**
 * Editor preferences: how the app behaves, not what the story says.
 *
 * Deliberately kept out of `StoryDoc` and out of `lib/doc/storage.ts`. The
 * document is the only persisted state, and a save file carried to another
 * machine must not carry the author's UI habits with it — so these live under
 * their own key, and `serializeDoc` never sees them.
 */

const KEY = 'storybook.prefs.v1'

export interface Prefs {
  /** Copy the parent passage's setting onto a passage created from it. */
  inheritSetting: boolean
  /**
   * Copy the parent passage's cast onto a passage created from it.
   *
   * Names only: a scene note is direction for that one scene, so carrying one
   * forward would put words in the author's mouth.
   */
  inheritCharacters: boolean
  /** Draw each passage's code in the gap above its card. */
  showCodes: boolean
  /**
   * Which x-coordinate assignment draws the canvas — `LayoutConfig.packing`,
   * which explains what each one is.
   *
   * A preference rather than a fix because none of the three is one. The first
   * two trade width for how near a merged passage sits to its parents, and draw
   * a story with no merges identically. The third answers a different question
   * altogether — a card under one parent rather than between several — which
   * moves a plain fan too. Which trade suits depends on the story, so the
   * author picks.
   */
  packing: PackingMode
  /** Tighter cards and gaps, to fit more of the story on screen. */
  compactSpacing: boolean
  /**
   * Reveal the Developer menu, which holds the tools for reporting a drawing
   * rather than writing a story.
   *
   * A settings checkbox rather than a menu row of its own, because the thing it
   * governs *is* a menu: a row that revealed its own menu would have to live
   * somewhere else in the bar, and then the bar has a developer tool in it
   * whether or not anyone asked for one.
   */
  devMode: boolean
  /**
   * Draw the cards as shape and colour with no glyph on them, for a screenshot
   * that shows the structure rather than a wall of titles.
   *
   * Only reachable while `devMode` is on, and cleared when it goes off — the
   * row that puts the text back would vanish with the menu, leaving an author
   * looking at blank cards with no way to fix them.
   */
  hideCardText: boolean
}

/**
 * Both off. Inheritance rewrites a passage the author has not looked at yet, so
 * it is something they opt into rather than something they discover.
 */
const DEFAULTS: Prefs = {
  inheritSetting: false,
  inheritCharacters: false,
  showCodes: false,
  // Both layout settings ship at their old values, so that upgrading redraws
  // nobody's story. Nothing enforces that: `compat.test.ts` pins a recorded
  // drawing but calls `layoutStory(doc)` with no config, so it reads
  // `DEFAULT_CONFIG` and cannot see this file. Changing either default would
  // leave it green while moving every existing author's canvas — so the check
  // is here, in the reading.
  packing: 'balanced',
  compactSpacing: false,
  // And the developer tools, for the plainer reason that an author did not ask
  // for them.
  devMode: false,
  hideCardText: false,
}

/**
 * Every preference that is a plain switch — which is all of them but `packing`.
 *
 * Exported because a checkbox is only valid over one of these: `EditorSettings`
 * builds its rows from a list of keys, and a list typed `keyof Prefs` would let
 * a three-way setting into a two-state control, where it would read as ticked
 * for any mode at all.
 */
export type SwitchPref = { [K in keyof Prefs]: Prefs[K] extends boolean ? K : never }[keyof Prefs]

/**
 * Read off `DEFAULTS` rather than written out, so a new switch is picked up
 * with no edit here and a new field of some other type cannot be read as one by
 * accident. The predicate and the filter are the same test, so the list and its
 * type cannot drift apart.
 */
const SWITCHES = (Object.keys(DEFAULTS) as (keyof Prefs)[]).filter(
  (k): k is SwitchPref => typeof DEFAULTS[k] === 'boolean',
)

/**
 * A value of the wrong type is ignored rather than rejected, and a missing or
 * unreadable store simply yields the defaults.
 *
 * The try/catch is not only about private browsing: every test file except
 * `render.test.ts` runs in vitest's `node` environment, where `localStorage`
 * does not exist at all and this module is imported through the store.
 */
function load(): Prefs {
  const out = { ...DEFAULTS }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw) as Partial<Record<keyof Prefs | 'alignedView', unknown>>
    for (const key of SWITCHES) {
      const value = parsed?.[key]
      if (typeof value === 'boolean') out[key] = value
    }
    // The same cascade `setPref` applies, because a stored pair can disagree —
    // a hand-edited store, or a build where this rule did not exist yet. Left
    // alone, `{ devMode: false, hideCardText: true }` comes back as blank cards
    // with no Developer menu to fix them, and `setPref('devMode', false)` could
    // not rescue it either: its no-op guard fires first.
    if (!out.devMode) out.hideCardText = false

    // The one field that is not a switch, so the loop above does not cover it.
    // Checked against `PACKING_MODES` rather than cast, because this store is
    // hand-editable and survives a downgrade: an unrecognised mode would reach
    // `assignX`, hit its default and draw as `tidy.ts` while the menu ticked a
    // row that was doing nothing.
    if (isPackingMode(parsed?.packing)) {
      out.packing = parsed.packing
    } else if (parsed?.alignedView === true) {
      // It was a boolean until a third mode existed. An author who had ticked
      // Aligned keeps it; one who had not was on `balanced`, which is the
      // default, so there is nothing to carry.
      //
      // Idempotent rather than once-and-done: `load` deliberately does not
      // write, so a store holding only the old key keeps holding it and this
      // branch runs again on every launch until some other preference is set
      // and `persist` rewrites the whole object in the new shape. That is fine
      // — it lands on the same answer every time — but it is not the "migrated
      // once" it looks like.
      out.packing = 'aligned'
    }
  } catch {
    // Unreadable or hand-edited: the defaults are a fine answer.
  }
  return out
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...prefs }))
  } catch {
    // Private browsing, or a full quota. A preference is not worth a notice.
  }
}

export const prefs = reactive<Prefs>(load())

/**
 * The one place a preference is written, so persistence cannot be forgotten.
 *
 * Deliberately not a module-level `watch`: created outside a component scope it
 * would never be stopped, and nothing would own it during tests.
 */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  if (prefs[key] === value) return
  prefs[key] = value
  // Leaving developer mode takes its tools with it, so anything one of them
  // turned on has to come off here. `hideCardText` is the case that matters:
  // the row that would put the text back is in the menu that just disappeared.
  if (key === 'devMode' && value === false) prefs.hideCardText = false
  persist()
}

/** Back to defaults. Exists because the store is a singleton across a test file. */
/**
 * Re-read the store into the live object.
 *
 * Its reason for existing is `load`'s repair pass: `prefs` is built once at
 * module load, so without this nothing can assert that a stored pair which
 * disagrees comes back repaired rather than as written. Sits beside
 * `resetPrefs`, which is here for the same kind of reason.
 */
export function reloadPrefs(): void {
  Object.assign(prefs, load())
}

export function resetPrefs(): void {
  Object.assign(prefs, DEFAULTS)
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}
