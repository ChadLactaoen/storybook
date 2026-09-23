// @vitest-environment jsdom
/**
 * The reader view: what the published player draws, and how it behaves.
 *
 * The player is run from source over a real payload, built by the same
 * `buildPayload` Publish and Play use, so each test walks the actual key graph
 * rather than a mock of it. `publish.test.ts` checks what the file hides; this
 * file checks what a reader is shown.
 *
 * The trail rules moved here with the player from the old in-editor reader,
 * where the same tests held its `playSlug`: the stack of passages visited is
 * the whole of the computation, so a mark collected twice is shown twice.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPayload, type Payload, type PayloadOptions } from '../lib/publish/payload'
import { contentAddr, encodeText, fromBase64, toBase64 } from '../lib/publish/crypto'
import { start } from '../lib/publish/player'
import type { StoryDoc } from '../types/story'
import { docFrom } from './helpers'

const PREFS_KEY = 'storyboard.reader.v1'

let mount: HTMLElement

beforeEach(() => {
  window.scrollTo = () => {}
  localStorage.clear()
  document.body.replaceChildren()
  delete document.documentElement.dataset.theme
})

/**
 * Build `doc` into a page's worth of DOM and start the player on it. `damage`
 * gets the payload before it is embedded, for the tests about a broken file.
 */
async function play(
  doc: StoryDoc,
  options: Partial<PayloadOptions> = {},
  damage?: (payload: Payload) => Promise<void>,
): Promise<void> {
  const payload = await buildPayload(doc, { theme: 'folio', ...options })
  if (damage !== undefined) await damage(payload)
  const holder = document.createElement('script')
  holder.type = 'application/json'
  holder.id = 'story-payload'
  holder.textContent = toBase64(encodeText(JSON.stringify(payload)))
  mount = document.createElement('div')
  document.body.append(holder, mount)
  await start(mount)
}

const q = <T extends Element = HTMLElement>(selector: string) => mount.querySelector<T>(selector)
const text = (selector: string) => q(selector)?.textContent ?? null
const choices = () => [...mount.querySelectorAll<HTMLButtonElement>('.choices .choice')]
const title = () => text('.passage-title')
const trail = () => text('.passage-footer .passage-trail')

/** Take a choice by its position, then wait for the next passage to draw. */
async function choose(index: number): Promise<void> {
  const before = mount.querySelector('.passage-meta')
  choices()[index]!.click()
  await vi.waitFor(() => expect(mount.querySelector('.passage-meta')).not.toBe(before))
}

function body(doc: StoryDoc, nodeTitle: string, value: string): void {
  doc.nodes.find((n) => n.title === nodeTitle)!.body = value
}

describe('a passage', () => {
  it('shows the story title, the code, the passage title and the prose', async () => {
    const doc = docFrom({ One: ['Two'], Two: [] }, { codes: { One: '05N12' } })
    doc.storyTitle = 'The Knock'
    body(doc, 'One', 'Rain on the shutters.\n[[Answer the door|P2]]')
    await play(doc)

    expect(text('.reader-header__title')).toBe('The Knock')
    // Opaque: never parsed, never padded.
    expect(text('.passage-code')).toBe('05N12')
    expect(title()).toBe('One')
    expect(text('.passage-body')).toBe('Rain on the shutters.')
  })

  it('makes the choice text the link, and never shows where it leads', async () => {
    await play(docFrom({ One: ['Two'], Two: [] }))
    expect(choices().map((c) => c.querySelector('.choice__text')!.textContent)).toEqual(['Go to Two'])
    expect(q('.choices')!.textContent).not.toContain('P2')
    expect(text('.keys-hint')).toBe('Key 1 to choose')
  })

  it('draws the markup the author wrote as text, never as markup', async () => {
    const doc = docFrom({ One: [] })
    body(doc, 'One', 'A <b>bold</b> claim <img src=x onerror=alert(1)>')
    await play(doc)
    expect(q('.passage-body b')).toBeNull()
    expect(q('.passage-body img')).toBeNull()
    expect(text('.passage-body')).toContain('<b>bold</b>')
  })

  it('shows an unread macro’s whole source, not just its name', async () => {
    // `run.ts` reads `(Note: …)` as a macro. Printing `(note:)` would delete
    // the author's aside.
    const doc = docFrom({ One: [] })
    body(doc, 'One', 'He lied (Note: he always lies) and left.')
    await play(doc)
    expect(text('.passage-body')).toContain('(Note: he always lies)')
  })

  it('offers no Back and no Restart while the story is going somewhere', async () => {
    await play(docFrom({ One: ['Two'], Two: ['Three'], Three: [] }))
    await choose(0)
    const labels = [...mount.querySelectorAll('button')].map((b) => b.textContent!.trim())
    expect(labels.some((l) => /back|undo|restart|start over/i.test(l))).toBe(false)
  })

  it('offers Restart on a dead end the author has not called an ending', async () => {
    // Not an ending, so no "The End"; but a reader must not be stranded.
    await play(docFrom({ One: ['Two'], Two: [] }))
    await choose(0)
    expect(q('.end-marker')).toBeNull()
    expect(q('.restart-button')).not.toBeNull()
  })

  it('disables a link to a passage nobody has written', async () => {
    await play(docFrom({ One: ['Ghost'] }))
    expect(choices()[0]!.disabled).toBe(true)
    expect(text('.choice__why')).toBe('this link leads nowhere yet')
  })

  it('carries what a passage set into the next one', async () => {
    const doc = docFrom({ One: ['Two'], Two: [] })
    body(doc, 'One', '(set: $lantern to "lit")\n[[Go to Two|P2]]')
    body(doc, 'Two', 'The lantern is $lantern.')
    await play(doc)
    await choose(0)
    expect(text('.passage-body')).toBe('The lantern is lit.')
  })
})

