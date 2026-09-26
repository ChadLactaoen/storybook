import type { StoryDoc, StoryNode } from '../types/story'
import { compareByName, compareStr, emptyCharacter, emptyDoc } from '../types/story'

/**
 * Build a document from a compact adjacency spec: `{ One: ['Two', 'Three'] }`
 * creates a passage titled `One` whose body links to `Two` and `Three`.
 *
 * Spec keys are titles; each gets the code `P1`, `P2`, ... in declaration order
 * unless `opts.codes` names one, and bodies link by code. A target that is not
 * itself a spec key is written verbatim, so `{ A: ['Ghost'] }` yields a phantom
 * whose code is `Ghost`.
 *
 * `opts.casts` also seeds the roster, in order of first appearance: a scene
 * name that is not on `doc.characters` is off-invariant, and nothing built here
 * should start out breaking one. `opts.tags` seeds `doc.tagColors` for the same
 * reason — a tag no entry in the registry names is a tag `addTag` would never
 * have produced.
 */
export function docFrom(
  spec: Record<string, string[]>,
  opts: {
    start?: string
    offsets?: Record<string, number>
    settings?: Record<string, string>
    casts?: Record<string, string[]>
    codes?: Record<string, string>
    notes?: Record<string, string>
    slugs?: Record<string, string>
    tags?: Record<string, string[]>
    /** Titles to mark as endings. */
    endings?: string[]
    /** Titles to mark as snippets. Never chosen as the start by default. */
    snippets?: string[]
  } = {},
): StoryDoc {
  const doc = emptyDoc('Test Story')
  const titles = Object.keys(spec)
  const codeOf = new Map(titles.map((t, i) => [t, opts.codes?.[t] ?? `P${i + 1}`]))

  const roster: string[] = []
  for (const names of Object.values(opts.casts ?? {})) {
    for (const name of names) if (!roster.includes(name)) roster.push(name)
  }
  doc.characters = roster.map((name, i) => emptyCharacter(name, i))

  const registry: string[] = []
  for (const names of Object.values(opts.tags ?? {})) {
    for (const name of names) if (!registry.includes(name)) registry.push(name)
  }
  doc.tagColors = registry
    .map((name) => ({ name, color: 'none' as const }))
    .sort((a, b) => compareStr(a.name, b.name))

  const nodes: StoryNode[] = titles.map((title, i) => ({
    id: String(i + 1),
    title,
    body: spec[title]!.map((t) => `[[Go to ${t}|${codeOf.get(t) ?? t}]]`).join('\n'),
    // Sorted, the way both `addTag` and `serializeDoc` store them.
    tags: [...(opts.tags?.[title] ?? [])].sort(compareStr),
    state: 'TODO' as const,
    isEnding: opts.endings?.includes(title) ?? false,
    isSnippet: opts.snippets?.includes(title) ?? false,
    levelOffset: opts.offsets?.[title] ?? 0,
    setting: opts.settings?.[title] ?? '',
    code: codeOf.get(title)!,
    slug: opts.slugs?.[title] ?? '',
    note: opts.notes?.[title] ?? '',
    // Name order, matching how a node's cast is always stored.
    characters: (opts.casts?.[title] ?? [])
      .map((name) => ({ name, note: '' }))
      .sort(compareByName),
  }))

  doc.nodes = nodes
  doc.nextId = nodes.length + 1
  const startTitle = opts.start ?? titles.find((t) => !opts.snippets?.includes(t))
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

/**
 * Recursively freeze a document, so any mutation that writes in place throws.
 *
 * `Object.freeze` is shallow, and the aliasing bug this guards against is never
 * at the top level — it is a `tags` array or a relation list reached three
 * fields down. Vitest runs ESM, so strict mode turns a write to a frozen object
 * into a `TypeError` rather than the silent no-op it would be in sloppy mode,
 * which is the whole reason this is a usable check.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
  return value
}
