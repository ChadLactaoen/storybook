import type { StoryDoc } from '../../types/story'
import { layoutStory } from '../graph/layout'
import { parseDoc, serializeDoc } from './serialize'

export function exportDoc(doc: StoryDoc): void {
  const blob = new Blob([serializeDoc(doc)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug(doc.storyTitle)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function slug(title: string): string {
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
    if (requested === undefined) return n
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