describe('an ending', () => {
  const story = () =>
    docFrom(
      { One: ['Two'], Two: ['Three'], Three: [] },
      { endings: ['Three'], slugs: { One: 'Sk', Two: 'Dt', Three: 'LlO' } },
    )

  it('looks like any other passage above the body', async () => {
    await play(story())
    const top = () =>
      [...mount.querySelectorAll('.reader-main > *')]
        .slice(0, 2)
        .map((n) => n.className)
    // The top row, with the code's own text taken out: its shape must not
    // change, or the row gives the ending away.
    const row = () => q('.passage-meta')!.outerHTML.replace(/>P\d+</, '><')
    const normal = top()
    const normalRow = row()
    await choose(0)
    await choose(0)
    expect(top()).toEqual(normal)
    expect(row()).toBe(normalRow)
    // "The End" only after the prose.
    const order = [...mount.querySelectorAll('.reader-main > *')].map((n) => n.className)
    expect(order.indexOf('end-marker')).toBeGreaterThan(order.indexOf('passage-body'))
    expect(q('.choices')).toBeNull()
    // The whole trail is in "Your trail" with Copy, so no footer repeats it.
    expect(q('.passage-footer')).toBeNull()
  })

  it('shows the trail, the choices taken, and Restart', async () => {
    await play(story())
    await choose(0)
    await choose(0)

    expect(text('.end-marker__text')).toBe('The End')
    expect(text('.trail-box__code')).toBe('SkDtLlO')
    const history = [...mount.querySelectorAll('.choice-history__item')].map((li) => li.textContent)
    expect(history).toEqual(['01Go to Two', '02Go to Three'])
    expect(q('.restart-button')).not.toBeNull()
  })

  it('copies the trail and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await play(story())
    await choose(0)
    await choose(0)

    q<HTMLButtonElement>('.trail-box__copy')!.click()
    await vi.waitFor(() => expect(text('.trail-box__copy')).toBe('Copied'))
    expect(writeText).toHaveBeenCalledWith('SkDtLlO')
  })

  it('starts again with an empty trail and no choices taken', async () => {
    await play(story())
    await choose(0)
    await choose(0)

    const before = q('.passage-meta')
    q<HTMLButtonElement>('.restart-button')!.click()
    await vi.waitFor(() => expect(q('.passage-meta')).not.toBe(before))

    expect(title()).toBe('One')
    expect(trail()).toBe('Sk')
  })
})

