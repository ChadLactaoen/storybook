/**
 * The published demo's runtime: the whole of what ships inside the HTML file.
 *
 * This is the only entry point the player bundle has, and it imports the real
 * `run.ts`. That is the point of the whole arrangement — a published demo that
 * evaluated macros with its own reimplementation would drift from the editor's
 * reader, and the first anyone would learn of it is a reader seeing prose the
 * author never saw. One evaluator, bundled twice.
 *
 * It is also the editor's reader. Play builds this same page and opens it in a
 * tab, with `payload.author` set, which adds a console and nothing else. The
 * author tests exactly what a reader will get.
 *
 * Two rules hold this file apart from the rest of the app:
 *
 * **Nothing here may reach the store, Vue, or the document model.** The bundle
 * is built from this entry alone, so an import of either would drag the editor
 * into a file meant to be handed to a stranger.
 *
 * **Prose reaches the page through `textContent`, never `innerHTML`.** `run.ts`
 * escapes nothing — it says so at the top of the file — because in the editor
 * Vue escapes unconditionally, and that property does not travel into a string
 * of HTML. Building nodes instead of markup makes the escaping bug structurally
 * impossible rather than merely avoided, which matters in the one place where
 * the text being rendered is the author's and the reader is someone else. The
 * icons are built the same way, with `createElementNS`.
 *
 * The markup is the same for every theme; a theme is CSS only (`styles.ts`).
 * The shell (header, popover, console) is built once, and each passage replaces
 * only the column, so the popover and the console keep their state as the
 * reader moves on.
 */

import { linesOf, renderPassage, type Block, type Inline, type RunResult, type Vars } from '../../harlowe/run'
import { followLink, indexPayload, openPassage, type Lookup, type Payload } from '../payload'
import { fromBase64, decodeText } from '../crypto'
import { DEFAULT_THEME, THEMES, isPlayerTheme, type PlayerTheme } from '../themes'

/** Where `html.ts` parks the base64 payload. */
const PAYLOAD_ID = 'story-payload'

/** The reader's own choices, kept in this browser. See `loadPrefs`. */
const PREFS_KEY = 'storyboard.reader.v1'

/** How long the Copy button says "Copied". */
const COPIED_MS = 2000

const SIZES = [
  { id: 's', label: 'S', name: 'Small', scale: '0.9' },
  { id: 'm', label: 'M', name: 'Medium', scale: '1' },
  { id: 'l', label: 'L', name: 'Large', scale: '1.15' },
] as const
type Size = (typeof SIZES)[number]['id']

/** One passage the reader has stood on, and what they carried into it. */
interface Step {
  key: Uint8Array
  /**
   * The variables as they stood on *entering*, copied, exactly as the editor's
   * reader used to keep them. With no Back there is no pop to make exact, but
   * Restart and the console both read the stack as a record of the walk.
   */
  varsBefore: Vars
  /** Which passage last set each variable, by code, as of entering. */
  setterBefore: ReadonlyMap<string, string>
  /** The text of the choice that led here. Null for the first passage. */
  label: string | null
  /** Read out of the envelope when the passage opens. */
  code: string
  slug: string
}

interface Rendered {
  title: string
  isEnding: boolean
  result: RunResult
}

interface ReaderPrefs {
  theme: PlayerTheme
  size: Size
}

/** The reader's position. It only ever grows, until Restart empties it. */
const stack: Step[] = []
let payload: Payload
let lookup: Lookup
let current: Rendered | null = null
/** A choice is being opened. Guards a double click from taking two. */
let busy = false
let prefs: ReaderPrefs = { theme: DEFAULT_THEME, size: 'm' }

let reader: HTMLElement
let column: HTMLElement
let textButton: HTMLButtonElement
let popover: HTMLElement
let consoleRows: HTMLElement | null = null
/** The choice buttons keys 1-9 press, in order. */
let keyed: HTMLButtonElement[] = []
/**
 * The key behind each of the current passage's links, by ordinal, or null where
 * a link leads nowhere. Unwrapped once, when the passage opens: the page needs
 * to know which links work, and a choice needs the key itself.
 */
let linkKeys = new Map<number, Uint8Array | null>()
let listening = false

