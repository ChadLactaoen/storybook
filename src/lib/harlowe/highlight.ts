/**
 * A small Harlowe tokenizer, used to paint a highlight layer underneath the
 * body textarea. It recognises structure only — nothing here evaluates macros.
 */

export type TokenType =
  | 'text'
  | 'comment'
  | 'link'
  | 'macro'
  | 'variable'
  | 'string'
  | 'number'
  | 'keyword'
  | 'hook'

export interface Token {
  type: TokenType
  start: number
  end: number
}

const KEYWORDS = new Set([
  'it', 'its', 'is', 'not', 'and', 'or', 'to', 'into', 'of', 'in',
  'true', 'false', 'contains', 'matches', 'where', 'via', 'making', 'each',
])

const IDENT = /[A-Za-z_][A-Za-z0-9_-]*/y
const NUMBER = /\d+(?:\.\d+)?(?:s|ms)?/y

export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let textStart = 0

  const flushText = (upTo: number) => {
    if (upTo > textStart) tokens.push({ type: 'text', start: textStart, end: upTo })
  }
  const emit = (type: TokenType, start: number, end: number) => {
    flushText(start)
    tokens.push({ type, start, end })
    textStart = end
    i = end
  }

  while (i < src.length) {
    const c = src[i]!

    if (c === '<' && src.startsWith('<!--', i)) {
      const close = src.indexOf('-->', i + 4)
      emit('comment', i, close === -1 ? src.length : close + 3)
      continue
    }

    if (c === '[' && src[i + 1] === '[') {
      const close = src.indexOf(']]', i + 2)
      emit('link', i, close === -1 ? src.length : close + 2)
      continue
    }

    // A macro call opens with `(name:`; only the opener is coloured, so the
    // arguments inside keep their own highlighting.
    if (c === '(') {
      IDENT.lastIndex = i + 1
      const m = IDENT.exec(src)
      if (m && src[IDENT.lastIndex] === ':') {
        emit('macro', i, IDENT.lastIndex + 1)
        continue
      }
    }

    if (c === '$' || c === '_') {
      IDENT.lastIndex = i + 1
      const m = IDENT.exec(src)
      if (m && m[0].length > 0) {
        emit('variable', i, IDENT.lastIndex)
        continue
      }
    }

    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++
        j++
      }
      emit('string', i, Math.min(j + 1, src.length))
      continue
    }

    if (c >= '0' && c <= '9') {
      NUMBER.lastIndex = i
      const m = NUMBER.exec(src)
      if (m) {
        emit('number', i, i + m[0].length)
        continue
      }
    }

    if (/[A-Za-z]/.test(c)) {
      IDENT.lastIndex = i
      const m = IDENT.exec(src)
      if (m) {
        const word = m[0]
        const end = i + word.length
        // Only treat a bare word as a keyword inside a macro's arguments.
        if (KEYWORDS.has(word.toLowerCase()) && insideMacro(src, i)) {
          emit('keyword', i, end)
        } else {
          i = end
        }
        continue
      }
    }

    if (c === '|' || c === '>' || c === '<') {
      // Named hook markers: |name>[ ... ] and [ ... ]<name|
      const named = /\|[A-Za-z_][A-Za-z0-9_-]*>|<[A-Za-z_][A-Za-z0-9_-]*\|/y
      named.lastIndex = i
      const m = named.exec(src)
      if (m) {
        emit('hook', i, i + m[0].length)
        continue
      }
    }

    i++
  }

  flushText(src.length)
  return tokens
}

/** Cheap unbalanced-paren scan backwards; good enough to gate keyword colouring. */
function insideMacro(src: string, at: number): boolean {
  let depth = 0
  for (let j = at - 1; j >= 0 && at - j < 400; j--) {
    const c = src[j]
    if (c === ')') depth++
    else if (c === '(') {
      if (depth === 0) return true
      depth--
    }
  }
  return false
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (ch) => ESCAPES[ch]!)
}

/** Render `src` as HTML spans for the editor's highlight layer. */
export function highlightHtml(src: string): string {
  let out = ''
  for (const t of tokenize(src)) {
    const text = escapeHtml(src.slice(t.start, t.end))
    out += t.type === 'text' ? text : `<span class="hl-${t.type}">${text}</span>`
  }
  // A trailing newline would otherwise not produce a line box, so the overlay
  // would come up one line short of the textarea while scrolling.
  return out + '\n'
}