describe('the trail', () => {
  it('runs the marks together in the order they were collected, case and all', async () => {
    await play(docFrom({ One: ['Two'], Two: ['Three'], Three: [] }, { slugs: { One: 'Sk', Two: 'dT', Three: 'D' } }))
    expect(trail()).toBe('Sk')
    await choose(0)
    expect(trail()).toBe('SkdT')
    await choose(0)
    expect(trail()).toBe('SkdTD')
  })

  it('skips a passage that carries no mark', async () => {
    await play(docFrom({ One: ['Two'], Two: ['Three'], Three: [] }, { slugs: { One: 'A', Three: 'D' } }))
    await choose(0)
    await choose(0)
    expect(trail()).toBe('AD')
  })

  it('says which way a reader went where the canvas has to write a star', async () => {
    const doc = docFrom(
      { One: ['Two', 'Three'], Two: ['Four'], Three: ['Four'], Four: [] },
      { slugs: { One: 'A', Two: 'B', Three: 'C', Four: 'D' } },
    )
    await play(doc)
    await choose(1)
    await choose(0)
    expect(trail()).toBe('ACD')
  })

  it('collects a mark twice when the route goes round a loop', async () => {
    await play(docFrom({ One: ['Two'], Two: ['One'] }, { slugs: { One: 'A', Two: 'B' } }))
    await choose(0)
    await choose(0)
    expect(trail()).toBe('ABA')
  })

  it('keeps the parentheses inside a mark', async () => {
    await play(docFrom({ One: ['Two'], Two: [] }, { slugs: { One: 'A(a)', Two: 'D' } }))
    await choose(0)
    expect(trail()).toBe('A(a)D')
  })

  it('sits in a footer below the choices, never in the top row', async () => {
    await play(docFrom({ One: ['Two'], Two: [] }, { slugs: { One: 'SkDt' } }))
    expect(q('.passage-meta .passage-trail')).toBeNull()
    expect(q('.passage-meta')!.children).toHaveLength(1)

    const order = [...mount.querySelectorAll('.reader-main > *')].map((n) => n.className)
    expect(order.indexOf('passage-footer')).toBe(order.indexOf('choices') + 1)
    // The keys hint shares the footer rather than standing on its own.
    expect(q('.passage-footer .keys-hint')).not.toBeNull()
    expect(q('.reader-main > .keys-hint')).toBeNull()
  })

  it('leaves the trail row out until something is collected', async () => {
    await play(docFrom({ One: ['Two'], Two: [] }))
    expect(q('.passage-footer__trail')).toBeNull()
    expect(q('.passage-footer .keys-hint')).not.toBeNull()
  })

  it('stays on a dead end, which has no choices but still a trail', async () => {
    await play(docFrom({ One: ['Two'], Two: [] }, { slugs: { One: 'A', Two: 'B' } }))
    await choose(0)
    expect(q('.choices')).toBeNull()
    expect(trail()).toBe('AB')
    expect(q('.passage-footer .keys-hint')).toBeNull()
  })
})

describe('keys', () => {
  it('takes the matching choice with 1 to 9', async () => {
    await play(docFrom({ One: ['Two', 'Three'], Two: [], Three: [] }))
    const before = q('.passage-meta')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))
    await vi.waitFor(() => expect(q('.passage-meta')).not.toBe(before))
    expect(title()).toBe('Three')
  })

  it('ignores a held key, so one press takes one choice', async () => {
    await play(docFrom({ One: ['Two'], Two: ['Three'], Three: [] }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', repeat: true, bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    expect(title()).toBe('One')
  })

  it('leaves a key alone while a text field has focus, or with a modifier held', async () => {
    await play(docFrom({ One: ['Two'], Two: [] }))
    const input = document.createElement('input')
    document.body.append(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    expect(title()).toBe('One')
  })
})

describe('themes', () => {
  it('draws in the author’s theme, on the reader and the page', async () => {
    await play(docFrom({ One: [] }), { theme: 'phosphor' })
    expect(q('.reader')!.dataset.theme).toBe('phosphor')
    expect(document.documentElement.dataset.theme).toBe('phosphor')
  })

  it('switches theme and size from the Aa popover, and remembers them', async () => {
    await play(docFrom({ One: [] }), { theme: 'folio' })
    const aa = q<HTMLButtonElement>('.reader-header__textsize')!
    expect(q('.reader-settings')!.hidden).toBe(true)
    aa.click()
    expect(q('.reader-settings')!.hidden).toBe(false)

    q<HTMLButtonElement>('[data-theme-option="daylight"]')!.click()
    q<HTMLButtonElement>('[data-size="l"]')!.click()
    expect(q('.reader')!.dataset.theme).toBe('daylight')
    expect(q('.reader')!.style.getPropertyValue('--body-size')).toBe('1.15')
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ theme: 'daylight', size: 'l', over: 'folio' })

    await play(docFrom({ One: [] }), { theme: 'folio' })
    expect(q('.reader')!.dataset.theme).toBe('daylight')
  })

  it('lets a new author default win over a reader choice made against the old one', async () => {
    // Play tabs share the editor's origin, so without this one click on Aa
    // would outrank every theme the author picks afterwards.
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'daylight', size: 's', over: 'folio' }))
    await play(docFrom({ One: [] }), { theme: 'marquee' })
    expect(q('.reader')!.dataset.theme).toBe('marquee')
    // Size is not the author's to set, so it stays.
    expect(q('.reader')!.style.getPropertyValue('--body-size')).toBe('0.9')
  })

  it('shows a preview in its own theme, and remembers nothing chosen inside it', async () => {
    // Previews share the editor's origin with every Play tab, so a saved
    // choice would leak into them all.
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'phosphor', size: 'l', over: 'marquee' }))
    await play(docFrom({ One: [] }), { theme: 'marquee', preview: true })
    expect(q('.reader')!.dataset.theme).toBe('marquee')
    expect(q('.reader')!.style.getPropertyValue('--body-size')).toBe('1')

    q<HTMLButtonElement>('[data-theme-option="daylight"]')!.click()
    expect(q('.reader')!.dataset.theme).toBe('daylight')
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).theme).toBe('phosphor')
  })

  it('survives storage that throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    await play(docFrom({ One: [] }), { theme: 'marquee' })
    expect(q('.reader')!.dataset.theme).toBe('marquee')
    vi.restoreAllMocks()
  })
})

