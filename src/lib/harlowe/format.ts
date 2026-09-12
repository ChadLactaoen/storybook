/**
 * Selection transforms for the body editor's formatting controls.
 *
 * Everything here is a pure function of `{ text, start, end }` returning the
 * same shape, so the editor component is left holding nothing but a textarea
 * ref: it reads the selection off the DOM, hands it here, emits the new string
 * and restores the caret. No DOM, no Vue, no store — which is also what makes
 * these testable in the default node environment.
 *
 * The markup written is Harlowe's own, not Markdown: `''bold''` and
 * `//italic//`, with `> ` opening a quoted line.
 */

import { buildLink } from './links'

export interface Selection {
  /** The whole body, not just the selected part. */
  text: string
  start: number
  end: number
}

export const BOLD = "''"
export const ITALIC = '//'

/** A line already quoted, however the author spaced it. */
const QUOTED = /^>\s?/

/**
 * Wrap the selection in `marker`, or unwrap it if it is already wrapped.
 *
 * Both spellings of "already wrapped" count: markers sitting just outside the
 * selection (what you get when the author re-selects the words they emboldened)
 * and markers inside it (what you get when they drag across the whole
 * construct). Unwrapping the right one is the difference between a toggle and a
 * key that only ever adds quotes.
 *
 * An empty selection inserts the pair and parks the caret between them, so the
 * shortcut works before typing as well as after.
 */
export function toggleWrap(sel: Selection, marker: string): Selection {
  const { text, start, end } = sel
  const width = marker.length

  if (text.slice(start - width, start) === marker && text.slice(end, end + width) === marker) {
    return {
      text: text.slice(0, start - width) + text.slice(start, end) + text.slice(end + width),
      start: start - width,
      end: end - width,
    }
  }

  if (
    end - start >= width * 2 &&
    text.slice(start, start + width) === marker &&
    text.slice(end - width, end) === marker
  ) {
    return {
      text: text.slice(0, start) + text.slice(start + width, end - width) + text.slice(end),
      start,
      end: end - width * 2,
    }
  }

  return {
    text: text.slice(0, start) + marker + text.slice(start, end) + marker + text.slice(end),
    start: start + width,
    end: end + width,
  }
}

/**
 * Prefix every line the selection touches with `> `, or strip the prefix if all
 * of them already carry it.
 *
 * Quoting is a property of whole lines, so the selection is widened to line
 * boundaries first and the result is returned selecting the whole block — the
 * author sees exactly what they changed, and pressing the shortcut again undoes
 * it. Blank lines inside the block are quoted too, with a bare `>` rather than
 * a line ending in a space: leaving them alone would split one quote into two.
 */
export function toggleBlockquote(sel: Selection): Selection {
  const { text, start, end } = sel

  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  // A selection ending just past a newline stops at the line it looks like it
  // stops at, rather than swallowing the line below.
  const from = end > start && text[end - 1] === '\n' ? end - 1 : end
  const nextBreak = text.indexOf('\n', from)
  const lineEnd = nextBreak === -1 ? text.length : nextBreak

  const lines = text.slice(lineStart, lineEnd).split('\n')
  const written = lines.filter((l) => l.trim().length > 0)
  const quoted = written.length > 0 && written.every((l) => QUOTED.test(l))

  const next = quoted
    ? lines.map((l) => l.replace(QUOTED, ''))
    : lines.map((l) => (l.length === 0 ? '>' : `> ${l}`))

  const block = next.join('\n')
  return {
    text: text.slice(0, lineStart) + block + text.slice(lineEnd),
    start: lineStart,
    end: lineStart + block.length,
  }
}

/**
 * Replace the selection with a link to `target`, using the selected prose as
 * the link's display text.
 *
 * The caret lands after the link rather than inside it. Editing a target in
 * place would have the document re-derived on every keystroke, creating a
 * passage per prefix — which is the whole reason the target is chosen before
 * anything is written.
 */
export function insertLink(sel: Selection, target: string): Selection {
  const { text, start, end } = sel
  const link = buildLink(target, text.slice(start, end))
  if (link.length === 0) return sel

  const at = start + link.length
  return { text: text.slice(0, start) + link + text.slice(end), start: at, end: at }
}
