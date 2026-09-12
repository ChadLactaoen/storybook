import type { StoryDoc, StoryNode } from '../types/story'
import { emptyDoc } from '../types/story'

/**
 * Build a document from a compact adjacency spec: `{ One: ['Two', 'Three'] }`
 * creates a passage titled `One` whose body links to `Two` and `Three`.
 *
 * Spec keys are titles; each gets the code `P1`, `P2`, ... in declaration order
 * unless `opts.codes` names one, and bodies link by code. A target that is not
 * itself a spec key is written verbatim, so `{ A: ['Ghost'] }` yields a phantom
 * whose code is `Ghost`.
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
  const codeOf = new Map(titles.map((t, i) => [t, opts.codes?.[t] ?? `P${i + 1}`]))

  const nodes: StoryNode[] = titles.map((title, i) => ({
    id: String(i + 1),
    title,
    body: spec[title]!.map((t) => `[[Go to ${t}|${codeOf.get(t) ?? t}]]`).join('\n'),
    tags: [],
    state: 'TODO' as const,
    levelOffset: opts.offsets?.[title] ?? 0,
    setting: opts.settings?.[title] ?? '',
    code: codeOf.get(title)!,
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

/**
 * Smallest edge-to-edge gap between two cards on the same level, across the
 * whole drawing. Measured edge to edge rather than centre to centre, which is
 * the only form that stays correct if cards ever differ in width.
 */
export function minCardGap(nodes: readonly { x: number; width: number; layer: number }[]): number {
  const byLayer = new Map<number, { x: number; width: number }[]>()
  for (const n of nodes) {
    const list = byLayer.get(n.layer) ?? []
    list.push(n)
    byLayer.set(n.layer, list)
  }
  let min = Infinity
  for (const list of byLayer.values()) {
    const sorted = [...list].sort((a, b) => a.x - b.x)
    for (let i = 0; i + 1 < sorted.length; i++) {
      const gap = sorted[i + 1]!.x - sorted[i + 1]!.width / 2 - (sorted[i]!.x + sorted[i]!.width / 2)
      if (gap < min) min = gap
    }
  }
  return min
}