describe('the author console', () => {
  it('is absent from a published page', async () => {
    await play(docFrom({ One: [] }))
    expect(q('.author-console')).toBeNull()
  })

  it('shows the route, the variables and who set them when Play asks for it', async () => {
    const doc = docFrom({ One: ['Two'], Two: [] })
    body(doc, 'One', '(set: $lantern to "lit")\n[[Go to Two|P2]]')
    await play(doc, { author: true })
    await choose(0)

    const rows = text('.author-console')!
    expect(rows).toContain('P1->P2')
    expect(rows).toContain('$lantern')
    expect(rows).toContain('lit · set by P1')
  })

  it('says on the page, not only in the console, that a session started mid-story', async () => {
    // The console is collapsed; a gated branch failing silently is what the
    // note exists to explain, so it cannot be somewhere the author must open.
    const doc = docFrom({ One: ['Two'], Two: [] })
    await play(doc, { author: true, start: doc.nodes[1]!.id })
    expect(title()).toBe('Two')
    expect(text('.reader-main .author-note')).toMatch(/mid-story/)
    expect(text('.author-console')).toMatch(/mid-story/)
  })

  it('says on the page when a passage asks for input it will not get', async () => {
    const doc = docFrom({ One: [] })
    body(doc, 'One', '(set: $name to (prompt: "Your name?", "Mira"))Hello $name.')
    await play(doc, { author: true })
    expect(text('.reader-main .author-note')).toMatch(/asks the reader for \$name/)
    expect(text('.author-console')).toContain('$name')
  })

  it('keeps both notes off a published page', async () => {
    const doc = docFrom({ One: [] })
    body(doc, 'One', '(set: $name to (prompt: "Your name?", "Mira"))Hello $name.')
    await play(doc)
    expect(q('.author-note')).toBeNull()
  })
})

describe('a damaged file', () => {
  /** Drop every blob but the start's, so the first choice leads to nothing. */
  const keepOnlyStart = async (payload: Payload) => {
    const start = toBase64(await contentAddr(fromBase64(payload.start)))
    payload.blobs = payload.blobs.filter(([addr]) => addr === start)
  }

  it('says a passage could not be opened, and offers Restart rather than a dead page', async () => {
    await play(docFrom({ One: ['Two'], Two: [] }, { slugs: { One: 'A' } }), { author: true }, keepOnlyStart)
    const before = q('.passage-meta')
    choices()[0]!.click()
    await vi.waitFor(() => expect(q('.passage-meta')).not.toBe(before))

    expect(text('.reader-fail')).toMatch(/could not be opened/)
    expect(q('.restart-button')).not.toBeNull()
    // Nothing was pushed for the passage that failed: the route is intact.
    expect(text('.author-console')).toContain('P1')
    expect(text('.author-console')).not.toContain('P1->')
  })

  it('reads again from the start after a failure', async () => {
    await play(docFrom({ One: ['Two'], Two: [] }), {}, keepOnlyStart)
    choices()[0]!.click()
    await vi.waitFor(() => expect(q('.reader-fail')).not.toBeNull())

    q<HTMLButtonElement>('.restart-button')!.click()
    await vi.waitFor(() => expect(title()).toBe('One'))
  })

  it('does not blame the browser when the story itself will not open', async () => {
    await play(docFrom({ One: [] }), {}, async (payload) => {
      payload.blobs = []
    })
    expect(text('.reader-fail')).toMatch(/incomplete or damaged/)
    expect(text('.reader-fail')).not.toMatch(/WebCrypto/)
  })
})