const PASSAGE_FAILED = 'This passage could not be opened. The file may be incomplete or damaged.'
const START_FAILED = 'This story could not be opened. The file may be incomplete or damaged.'
const BROWSER_UNSUPPORTED =
  'This story could not be opened. It needs a browser with WebCrypto and gzip support — Safari 16.4, Chrome 80 or Firefox 113 and newer.'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined && className.length > 0) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className: string, text?: string): HTMLButtonElement {
  const node = el('button', className, text)
  node.type = 'button'
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** An icon, built node by node for the same reason the prose is. */
function icon(
  size: number,
  strokeWidth: string | null,
  shapes: [string, Record<string, string>][],
  className?: string,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const attrs: Record<string, string> = {
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-linecap': 'square',
    'aria-hidden': 'true',
  }
  if (strokeWidth !== null) attrs['stroke-width'] = strokeWidth
  if (className !== undefined) attrs.class = className
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value)
  for (const [tag, shapeAttrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag)
    for (const [name, value] of Object.entries(shapeAttrs)) shape.setAttribute(name, value)
    svg.append(shape)
  }
  return svg
}

const arrowIcon = () => icon(20, null, [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]], 'choice__arrow')
const copyIcon = () =>
  icon(16, '2', [
    ['rect', { x: '8', y: '8', width: '13', height: '13' }],
    ['path', { d: 'M16 8V3H3v13h5' }],
  ])
const restartIcon = () =>
  icon(16, '2.5', [
    ['path', { d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }],
    ['path', { d: 'M3 3v5h5' }],
  ])

/** A line holding nothing but links is a choice list, not prose. */
function isChoiceLine(line: readonly Inline[]): boolean {
  return (
    line.length > 0 &&
    line.every(
      (inline) => inline.kind === 'link' || (inline.kind === 'text' && inline.text.trim() === ''),
    )
  )
}

/**
 * The prose, without the lines that are nothing but links.
 *
 * Filtering per *line* rather than per block is what catches the commonest
 * Twine shape of all: links written directly under the prose with no blank line
 * between. `toBlocks` merges those into one block, so a per-block filter misses
 * them and every choice renders twice.
 */
function proseOf(result: RunResult): Block[] {
  return result.blocks.flatMap((block) => {
    const kept = linesOf(block.inlines).filter((line) => !isChoiceLine(line))
    if (kept.every((line) => line.length === 0)) return []
    const inlines: Inline[] = []
    for (const line of kept) {
      if (inlines.length > 0) {
        inlines.push({
          kind: 'text',
          text: '\n',
          bold: false,
          italic: false,
          uncertain: false,
          inert: false,
        })
      }
      inlines.push(...line)
    }
    return [{ kind: block.kind, inlines }]
  })
}

function marks(inline: Inline): string {
  return [
    inline.bold ? 'b' : '',
    inline.italic ? 'i' : '',
    inline.uncertain ? 'hazy' : '',
  ]
    .filter((c) => c.length > 0)
    .join(' ')
}

function renderInline(inline: Inline, blocked: (ordinal: number) => string | null): Node {
  switch (inline.kind) {
    case 'text':
      return el('span', marks(inline), inline.text)
    case 'variable':
      // An unset variable shows its own name. Rendering an empty string would
      // silently swallow the gap, and the author is the one who needs to see it.
      return el('span', marks(inline), inline.state === 'set' ? (inline.value ?? '') : inline.name)
    case 'link': {
      const link = button(`inline-link ${marks(inline)}`.trim(), inline.label)
      const why = blocked(inline.ordinal)
      if (why !== null) {
        link.disabled = true
        link.title = why
      } else {
        link.addEventListener('click', () => void choose(inline.ordinal, inline.label))
      }
      return link
    }
    case 'unsupported': {
      // The whole source, not the macro's name. `run.ts` reads any `(word:` as
      // a macro, so an aside like `(Note: he always lies)` lands here, and
      // printing only `(note:)` would delete the author's sentence. Marked, so
      // a reader can tell text this player could not run from plain prose.
      const chip = el('span', 'hazy', inline.source)
      chip.title = 'This player could not run that macro, so it shows what was written.'
      return chip
    }
  }
}

