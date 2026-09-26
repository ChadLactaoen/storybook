import type { StoryDoc, StoryNode } from '../../types/story'
import { DOC_VERSION } from '../../types/story'
import { parseLinks } from '../harlowe/links'
import { downloadBlob } from './file'

/**
 * A structure-only export: enough to reproduce a drawing, and nothing anybody
 * wrote.
 *
 * Reporting a layout complaint used to mean handing over the whole story. This
 * is the same complaint without the novel attached — and it is a *debugging*
 * format, not a save file: `parseDoc` cannot read one, and nothing in the app
 * imports one. It reaches the author only through the Developer menu, which is
 * itself behind a settings checkbox.
 *
 * What it writes is exactly what `layoutStory` reads and nothing else. Layout
 * is a pure function of the document, but of a narrow slice of it: the store's
 * memo key is id, code, title, `levelOffset`, `isSnippet`, `startNodeId`, and each body's
 * *link signature* — the ordered targets its `[[...]]` links name. Tags,
 * states, notes, characters, settings, endings and the prose itself move no
 * card, which is why none of them are here.
 *
 * So a skeleton redraws byte-identically to the story it came from, while
 * carrying no sentence anybody wrote.
 *
 * Three deliberate omissions past the obvious ones, all of them in
 * `layoutKey` and none of them in the drawing:
 *
 * - **Titles.** A card is `cfg.nodeWidth` wide whatever it says, so a title
 *   moves nothing. It is also the one field here that would be an author's
 *   writing rather than their structure, which is the point of the file. A
 *   passage is named by its code, which is its identity anyway.
 * - **Link labels.** A label names a phantom, so it reaches that dashed card's
 *   title and its wire's caption — text, again, and not geometry.
 * - **`isEnding`.** It terminates *routes*, which is a question for `paths.ts`;
 *   `layout.test.ts` asserts it moves nothing on the canvas.
 */

export interface SkeletonNode {
  id: string
  code: string
  /** Omitted when 0, which it is for nearly every passage. */
  levelOffset?: number
  /** Omitted when false. A snippet is drawn on its own row, so it moves cards. */
  isSnippet?: true
  /** Every `[[...]]` target in body order, duplicates and all. */
  links: string[]
}

export interface Skeleton {
  kind: 'storybook.skeleton.v1'
  startNodeId: string | null
  nodes: SkeletonNode[]
}

export function skeletonOf(doc: StoryDoc): Skeleton {
  return {
    kind: 'storybook.skeleton.v1',
    startNodeId: doc.startNodeId,
    nodes: doc.nodes.map((n) => {
      const out: SkeletonNode = {
        id: n.id,
        code: n.code,
        // Duplicates kept and order preserved: two links to one passage are two
        // edges that cross independently, and `deriveGraph` numbers edges by
        // their ordinal within the body.
        links: parseLinks(n.body).map((l) => l.target),
      }
      if (n.levelOffset !== 0) out.levelOffset = n.levelOffset
      if (n.isSnippet) out.isSnippet = true
      return out
    }),
  }
}

/** One line per passage, so a diff of two skeletons reads. */
export function serializeSkeleton(s: Skeleton): string {
  const rows = s.nodes.map((n) => `    ${JSON.stringify(n)}`).join(',\n')
  return `{\n  "kind": ${JSON.stringify(s.kind)},\n  "startNodeId": ${JSON.stringify(
    s.startNodeId,
  )},\n  "nodes": [\n${rows}\n  ]\n}\n`
}

export function exportSkeleton(doc: StoryDoc): void {
  const blob = new Blob([serializeSkeleton(skeletonOf(doc))], { type: 'application/json' })
  downloadBlob('skeleton.json', blob)
}

/**
 * Back the other way, so a test can draw the story a skeleton came from.
 *
 * Bodies are minted rather than carried: one `[[->code]]` per link, in the
 * order the skeleton lists them. `parseLinks` reads that back as the same
 * ordered targets, which is the whole of what layout took from the prose — so
 * the drawing this produces is the drawing the author saw, from a file with
 * none of their writing in it.
 *
 * The arrow form rather than a bare `[[code]]`, and that is the difference
 * between round-tripping and lying. A *resolved* target is a passage code, and
 * `setCode` bans link syntax from one — but a **dangling** target is whatever
 * the author typed, and dangling links are exactly what this file exists to
 * reproduce. `[[Onward->Chapter 2|draft]]` parses to the target
 * `Chapter 2|draft`, because the arrow is read before the bar; re-emitted bare
 * it would parse to `draft` instead, and the skeleton would redraw a different
 * phantom than the story has. `parseLinks` takes the arrow branch first and
 * reads everything after it as the target, so `[[->x]]` survives a `|` or a
 * `<-` in `x`. A target containing `->` itself has no Harlowe spelling that
 * round-trips at all, since the parse takes the *last* one — `dangling` names
 * that case rather than pretending to handle it.
 */
export function docFromSkeleton(s: Skeleton): StoryDoc {
  const nodes: StoryNode[] = s.nodes.map((n) => ({
    id: n.id,
    // The card's code, so the canvas reads the same names the skeleton does.
    title: n.code,
    code: n.code,
    slug: '',
    body: n.links.map((t) => `[[->${t}]]`).join('\n'),
    note: '',
    state: 'TODO',
    tags: [],
    setting: '',
    characters: [],
    levelOffset: n.levelOffset ?? 0,
    isEnding: false,
    isSnippet: n.isSnippet === true,
  }))
  return {
    version: DOC_VERSION,
    storyTitle: 'Skeleton',
    startNodeId: s.startNodeId,
    nodes,
    tagColors: [],
    characters: [],
    notes: '',
    // Past the largest id in use, not past the count: ids are `String(nextId)`
    // and deleting an early passage leaves the run sparse, so a story whose ids
    // are 3, 4, 5 would hand the next `addPassage` an id a live node already
    // holds. `parseDoc` guards the same way, and for the same reason.
    nextId: nodes.reduce((max, n) => Math.max(max, Number(n.id) || 0), 0) + 1,
  }
}

/**
 * Targets a skeleton cannot reproduce: ones containing `->`.
 *
 * Empty for every story anyone has written — a resolved target is a code, and
 * `setCode` refuses link syntax in one. It can only be a dangling link an
 * author typed, and it is reported rather than silently redrawn wrong.
 */
export function danglingTargetsWithArrows(s: Skeleton): string[] {
  const out = new Set<string>()
  for (const n of s.nodes) for (const t of n.links) if (t.includes('->')) out.add(t)
  return [...out].sort()
}
