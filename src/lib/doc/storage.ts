import type { StoryDoc } from '../../types/story'
import { parseDoc, serializeDoc } from './serialize'

const KEY = 'storybook.story.v1'
const META_KEY = 'storybook.meta.v1'

export interface SavedMeta {
  savedAt: number
  storyTitle: string
  nodeCount: number
}

export function saveLocal(doc: StoryDoc): SavedMeta | null {
  try {
    localStorage.setItem(KEY, serializeDoc(doc))
    const meta: SavedMeta = {
      savedAt: Date.now(),
      storyTitle: doc.storyTitle,
      nodeCount: doc.nodes.length,
    }
    localStorage.setItem(META_KEY, JSON.stringify(meta))
    return meta
  } catch {
    // Private browsing, or a quota that a very large story blew through.
    return null
  }
}

export function loadLocal(): StoryDoc | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    return parseDoc(raw).doc
  } catch {
    return null
  }
}

export function localMeta(): SavedMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SavedMeta
    return typeof parsed?.savedAt === 'number' ? parsed : null
  } catch {
    return null
  }
}

export function clearLocal(): void {
  try {
    localStorage.removeItem(KEY)
    localStorage.removeItem(META_KEY)
  } catch {
    /* nothing to clear */
  }
}