/** Why this choice cannot be taken, or null. */
function blockedReason(rendered: Rendered, hasTarget: boolean): string | null {
  if (rendered.isEnding) return 'the story ends here'
  if (!hasTarget) return 'this link leads nowhere yet'
  return null
}

/**
 * The marks this reader has collected, run together.
 *
 * Deliberately **not** `runningSlugs`, which describes every route to a passage
 * at once and writes `*` where they disagree. A reading has walked exactly one
 * route, so nothing can disagree and the answer is a literal: it is what the
 * editor's `*` stands for, made concrete on the way the reader actually went.
 *
 * Plain concatenation is the whole computation. `normalizeSlug` strips `*` from
 * what an author types, so no mark can be mistaken for a marker. The stack holds
 * a passage once per visit, so a mark collected twice round a loop appears twice.
 *
 * Case is kept exactly as written, and the stylesheet forbids any theme to
 * transform it: `Ab` and `AB` are different marks.
 */
function trail(): string {
  return stack.map((step) => step.slug).join('')
}

/** The route as codes, `P1->P3->P7`, the identity invariant 3 names. */
function route(): string {
  return stack.map((step) => step.code).join('->')
}

// --- The reader's preferences ----------------------------------------------

/**
 * The reader's theme and text size, as they last left them.
 *
 * A saved theme applies only while the author's default is the one it was
 * chosen over. Change the default and a reader's old override yields to it.
 * That matters most in the editor: Play opens a Blob URL on the editor's own
 * origin, so every Play tab shares one store. Without the check, one click on
 * `Aa` would outrank the setting the author changes afterwards, forever.
 *
 * Wrapped whole, because a published file runs from `file://`, in private
 * windows, and on browsers that throw rather than return null.
 */
function loadPrefs(authored: PlayerTheme): ReaderPrefs {
  const out: ReaderPrefs = { theme: authored, size: 'm' }
  // A preview shows the theme it was opened for, whatever a reader last chose.
  if (payload.preview === true) return out
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw === null) return out
    const saved = JSON.parse(raw) as { theme?: unknown; size?: unknown; over?: unknown }
    if (saved.over === authored && isPlayerTheme(saved.theme)) out.theme = saved.theme
    const size = SIZES.find((s) => s.id === saved.size)
    if (size !== undefined) out.size = size.id
  } catch {
    // Unreadable or unavailable: the author's defaults are a fine answer.
  }
  return out
}

function savePrefs(): void {
  // And a choice made inside a preview goes nowhere. Previews share the
  // editor's origin with every Play tab, so saving one would reach them all.
  if (payload.preview === true) return
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ theme: prefs.theme, size: prefs.size, over: payload.theme }),
    )
  } catch {
    // Storage off or full. The choice still holds for this visit.
  }
}

function applyPrefs(): void {
  reader.dataset.theme = prefs.theme
  // On `<html>` too, so the page behind the column is the theme's ground.
  document.documentElement.dataset.theme = prefs.theme
  const size = SIZES.find((s) => s.id === prefs.size) ?? SIZES[1]
  reader.style.setProperty('--body-size', size.scale)
  for (const option of popover.querySelectorAll<HTMLButtonElement>('[data-size]')) {
    option.setAttribute('aria-pressed', String(option.dataset.size === prefs.size))
  }
  for (const option of popover.querySelectorAll<HTMLButtonElement>('[data-theme-option]')) {
    option.setAttribute('aria-pressed', String(option.dataset.themeOption === prefs.theme))
  }
}

// --- The shell -------------------------------------------------------------

function setPopover(open: boolean): void {
  popover.hidden = !open
  textButton.setAttribute('aria-expanded', String(open))
}

function buildPopover(): HTMLElement {
  const panel = el('div', 'reader-settings')
  panel.id = 'reader-settings'
  panel.setAttribute('role', 'group')
  panel.setAttribute('aria-label', 'Text settings')
  panel.hidden = true

  const sizes = el('div', 'reader-settings__row')
  for (const size of SIZES) {
    const option = button('reader-settings__option', size.label)
    option.dataset.size = size.id
    option.setAttribute('aria-label', `${size.name} text`)
    option.addEventListener('click', () => {
      prefs.size = size.id
      savePrefs()
      applyPrefs()
    })
    sizes.append(option)
  }

  const themes = el('div', 'reader-settings__row reader-settings__row--themes')
  for (const theme of THEMES) {
    const option = button('reader-settings__option', theme.label)
    option.dataset.themeOption = theme.id
    option.addEventListener('click', () => {
      prefs.theme = theme.id
      savePrefs()
      applyPrefs()
    })
    themes.append(option)
  }

  panel.append(
    el('div', 'reader-settings__label', 'Text size'),
    sizes,
    el('div', 'reader-settings__label', 'Theme'),
    themes,
  )
  return panel
}

