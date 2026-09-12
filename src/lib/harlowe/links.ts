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
  if (from === to) return body
  const links = parseLinks(body).filter((l) => l.target === from)
  if (links.length === 0) return body

  let out = body
  for (let i = links.length - 1; i >= 0; i--) {
    const { start, end } = links[i]!.targetSpan
    out = out.slice(0, start) + to + out.slice(end)
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
