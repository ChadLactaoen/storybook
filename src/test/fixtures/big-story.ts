import type { StoryDoc } from '../../types/story'
import { docFrom } from '../helpers'

/**
 * A story shaped like one an author actually writes, at the size where the
 * layout pipeline starts to cost something: 224 passages over 16 levels.
 *
 * The existing budget fixture (`workflow.test.ts`) is a complete binary tree,
 * and a tree is the one shape this is not useful for: its DFS preorder seed
 * yields zero crossings, so `orderComponent` returns at the early exit and the
 * ordering sweeps — the most expensive stage in the pipeline — never run at all.
 * Everything here exists to avoid that: siblings that re-merge, links that skip
 * a level or two, and a few that loop back.
 *
 * Seeded throughout, so the drawing is reproducible and a recorded hash means
 * something.
 */

export const BIG_LEVELS = 16
export const BIG_PER_LEVEL = 14
export const BIG_NODES = BIG_LEVELS * BIG_PER_LEVEL // 224

/** mulberry32, the same generator `shuffled` uses. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function title(level: number, index: number): string {
  return `L${level}N${index}`
}

/**
 * Deterministic prose, placed *before* the links on purpose: editing it shifts
 * every link span in the body, which is the case that proves a link signature
 * must not carry spans.
 */
function filler(seed: number, words: number): string {
  const rand = rng(seed)
  const vocab = [
    'the', 'lantern', 'guttered', 'and', 'somewhere', 'below', 'water', 'moved',
    'against', 'stone', 'she', 'counted', 'breaths', 'until', 'nothing', 'answered',
    'a', 'door', 'stood', 'open', 'on', 'darkness', 'warm', 'as', 'blood',
  ]
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(vocab[Math.floor(rand() * vocab.length)]!)
  return out.join(' ')
}

export interface BigStoryOptions {
  seed?: number
  /** Approximate words of prose per passage. ~160 gives ~200KB over 224 nodes. */
  words?: number
}

/**
 * Build the fixture. Returns a document whose codes are `P1`..`P224` in
 * `docFrom`'s declaration order, which is level-major.
 */
export function bigStory(opts: BigStoryOptions = {}): StoryDoc {
  const { seed = 20240917, words = 160 } = opts
  const rand = rng(seed)

  const spec: Record<string, string[]> = {}
  const order: string[] = []
  for (let level = 1; level <= BIG_LEVELS; level++) {
    for (let i = 0; i < BIG_PER_LEVEL; i++) order.push(title(level, i))
  }
  for (const t of order) spec[t] = []

  const codeOf = new Map<string, string>()
  order.forEach((t, i) => codeOf.set(t, `P${i + 1}`))

  for (let level = 1; level < BIG_LEVELS; level++) {
    for (let i = 0; i < BIG_PER_LEVEL; i++) {
      const from = title(level, i)
      const kids = new Set<string>()

      // 1-3 children on the next level, clustered near this node's index so the
      // graph stays locally coherent — but overlapping its neighbours' ranges,
      // which is what produces the re-merges a tree does not have.
      const n = 1 + Math.floor(rand() * 3)
      for (let k = 0; k < n; k++) {
        const drift = Math.floor(rand() * 5) - 2
        const j = ((i + drift) % BIG_PER_LEVEL + BIG_PER_LEVEL) % BIG_PER_LEVEL
        kids.add(title(level + 1, j))
      }

      // ~5% skip links, spanning 2-3 levels. These mint dummy chains, and the
      // dummies are what make the ordering sweeps expensive.
      if (rand() < 0.05) {
        const span = 2 + Math.floor(rand() * 2)
        const target = level + span
        if (target <= BIG_LEVELS) {
          kids.add(title(target, Math.floor(rand() * BIG_PER_LEVEL)))
        }
      }

      spec[from] = [...kids]
    }
  }

  // A few loops back into an earlier level: real stories have hubs.
  for (const [level, i, backTo] of [[6, 3, 2], [10, 7, 5], [14, 1, 9]] as const) {
    spec[title(level, i)] = [...spec[title(level, i)]!, title(backTo, 0)]
  }

  // Endings: the deepest level stops.
  const endings = Array.from({ length: BIG_PER_LEVEL }, (_, i) => title(BIG_LEVELS, i))

  const doc = docFrom(spec, { start: title(1, 0), endings })

  // Prose goes on afterwards rather than through `docFrom`, so the links keep
  // the exact text `docFrom` wrote and the filler sits ahead of them.
  return {
    ...doc,
    nodes: doc.nodes.map((n, i) => ({
      ...n,
      body: `${filler(seed + i, words)}\n\n${n.body}`,
    })),
  }
}