/**
 * The author console, for Play only. Collapsed by default, so the tab first
 * shows what a reader will see.
 */
function buildConsole(): HTMLElement {
  const details = el('details', 'author-console')
  details.append(el('summary', 'author-console__summary', 'Author console'))
  consoleRows = el('div', 'author-console__rows')
  details.append(consoleRows)
  return details
}

function buildShell(mount: HTMLElement): void {
  reader = el('div', 'reader')

  const header = el('header', 'reader-header')
  textButton = button('reader-header__textsize', 'Aa')
  textButton.setAttribute('aria-label', 'Text settings')
  textButton.setAttribute('aria-controls', 'reader-settings')
  textButton.setAttribute('aria-expanded', 'false')
  textButton.addEventListener('click', () => setPopover(popover.hidden !== false))
  popover = buildPopover()
  header.append(el('span', 'reader-header__title', payload.title), textButton, popover)

  column = el('main', 'reader-main')
  // Focus lands here after each choice, so Tab starts again at the top of the
  // new passage rather than wherever the old one's buttons used to be.
  column.tabIndex = -1

  reader.append(header, column)
  consoleRows = null
  if (payload.author === true) reader.append(buildConsole())
  mount.replaceChildren(reader)
}

// --- A passage -------------------------------------------------------------

/**
 * The top row: the passage code, and nothing else.
 *
 * The trail used to sit here too. It grows with every passage, and once it
 * wrapped it pushed the title down, so it moved to the footer below the
 * choices. This row is identical on every passage, ending or not, which is what
 * keeps an ending from giving itself away before its prose is read.
 */
function metaRow(step: Step): HTMLElement {
  const meta = el('div', 'passage-meta')
  const code = el('div', 'passage-meta__group passage-meta__group--code')
  code.append(el('span', 'meta-label', 'Passage'), el('span', 'passage-code', step.code))
  meta.append(code)
  return meta
}

/**
 * Below the choices: the trail so far, and the keys hint when there is one.
 *
 * The trail row is left out entirely while nothing has been collected, rather
 * than shown empty. Never drawn on an ending, whose "Your trail" box already
 * shows the whole trail with a Copy button.
 */
function passageFooter(hint: HTMLElement | null): HTMLElement[] {
  const parts: HTMLElement[] = []
  const marksSoFar = trail()
  if (marksSoFar.length > 0) {
    const row = el('div', 'passage-footer__trail')
    row.append(el('span', 'meta-label', 'Trail'), el('span', 'passage-trail', marksSoFar))
    parts.push(row)
  }
  if (hint !== null) parts.push(hint)
  if (parts.length === 0) return []
  const footer = el('div', 'passage-footer')
  footer.append(...parts)
  return [footer]
}

function choiceList(rendered: Rendered, why: (ordinal: number) => string | null): HTMLElement[] {
  const nav = el('nav', 'choices')
  nav.setAttribute('aria-label', 'Choices')
  nav.append(el('div', 'choices__label', 'Choose'))

  rendered.result.choices.forEach((choice, i) => {
    const classes = ['choice']
    if (choice.uncertain) classes.push('hazy')
    const reason = why(choice.ordinal)
    if (reason !== null) classes.push('choice--blocked')
    const row = button(classes.join(' '))

    const key = el('span', 'choice__key', i < 9 ? String(i + 1) : '')
    key.setAttribute('aria-hidden', 'true')
    row.append(key, el('span', 'choice__text', choice.label))
    if (reason !== null) {
      row.disabled = true
      row.append(el('span', 'choice__why', reason))
    } else {
      row.append(arrowIcon())
      row.addEventListener('click', () => void choose(choice.ordinal, choice.label))
    }
    if (i < 9) keyed.push(row)
    nav.append(row)
  })

  const n = Math.min(9, rendered.result.choices.length)
  const hint = el('div', 'keys-hint', n === 1 ? 'Key 1 to choose' : `Keys 1–${n} to choose`)
  return [nav, ...passageFooter(hint)]
}

