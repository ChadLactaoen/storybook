import type { StoryDoc } from '../../types/story'
import { layoutStory } from '../graph/layout'
import { parseDoc, serializeDoc } from './serialize'

/** How long a download's Blob URL outlives the click. FileSaver.js uses the same. */
const REVOKE_AFTER_MS = 40_000

/**
 * Hand a blob to the browser as a download.
 *
 * The one copy. There were three — this, the skeleton export, and very nearly a
 * third for publishing — and a download that works in two places and not the
 * third is the sort of drift nothing catches until someone reports it.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Not revoked in the same task as the click. Safari starts reading the Blob
  // after the click returns, and a URL revoked before it does cancels the
  // download while everything here reports success. This is the only path
  // Safari and Firefox have for Publish, since neither has a save picker.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
}


/**
 * What asking for a save location produced.
 *
 * The three cases are kept apart because they call for different things:
 * `picked` writes through the handle, `unsupported` falls back to a download,
 * and `cancelled` writes nothing at all. Collapsing the last two — which a
 * nullable handle would do — means dismissing the dialog still drops a file in
 * the author's Downloads folder, which is precisely what they just declined.
 */
export type SaveTarget =
  | { kind: 'picked'; handle: FileSystemFileHandle }
  | { kind: 'cancelled' }
  | { kind: 'unsupported' }

/**
 * Ask the author where to put a file.
 *
 * **Call this before doing any work.** `showSaveFilePicker` requires transient
 * activation, which expires a few seconds after the click that granted it — and
 * building a published story encrypts and compresses every passage. Picking
 * first and building second is the difference between a save dialog and a
 * silent `SecurityError` on a large story.
 *
 * Firefox and Safari have no picker at all, hence `unsupported`.
 */
export async function pickSaveFile(
  filename: string,
  description: string,
  mime: string,
): Promise<SaveTarget> {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>
    }
  ).showSaveFilePicker
  if (typeof picker !== 'function') return { kind: 'unsupported' }
  try {
    const handle = await picker({
      suggestedName: filename,
      types: [{ description, accept: { [mime]: [`.${filename.split('.').pop()}`] } }],
    })
    return { kind: 'picked', handle }
  } catch (e) {
    // The spec says AbortError for a dismissed dialog. Anything else means the
    // picker exists but would not run — a cross-origin iframe, say — and the
    // download path is a better answer than refusing outright.
    if (e instanceof DOMException && e.name === 'AbortError') return { kind: 'cancelled' }
    return { kind: 'unsupported' }
  }
}

export function exportDoc(doc: StoryDoc): void {
  const blob = new Blob([serializeDoc(doc)], { type: 'application/json' })
  downloadBlob(`${slug(doc.storyTitle)}.json`, blob)
}

/**
 * A story title as a filename stem: `My Story` → `my-story`. Shared by every
 * file the app writes, so an export and a publish of one story are named alike.
 */
export function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.length > 0 ? s : 'story'
}

export interface ImportResult {
  doc: StoryDoc
  warnings: string[]
}

/**
 * Import a save file, reconciling any legacy absolute `level` fields.
 *
 * An absolute level can't be validated without knowing the structural floor, so
 * we lay the story out once with no offsets, then clamp `level - minLevel` into
 * the legal range. Clamping (rather than rejecting) always yields a drawable
 * story; the author is told what moved.
 */
export function importDoc(json: string): ImportResult {
  const { doc, legacyLevels, warnings } = parseDoc(json)
  if (legacyLevels.size === 0) return { doc, warnings }

  const probe = layoutStory(doc)
  const notes = [...warnings]
  const nodes = doc.nodes.map((n) => {
    const requested = legacyLevels.get(n.id)
    // A snippet's level is 0 by definition; `parseDoc` records none for one, and
    // this says so again rather than trusting a floor it would read as 0.
    if (requested === undefined || n.isSnippet) return n
    const floor = probe.nodeById.get(n.id)?.minLevel ?? 1
    const offset = Math.min(1, Math.max(0, requested - floor))
    if (floor + offset !== requested) {
      notes.push(
        `"${n.title}" asked for level ${requested}; it can only sit at ${floor} or ${floor + 1}, so it was placed at ${floor + offset}.`,
      )
    }
    return { ...n, levelOffset: offset }
  })

  return { doc: { ...doc, nodes }, warnings: notes }
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Could not read that file.'))
    reader.readAsText(file)
  })
}
