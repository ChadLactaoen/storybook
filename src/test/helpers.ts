import type { StoryDoc, StoryNode } from '../types/story'
import { emptyDoc } from '../types/story'

/**
 * Build a document from a compact adjacency spec: `{ One: ['Two', 'Three'] }`
 * creates a passage titled `One` whose body links to `Two` and `Three`.
 */
export function docFrom(
  spec: Record<string, string[]>,
  opts: {
    start?: string
    offsets?: Record<string, number>
    settings?: Record<string, string>
    codes?: Record<string, string>
  } = {},
): StoryDoc {
  const doc = emptyDoc('Test Story')
  const titles = Object.keys(spec)

  const nodes: StoryNode[] = titles.map((title, i) => ({
    id: String(i + 1),
    title,
    body: spec[title]!.map((t) => `[[Go to ${t}|${t}]]`).join('\n'),
    tags: [],
    state: 'TODO' as const,
    levelOffset: opts.offsets?.[title] ?? 0,
    setting: opts.settings?.[title] ?? '',
    code: opts.codes?.[title] ?? '',
    characters: [],
  }))

  doc.nodes = nodes
  doc.nextId = nodes.length + 1
  const startTitle = opts.start ?? titles[0]
  doc.startNodeId = nodes.find((n) => n.title === startTitle)?.id ?? null
  return doc
}

/** Deterministic shuffle (mulberry32) — used to prove layout ignores array order. */
export function shuffled<T>(items: readonly T[], seed = 12345): T[] {
  let a = seed >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** Map of passage title -> assigned level, for readable assertions. */
export function levelsByTitle(
  doc: StoryDoc,
  level: ReadonlyMap<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const n of doc.nodes) {
    const lv = level.get(n.id)
    if (lv !== undefined) out[n.title] = lv
  }
  return out
}