function restartBlock(): HTMLElement {
  const wrap = el('div', 'restart-wrap')
  const restart = button('restart-button')
  restart.append(restartIcon(), document.createTextNode('Restart story'))
  restart.addEventListener('click', () => void restartStory(true))
  wrap.append(restart)
  return wrap
}

function copyButton(code: HTMLElement, text: string): HTMLButtonElement {
  const copy = button('trail-box__copy')
  const label = document.createTextNode('Copy')
  copy.append(copyIcon(), label)
  let timer: ReturnType<typeof setTimeout> | undefined
  copy.addEventListener('click', () => {
    void (async () => {
      let copied = false
      try {
        await navigator.clipboard.writeText(text)
        copied = true
      } catch {
        // No clipboard here (`file://` in some browsers, or permission
        // refused). Selecting the text leaves the reader one key from done.
        const range = document.createRange()
        range.selectNodeContents(code)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      label.textContent = copied ? 'Copied' : 'Selected'
      clearTimeout(timer)
      timer = setTimeout(() => (label.textContent = 'Copy'), COPIED_MS)
    })()
  })
  return copy
}

/**
 * What an ending adds after the body. The top half of an ending is drawn exactly
 * like any other passage, so nothing gives it away before the prose is read.
 */
function endingBlock(): HTMLElement[] {
  const out: HTMLElement[] = []

  const marker = el('div', 'end-marker')
  marker.setAttribute('role', 'separator')
  marker.setAttribute('aria-label', 'The end')
  marker.append(el('div', 'end-marker__rule'), el('span', 'end-marker__text', 'The End'), el('div', 'end-marker__rule'))
  out.push(marker)

  const collected = trail()
  if (collected.length > 0) {
    const share = el('section', 'trail-share')
    const box = el('div', 'trail-box')
    const code = el('div', 'trail-box__code', collected)
    box.append(code, copyButton(code, collected))
    share.append(
      el('div', 'section-label', 'Your trail'),
      box,
      el('div', 'trail-share__hint', 'Share this code so others can see the path you took.'),
    )
    out.push(share)
  }

  const taken = stack.flatMap((step) => (step.label === null ? [] : [step.label]))
  if (taken.length > 0) {
    const history = el('section', 'choice-history')
    const list = el('ol', 'choice-history__list')
    taken.forEach((text, i) => {
      const item = el('li', 'choice-history__item')
      item.append(el('span', 'choice-history__num', String(i + 1).padStart(2, '0')), document.createTextNode(text))
      list.append(item)
    })
    history.append(el('div', 'section-label', 'Your choices'), list)
    out.push(history)
  }

  out.push(restartBlock())
  return out
}

function consoleRow(key: string, value: string, empty = false): HTMLElement[] {
  return [
    el('span', 'author-console__k', key),
    el('span', empty ? 'author-console__v author-console__v--empty' : 'author-console__v', value),
  ]
}

function drawConsole(rendered: Rendered | null): void {
  if (consoleRows === null) return
  const rows: HTMLElement[] = []
  if (payload.midStory === true) {
    rows.push(
      ...consoleRow(
        'Started',
        'mid-story, with every variable unset, because nothing before this passage has run',
      ),
    )
  }
  rows.push(...consoleRow('Route', route() || '—'))
  const collected = trail()
  if (collected.length > 0) rows.push(...consoleRow('Trail', collected))

  if (rendered !== null) {
    const top = stack[stack.length - 1]
    const wrote = new Set(rendered.result.assigned.map((a) => a.variable))
    const vars = [...rendered.result.vars].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    if (vars.length === 0) rows.push(...consoleRow('Variables', 'none set on this route', true))
    for (const [name, value] of vars) {
      const setBy = wrote.has(name) ? top.code : (top.setterBefore.get(name) ?? top.code)
      rows.push(...consoleRow(name, `${value ?? 'not readable'} · set by ${setBy}`))
    }
    if (rendered.result.asks.length > 0) {
      rows.push(...consoleRow('Asks for', rendered.result.asks.map((a) => a.variable).join(', ')))
    }
    if (rendered.result.unsupported.length > 0) {
      rows.push(...consoleRow('Could not read', rendered.result.unsupported.join(', ')))
    }
  }
  consoleRows.replaceChildren(...rows)
}

/**
 * What the author must see without opening the console, because without it the
 * page states something false about the passage. Play only.
 *
 * Starting mid-story leaves every variable unset, so a gated branch silently
 * fails; and a passage that asks the reader for input gets none here, so what it
 * set stays unset. Both are on the page, in the flow, rather than in the
 * collapsed console, where they would go unread exactly when they matter.
 */
function midStoryNote(): HTMLElement[] {
  if (payload.author !== true || payload.midStory !== true) return []
  return [
    el(
      'p',
      'author-note',
      'Started mid-story, so every variable began unset. A condition that depends on an earlier passage will not fire.',
    ),
  ]
}

function asksNote(rendered: Rendered): HTMLElement[] {
  if (payload.author !== true || rendered.result.asks.length === 0) return []
  const names = rendered.result.asks.map((a) => a.variable).join(', ')
  return [
    el(
      'p',
      'author-note',
      `This passage asks the reader for ${names}. Nothing is typed in here, so it stays unset.`,
    ),
  ]
}

/** A passage opened and evaluated, with its links' keys, not yet on the page. */
interface Opened {
  rendered: Rendered
  links: Map<number, Uint8Array | null>
}

/**
 * Open `step`'s passage and everything its page needs, touching nothing.
 *
 * Null when the passage cannot be decrypted. Throws if the evaluator does. The
 * page and the stack change only once this has succeeded, so a failure leaves
 * the reader where they were rather than half way into a passage that is not
 * there. Every link's key is unwrapped concurrently, before the old page comes
 * down, so a passage with many links does not flash blank while they resolve.
 */
async function open(step: Step): Promise<Opened | null> {
  const envelope = await openPassage(lookup, step.key)
  if (envelope === null) return null
  const rendered: Rendered = {
    title: envelope.t,
    isEnding: envelope.e,
    result: renderPassage(envelope.b, step.varsBefore),
  }
  const ordinals = rendered.result.choices.map((choice) => choice.ordinal)
  const keys = await Promise.all(ordinals.map((ordinal) => followLink(lookup, step.key, ordinal)))
  step.code = envelope.c
  step.slug = envelope.s
  return { rendered, links: new Map(ordinals.map((ordinal, i) => [ordinal, keys[i]!])) }
}

/** Put the top of the stack on the page. Synchronous: everything is in `opened`. */
function draw(opened: Opened): void {
  const step = stack[stack.length - 1]!
  const rendered = opened.rendered
  current = rendered
  linkKeys = opened.links
  keyed = []

  const why = (ordinal: number) => blockedReason(rendered, (linkKeys.get(ordinal) ?? null) !== null)

  const parts: HTMLElement[] = [...midStoryNote(), metaRow(step)]
  if (rendered.title.trim().length > 0) parts.push(el('h1', 'passage-title', rendered.title))

  const body = el('div', 'passage-body')
  for (const block of proseOf(rendered.result)) {
    const box = el(block.kind === 'quote' ? 'blockquote' : 'p')
    for (const inline of block.inlines) box.append(renderInline(inline, why))
    body.append(box)
  }
  parts.push(body, ...asksNote(rendered))

  if (rendered.isEnding) {
    parts.push(...endingBlock())
  } else if (rendered.result.choices.length > 0) {
    parts.push(...choiceList(rendered, why))
  } else {
    // Not an ending, and nothing leads on: an unwritten branch. Restart is
    // offered here too, or the reader would be stranded with no way out.
    // The footer still carries the trail, since the top row no longer does.
    parts.push(
      el('p', 'dead-end', 'Nothing leads on from here yet.'),
      ...passageFooter(null),
      restartBlock(),
    )
  }

  column.replaceChildren(...parts)
  drawConsole(rendered)
}

/**
 * Say what went wrong, in the page. Nothing on it can be chosen any more, so a
 * way out is offered wherever one exists: Restart, unless the passage that
 * failed is the one Restart would open.
 */
function fail(message: string, offerRestart: boolean): void {
  current = null
  keyed = []
  linkKeys = new Map()
  column.replaceChildren(el('p', 'reader-fail', message), ...(offerRestart ? [restartBlock()] : []))
}

/** Back to the top of the page, with focus at the start of the new passage. */
function settle(): void {
  window.scrollTo(0, 0)
  column.focus({ preventScroll: true })
}

/** `open`, with an evaluator exception read as the same failure as a bad blob. */
async function tryOpen(step: Step): Promise<Opened | null> {
  try {
    return await open(step)
  } catch {
    return null
  }
}

async function choose(ordinal: number, label: string): Promise<void> {
  if (busy || current === null || current.isEnding) return
  busy = true
  try {
    const key = linkKeys.get(ordinal) ?? null
    if (key === null) return
    const top = stack[stack.length - 1]!
    const setter = new Map(top.setterBefore)
    for (const written of current.result.assigned) setter.set(written.variable, top.code)
    // The variables this passage leaves behind become the next one's starting
    // state — the one thread that runs through a whole reading.
    const next: Step = {
      key,
      varsBefore: current.result.vars,
      setterBefore: setter,
      label,
      code: '',
      slug: '',
    }
    const opened = await tryOpen(next)
    if (opened === null) {
      fail(PASSAGE_FAILED, true)
    } else {
      stack.push(next)
      draw(opened)
    }
    settle()
  } finally {
    busy = false
  }
}

/** Empty the route, the choices taken and the trail, then open the first passage. */
async function restartStory(moveFocus: boolean): Promise<void> {
  const first: Step = {
    key: lookup.start,
    varsBefore: new Map(),
    setterBefore: new Map(),
    label: null,
    code: '',
    slug: '',
  }
  const opened = await tryOpen(first)
  stack.length = 0
  if (opened === null) {
    fail(START_FAILED, false)
    return
  }
  stack.push(first)
  draw(opened)
  if (moveFocus) settle()
}

// --- Keys and clicks -------------------------------------------------------

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !popover.hidden) {
    setPopover(false)
    textButton.focus()
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  // A held key repeats, and each repeat would take the first choice of the
  // passage it just opened. With no Back, that loses the reader's place.
  if (e.repeat) return
  if (isEditable(e.target)) return
  if (!/^[1-9]$/.test(e.key)) return
  const target = keyed[Number(e.key) - 1]
  if (target === undefined || target.disabled) return
  e.preventDefault()
  target.click()
}

