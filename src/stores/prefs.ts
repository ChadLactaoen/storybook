import { reactive } from 'vue'

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
}

/**
 * Both off. Inheritance rewrites a passage the author has not looked at yet, so
 * it is something they opt into rather than something they discover.
 */
const DEFAULTS: Prefs = { inheritSetting: false, inheritCharacters: false }

/**
 * Anything but a boolean is ignored rather than rejected, and a missing or
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
    const parsed = JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>
    for (const key of Object.keys(out) as (keyof Prefs)[]) {
      if (typeof parsed?.[key] === 'boolean') out[key] = parsed[key] as boolean
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
  persist()
}

/** Back to defaults. Exists because the store is a singleton across a test file. */
export function resetPrefs(): void {
  Object.assign(prefs, DEFAULTS)
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}
