/**
 * Harlowe / Twine link extraction.
 *
 * Supported forms (all four are what Twine itself accepts):
 *   [[Target]]
 *   [[Display|Target]]
 *   [[Display->Target]]
 *   [[Target<-Display]]
 *
 * Splitting follows Twine's precedence: `->` wins over `<-`, which wins over
 * `|`. Arrow forms split at the *outermost* arrow (last `->`, first `<-`) so
 * that display text containing an arrow still works.
 *
 * The target is a passage *code*, never a title — titles are cosmetic and may
 * repeat, so nothing structural could resolve against one.
 *
 * Each link records the absolute span of the whole `[[...]]` and, separately,
 * the span of just the target substring. The code cascade and the bare-link
 * rewrite both splice using the latter, so display text is never touched.
 */

/** Sequences that change how a `[[...]]` link is parsed. */
export const LINK_SYNTAX = ['->', '<-', '|', '[[', ']]'] as const

/**
 * The first link-syntax sequence in `text`, or null.
 *
 * Lives here rather than beside its callers because two layers need it and they
 * may not import each other: `setCode` refuses a code containing link syntax,
 * and the recode preview refuses a prefix or separator for the same reason.
 */
export function linkSyntaxIn(text: string): string | null {
  return LINK_SYNTAX.find((token) => text.includes(token)) ?? null
}

export interface Span {
  start: number
  end: number
}

export interface ParsedLink {
  /** Index of this link within its body, in source order. */
  ordinal: number
  /** Trimmed passage code this link points at. */
  target: string
  /** Display text, or null when the link is the bare `[[Target]]` form. */
  label: string | null
  /** Span of the entire `[[...]]` construct. */
  span: Span
  /** Span of just the target text, already trimmed. */
  targetSpan: Span
}

/** Narrow [start,end) inwards past surrounding whitespace. */
function trimSpan(source: string, start: number, end: number): Span {
  let s = start
  let e = end
  while (s < e && /\s/.test(source[s]!)) s++
  while (e > s && /\s/.test(source[e - 1]!)) e--
  return { start: s, end: e }
}

/**
 * Extract every link in `body`.
 *
 * The regex is constructed per call on purpose: a shared module-level `/g`
 * regex carries `lastIndex` between calls and yields intermittently wrong
 * results.
 */
export function parseLinks(body: string): ParsedLink[] {
  const re = /\[\[([\s\S]*?)\]\]/g
  const out: ParsedLink[] = []
  let m: RegExpExecArray | null
  let ordinal = 0

  while ((m = re.exec(body)) !== null) {
    const whole = m[0]
    const inner = m[1]!
    const innerStart = m.index + 2

    let targetStart: number
    let targetEnd: number
    let label: string | null

    const arrowRight = inner.lastIndexOf('->')
    const arrowLeft = inner.indexOf('<-')

    if (arrowRight !== -1) {
      // [[Display->Target]]
      targetStart = innerStart + arrowRight + 2
      targetEnd = innerStart + inner.length
      label = inner.slice(0, arrowRight).trim()
    } else if (arrowLeft !== -1) {
      // [[Target<-Display]]
      targetStart = innerStart
      targetEnd = innerStart + arrowLeft
      label = inner.slice(arrowLeft + 2).trim()
    } else {
      const pipe = inner.lastIndexOf('|')
      if (pipe !== -1) {
        // [[Display|Target]]
        targetStart = innerStart + pipe + 1
        targetEnd = innerStart + inner.length
        label = inner.slice(0, pipe).trim()
      } else {
        // [[Target]]
        targetStart = innerStart
        targetEnd = innerStart + inner.length
        label = null
      }
    }

    const targetSpan = trimSpan(body, targetStart, targetEnd)
    const target = body.slice(targetSpan.start, targetSpan.end)

    // A link with no target at all (`[[]]`, `[[foo->]]`) is not a link.
    if (target.length === 0) continue

    out.push({
      ordinal: ordinal++,
      target,
      label: label !== null && label.length > 0 ? label : null,
      span: { start: m.index, end: m.index + whole.length },
      targetSpan,
    })
  }

  return out
}

/**
 * Rewrite every link in `body` whose target is exactly `from` so that it points
 * at `to`. Only the target substring is replaced; display text and surrounding
 * prose are left byte-for-byte intact.
 *
 * Matching is exact, which is what makes codes case-sensitive end to end.
 *
 * Splices run right-to-left so that earlier spans stay valid as we go.
 */
export function retargetLinks(body: string, from: string, to: string): string {
  // The one-entry case of `remapLinks`, and kept as one call rather than a
  // second splice loop: a change to how targets are spliced has to land in one
  // place, or the bulk path and the single path drift apart.
  return remapLinks(body, new Map([[from, to]]))
}

/**
 * Rewrite every link target in `body` through `mapping`, in a single pass.
 *
 * Not a loop of `retargetLinks` calls: a recode is a *permutation*, and
 * `P1 -> P2` followed by `P2 -> P3` would move the same link twice. One pass
 * over the parse looks every target up once, in the old vocabulary, so a swap
 * stays a swap.
 *
 * A target the mapping does not name is left byte-for-byte alone — that is what
 * keeps a deliberately dangling link dangling.
 *
 * Splices run right-to-left, the same discipline `retargetLinks` follows.
 */
export function remapLinks(body: string, mapping: ReadonlyMap<string, string>): string {
  if (mapping.size === 0) return body
  const hits = parseLinks(body).filter((l) => {
    const to = mapping.get(l.target)
    return to !== undefined && to !== l.target
  })
  if (hits.length === 0) return body

  let out = body
  for (let i = hits.length - 1; i >= 0; i--) {
    const { target, targetSpan } = hits[i]!
    out = out.slice(0, targetSpan.start) + mapping.get(target)! + out.slice(targetSpan.end)
  }
  return out
}


/**
 * Build link text pointing at `target`, optionally shown as `label`.
 *
 * The pipe form is the one written here because it is the one the app teaches
 * everywhere else — the help panel, the editor hints and the test helpers all
 * use it. A label equal to the target, or an empty one, collapses to the bare
 * `[[Target]]` form rather than writing `[[Cave|Cave]]`.
 *
 * A target containing `]]`, `|` or an arrow cannot be expressed as a link at
 * all, so those characters are stripped rather than emitting text that
 * `parseLinks` would read back as something else.
 */
export function buildLink(target: string, label?: string | null): string {
  const safeTarget = sanitize(target)
  if (safeTarget.length === 0) return ''
  const safeLabel = sanitize(label ?? '')
  if (safeLabel.length === 0 || safeLabel === safeTarget) return `[[${safeTarget}]]`
  return `[[${safeLabel}|${safeTarget}]]`
}

/** Strip the delimiters that would make link text parse as a different link. */
function sanitize(text: string): string {
  return text.replace(/\]\]|\[\[|->|<-|\|/g, ' ').replace(/\s+/g, ' ').trim()
}
