import { describe, expect, it } from 'vitest'
import { BOLD, ITALIC, insertLink, toggleBlockquote, toggleWrap } from '../lib/harlowe/format'
import { tokenize } from '../lib/harlowe/highlight'
import { buildLink, parseLinks } from '../lib/harlowe/links'

/**
 * A selection written inline: `sel('a |bc| d')` selects "bc". Reading the test
 * cases matters more here than anywhere, because every one of them is a claim
 * about where the caret ends up.
 */
function sel(marked: string) {
  const start = marked.indexOf('|')
  const end = marked.indexOf('|', start + 1) - 1
  return { text: marked.replace(/\|/g, ''), start, end }
}

/** The inverse, so an assertion can show the caret too. */
function show(s: { text: string; start: number; end: number }) {
  return s.text.slice(0, s.start) + '|' + s.text.slice(s.start, s.end) + '|' + s.text.slice(s.end)
}

describe('toggleWrap', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(show(toggleWrap(sel('she |ran| home'), BOLD))).toBe("she ''|ran|'' home")
  })

  it('unwraps when the markers sit just outside the selection', () => {
    expect(show(toggleWrap(sel("she ''|ran|'' home"), BOLD))).toBe('she |ran| home')
  })

  it('unwraps when the selection swallows the markers', () => {
    expect(show(toggleWrap(sel("she |''ran''| home"), BOLD))).toBe('she |ran| home')
  })

  it('parks the caret between a fresh pair when nothing is selected', () => {
    expect(show(toggleWrap(sel('she ||home'), ITALIC))).toBe('she //||//home')
  })

  // The bolded word stays selected, so italicising next nests inside the bold
  // rather than around it — and either marker can still be taken off alone.
  it('keeps the two markers independent', () => {
    const bolded = toggleWrap(sel('she |ran| home'), BOLD)
    const both = toggleWrap(bolded, ITALIC)
    expect(both.text).toBe("she ''//ran//'' home")
    expect(toggleWrap(both, ITALIC).text).toBe("she ''ran'' home")
  })

  it('does not mistake a marker at the very start for a wrapper', () => {
    expect(toggleWrap(sel('|ran| home'), BOLD).text).toBe("''ran'' home")
  })
})

describe('toggleBlockquote', () => {
  it('quotes every line the selection touches', () => {
    const out = toggleBlockquote(sel('one\ntw|o\nthre|e\nfour'))
    expect(out.text).toBe('one\n> two\n> three\nfour')
    // The whole block comes back selected, so the shortcut is its own undo.
    expect(out.text.slice(out.start, out.end)).toBe('> two\n> three')
  })

  it('strips the quote when every written line already has one', () => {
    expect(toggleBlockquote(sel('|> two\n> three|')).text).toBe('two\nthree')
  })

  it('quotes again when only some lines carry it', () => {
    expect(toggleBlockquote(sel('|> two\nthree|')).text).toBe('> > two\n> three')
  })

  it('quotes blank lines without leaving a trailing space', () => {
    expect(toggleBlockquote(sel('|two\n\nthree|')).text).toBe('> two\n>\n> three')
  })

  it('widens a caret to the whole line it sits on', () => {
    expect(toggleBlockquote(sel('one\ntw|o|\nthree')).text).toBe('one\n> two\nthree')
  })

  it('stops at the line the selection appears to stop at', () => {
    expect(toggleBlockquote(sel('|one\n|two')).text).toBe('> one\ntwo')
  })
})

describe('insertLink', () => {
  it('uses the selected prose as the display text', () => {
    const out = insertLink(sel('You could |go north| from here.'), 'Cave')
    expect(out.text).toBe('You could [[go north|Cave]] from here.')
    // Caret after the link, ready to keep writing.
    expect(out.start).toBe(out.end)
    expect(out.text.slice(0, out.start)).toBe('You could [[go north|Cave]]')
  })

  it('writes the bare form when nothing is selected', () => {
    expect(insertLink(sel('Then ||'), 'Cave').text).toBe('Then [[Cave]]')
  })

  it('leaves the body alone when the target is empty', () => {
    const before = sel('Then ||')
    expect(insertLink(before, '   ')).toEqual(before)
  })

  it('produces links the parser reads back as written', () => {
    const body = insertLink(sel('|go north|'), 'Cave').text
    const [link] = parseLinks(body)
    expect(link?.target).toBe('Cave')
    expect(link?.label).toBe('go north')
  })
})

describe('buildLink', () => {
  it('collapses a label that matches the target', () => {
    expect(buildLink('Cave', 'Cave')).toBe('[[Cave]]')
    expect(buildLink('Cave', '')).toBe('[[Cave]]')
    expect(buildLink('Cave')).toBe('[[Cave]]')
  })

  it('strips delimiters that would re-parse as a different link', () => {
    expect(buildLink('Cave', 'go -> north')).toBe('[[go north|Cave]]')
    expect(buildLink('Ca|ve')).toBe('[[Ca ve]]')
  })

  it('flattens a multi-line label onto one line', () => {
    expect(buildLink('Cave', 'go\nnorth')).toBe('[[go north|Cave]]')
  })

  it('is empty when there is no target left to point at', () => {
    expect(buildLink('||')).toBe('')
  })
})

/** The markup the buttons write has to be the markup the overlay paints. */
describe('highlighting the formatting markup', () => {
  const kinds = (src: string) =>
    tokenize(src)
      .filter((t) => t.type !== 'text')
      .map((t) => `${t.type}:${src.slice(t.start, t.end)}`)

  it('paints what the toolbar writes', () => {
    expect(kinds("She ''ran'' home.")).toEqual(["bold:''ran''"])
    expect(kinds('She //ran// home.')).toEqual(['italic://ran//'])
    expect(kinds('> A quoted line')).toEqual(['quote:> '])
  })

  it('leaves empty strings inside a macro alone', () => {
    // Two of them on one line is the trap: read as emphasis, the first `''`
    // would pair with the second and swallow the macro between them.
    expect(kinds("(set: $x to '') (set: $y to '')")).toEqual([
      'macro:(set:',
      'variable:$x',
      'keyword:to',
      "string:''",
      'macro:(set:',
      'variable:$y',
      'keyword:to',
      "string:''",
    ])
  })

  it('does not read a URL as italics', () => {
    expect(kinds('See http://example.com/a for more')).toEqual([])
  })

  it('needs a closing marker on the same line', () => {
    expect(kinds("''unclosed\nbold''")).toEqual(["string:''", "string:''"])
  })

  it('only quotes at the start of a line', () => {
    expect(kinds('a > b')).toEqual([])
  })
})
