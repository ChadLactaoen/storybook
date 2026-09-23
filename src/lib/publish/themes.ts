/**
 * The player's themes, as a vocabulary: ids, names and the fonts they load.
 *
 * Pure data, with no DOM and no Vue, because two very different programs read
 * it. The editor's preferences validate a stored choice against it, and the
 * player bundle offers the same four in its `Aa` popover. One list means a theme
 * the editor can pick is always one the player can draw.
 *
 * A theme changes CSS only, never markup. Every theme styles the same elements,
 * so the player sets `data-theme` and builds the same DOM for all four. The
 * stylesheet itself is in `styles.ts`.
 */

export const THEMES = [
  { id: 'marquee', label: 'Marquee', blurb: 'Poster type on a dark ground, like a cinema marquee.' },
  { id: 'folio', label: 'Folio', blurb: 'A printed book: serif, justified, a drop cap.' },
  { id: 'phosphor', label: 'Phosphor', blurb: 'A retro terminal text adventure, green on black.' },
  { id: 'daylight', label: 'Daylight', blurb: 'High legibility on a light ground, with large targets.' },
] as const

export type PlayerTheme = (typeof THEMES)[number]['id']

/**
 * What the editor uses until an author picks something else.
 *
 * The reader spec names Marquee as the default. Folio is the house choice
 * instead: it is the closest to the fixed stylesheet the player shipped with
 * before themes existed, so an author who never opens settings still gets a
 * page that reads like a book.
 */
export const DEFAULT_THEME: PlayerTheme = 'folio'

export function isPlayerTheme(value: unknown): value is PlayerTheme {
  return typeof value === 'string' && THEMES.some((theme) => theme.id === value)
}

/**
 * Every theme's fonts, in one Google Fonts request.
 *
 * All four load, not only the active one, because a reader can switch theme from
 * the `Aa` popover. Loading on demand would flash fallback type at exactly the
 * moment someone is judging how a theme looks. A published file opened offline
 * cannot fetch this, and each theme's font stack names a fallback for that case.
 */
export const FONTS_URL =
  'https://fonts.googleapis.com/css2' +
  '?family=Bebas+Neue' +
  '&family=Gothic+A1:wght@400;500;700' +
  '&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500' +
  '&family=VT323' +
  '&family=IBM+Plex+Mono:wght@400;500;600' +
  '&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400' +
  '&display=swap'