function onClick(e: MouseEvent): void {
  if (popover.hidden) return
  const target = e.target as Node | null
  if (target !== null && (popover.contains(target) || textButton.contains(target))) return
  setPopover(false)
}

function readPayload(): Payload {
  const holder = document.getElementById(PAYLOAD_ID)
  if (holder === null) throw new Error('This file is missing its story.')
  return JSON.parse(decodeText(fromBase64(holder.textContent ?? ''))) as Payload
}

/**
 * Start the demo. Called by the inline bootstrap `html.ts` writes.
 *
 * Failures are reported in the page rather than the console: whoever opens a
 * published file is a reader, not a developer, and a blank page tells them
 * nothing about whether the story or their browser is at fault.
 *
 * Returns once the first passage is drawn, which the bootstrap ignores and the
 * tests wait on.
 */
export function start(mount: HTMLElement): Promise<void> {
  try {
    payload = readPayload()
    lookup = indexPayload(payload)
  } catch {
    mount.replaceChildren(el('p', 'reader-fail', 'This file is damaged and its story could not be read.'))
    return Promise.resolve()
  }
  if (!isPlayerTheme(payload.theme)) payload.theme = DEFAULT_THEME
  prefs = loadPrefs(payload.theme)
  buildShell(mount)
  applyPrefs()

  if (!listening) {
    document.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick)
    listening = true
  }

  // Asked up front, so a story that fails for its own reasons is never blamed
  // on the reader's browser, and a browser that cannot run it is named as such.
  if (!supported()) {
    fail(BROWSER_UNSUPPORTED, false)
    return Promise.resolve()
  }
  return restartStory(false).catch(() => fail(START_FAILED, false))
}

function supported(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof DecompressionStream === 'function'
  )
}
