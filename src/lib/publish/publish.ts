/**
 * Publishing, end to end: build the story's page, then write it to a file
 * (Publish) or open it in a tab (Play, and the theme previews).
 *
 * The only module that names `virtual:player-bundle`, and it reaches it through
 * a **dynamic** import. Both halves matter.
 *
 * Confining it here keeps the rest of `lib/publish/` pure: all the logic worth
 * testing lives in `payload.ts` and `html.ts`, which take the bundle as a
 * parameter, and this file is the thin wiring that has none. Importing it
 * *lazily* keeps the real player build off the path of every test that merely
 * touches the store: `vitest.config.ts` carries the plugin, so resolving the
 * specifier is cheap, but loading it runs a nested Vite build. Deferring that to
 * the moment someone publishes or plays means a test that does neither never
 * pays for it.
 *
 * It also earns its keep in the app: the player bundle is some 24 KB of string
 * that the editor only needs when the author publishes or plays, so a lazy
 * chunk keeps it out of the initial load.
 */

import type { StoryDoc } from '../../types/story'
import { downloadBlob, pickSaveFile } from '../doc/file'
import { assemble, publishFilename } from './html'
import { deriveGraph } from '../graph/derive'
import { buildPayload, partitionNodes, startOf, type Excluded, type PayloadOptions } from './payload'
import { SAMPLE_DOC } from './sample'
import type { PlayerTheme } from './themes'

const MIME = 'text/html'

/**
 * How often to check whether an opened tab has closed, so its page can be
 * released.
 *
 * The Blob URL is what a reload of that tab asks for, so it has to outlive the
 * page loading. It is released only once the tab is gone.
 */
const RELEASE_POLL_MS = 10_000

export interface PublishResult {
  /** False when the author cancelled the save dialog. */
  saved: boolean
  /** Bytes written, for the dialog to report. */
  size: number
  /** How many passages the file holds. */
  shipped: number
  /** What was left out, and why, so the author hears about it now. */
  excluded: Excluded[]
}

interface BuiltPage {
  html: string
  shipped: number
  excluded: Excluded[]
}

/** The browser refused to open a tab. The author has to allow pop-ups. */
export class PopupBlockedError extends Error {
  constructor() {
    super('The browser blocked the new tab. Allow pop-ups for this page to play the story.')
  }
}

/**
 * The complete page, as a string. Publish writes it to disk and Play opens it
 * in a tab. Both go through here, which is what makes Play show exactly what a
 * reader of the published file would see.
 */
export async function buildPage(doc: StoryDoc, options: PayloadOptions): Promise<BuiltPage> {
  const { playerJs } = await import('virtual:player-bundle')
  // Derived once and handed to both, rather than once per question.
  const graph = deriveGraph(doc)
  const { shipped, excluded } = partitionNodes(doc, startOf(doc, options.start), graph)
  const html = assemble(playerJs, await buildPayload(doc, options, graph))
  return { html, shipped: shipped.length, excluded }
}

/**
 * Build the published file and put it on disk.
 *
 * The picker is opened **first**, before any work. It needs transient
 * activation from the click, and encrypting a few hundred passages takes long
 * enough to outlive it — so building first would show a save dialog on a small
 * story and throw a `SecurityError` on a large one, which is the worst possible
 * way for this to fail.
 */
export async function publishStory(doc: StoryDoc, theme: PlayerTheme): Promise<PublishResult> {
  // Before the picker, which must itself come before any slow work. A story
  // with no passage to start from fails here, rather than after the author has
  // chosen a file and the browser has already created it empty.
  startOf(doc, undefined)
  const filename = publishFilename(doc.storyTitle)
  const target = await pickSaveFile(filename, 'Web page', MIME)
  if (target.kind === 'cancelled') return { saved: false, size: 0, shipped: 0, excluded: [] }

  const page = await buildPage(doc, { theme })
  const blob = new Blob([page.html], { type: MIME })
  const result = { saved: true, size: blob.size, shipped: page.shipped, excluded: page.excluded }

  if (target.kind === 'unsupported') {
    downloadBlob(filename, blob)
    return result
  }

  const stream = await target.handle.createWritable()
  await stream.write(blob)
  await stream.close()
  return result
}

/**
 * Build the page and show it in a new tab.
 *
 * The tab is opened **synchronously, before the first `await`**, for the same
 * reason `publishStory` opens its picker first: a popup blocker allows
 * `window.open` only while the click or key press that asked for it is still
 * being handled, and encrypting the story outlives that. So the tab opens
 * blank, and is sent to the finished page once it exists.
 *
 * The page arrives as a Blob URL rather than through `document.write`, so the
 * tab holds a real document that survives a reload. That URL is released when
 * the tab closes, not when it loads, because a reload asks for it again.
 */
export async function openInTab(doc: StoryDoc, options: PayloadOptions): Promise<void> {
  startOf(doc, options.start)
  const tab = window.open('', '_blank')
  if (tab === null) throw new PopupBlockedError()
  try {
    tab.document.title = 'Opening\u2026'
    tab.document.body.textContent = 'Opening the story\u2026'
  } catch {
    // Only a courtesy while the page builds. A browser that isolates the
    // blank tab keeps its own empty page, which is also fine.
  }

  let url: string
  try {
    url = URL.createObjectURL(new Blob([(await buildPage(doc, options)).html], { type: MIME }))
  } catch (e) {
    tab.close()
    throw e
  }
  tab.location.replace(url)
  tab.opener = null

  const release = setInterval(() => {
    if (!tab.closed) return
    clearInterval(release)
    URL.revokeObjectURL(url)
  }, RELEASE_POLL_MS)
}

/**
 * A short sample story in one theme, for the settings dialog's Preview.
 *
 * It goes through `openInTab` like Play does, so a preview is the real player
 * drawing a real payload rather than a picture of one. Marked as a preview, so
 * the player ignores the reader's saved theme: a preview of Marquee is Marquee,
 * whatever was last picked from an `Aa` popover.
 */
export function previewTheme(theme: PlayerTheme): Promise<void> {
  return openInTab(SAMPLE_DOC, { theme, preview: true })
}
