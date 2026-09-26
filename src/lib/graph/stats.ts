/**
 * What the story adds up to.
 *
 * A fourth analysis the Sugiyama pipeline never calls, alongside `paths.ts`,
 * `gates.ts` and `recode.ts`: nothing here moves a card, and every number is
 * wanted only when the author asks for it. It reads the graph `layoutStory`
 * already derived plus the document itself, because half of what it reports
 * (prose, states, endings) lives in the document and never reaches the graph.
 *
 * Every route count is `bigint` for the reason `paths.ts` gives — the count is
 * exponential in the number of choices. Percentages are taken in BigInt and
 * only then narrowed, so a story with more routes than a double can hold still
 * reports honest shares.
 */

import type { NodeId, NodeState, StoryDoc } from '../../types/story'
import { compareNodes, compareStr } from '../../types/story'
import { DISPLAY_BUDGET, DISPLAY_DEPTH, displayReach, parseDisplays } from '../harlowe/macros'
import { displayedSnippet } from './derive'
import { authoredOut as outDegree, countPaths, countPathsToAll, forwardTargets, share } from './paths'
import { reachableFrom } from './reachability'
import type { LayoutResult } from './types'

/** Words a reader gets through in a minute, for the reading-time estimate. */
const WORDS_PER_MINUTE = 200

export interface EndingRow {
  id: NodeId
  title: string
  code: string
  routes: bigint
  /** Share of all routes, 0..100, already narrowed from the BigInt division. */
  percent: number
}

export interface LintEntry {
  id: NodeId
  title: string
  code: string
  /** Extra context for the row — a link count, say. Empty when there is none. */
  detail: string
}

export interface StoryStats {
  /** Routes from the start to any terminal. `0n` when there is no start passage. */
  totalRoutes: bigint

  words: {
    total: number
    passages: number
    meanPerPassage: number
  }

  endings: {
    rows: EndingRow[]
    /**
     * Routes that stop at a dead end nobody marked. Zero exactly when every
     * terminal is accounted for, which is when `rows` sums to 100%.
     */
    unmarkedRoutes: bigint
    unmarkedPercent: number
  }

  lint: {
    brokenLinks: LintEntry[]
    unreachable: LintEntry[]
    strandedBehindEnding: LintEntry[]
    unmarkedDeadEnds: LintEntry[]
    endingsWithLinks: LintEntry[]
    /** Links written inside a snippet, or from a story passage to one. Neither leads anywhere. */
    snippetLinks: LintEntry[]
    /** `(display:)` calls the reader cannot show: unreadable, or naming no snippet. */
    brokenDisplays: LintEntry[]
  }

  completion: {
    /** Per state: how many passages, and how many words those passages hold. */
    byState: { state: NodeState; passages: number; words: number }[]
    passagePercentDone: number
    wordPercentDone: number
  }

  shape: {
    /** Story passages only: a snippet is on no route and has no shape to report. */
    passages: number
    snippets: number
    phantoms: number
    depth: number
    choicePoints: number
    meanBranching: number
    shortestRoutePassages: number
    longestRoutePassages: number
  }

  playthrough: {
    meanWords: number
    shortestWords: number
    longestWords: number
    meanMinutes: number
  }
}

/**
 * A simple whitespace word count, deliberately.
 *
 * The body is Harlowe source, so `[[Go north|P7]]` counts as two tokens and a
 * macro counts as however many it looks like. Stripping the syntax would mean
 * a second parser living next to `links.ts` and `macros.ts` and drifting from
 * both; the number is a writing-progress gauge, not a typesetting figure, and
 * the panel says so.
 */
export function wordCount(body: string): number {
  const t = body.trim()
  return t.length === 0 ? 0 : t.split(/\s+/).length
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 1000) / 10
}

export function computeStoryStats(doc: StoryDoc, layout: LayoutResult): StoryStats {
  const { graph, backEdges } = layout
  const startId = doc.startNodeId

  const endings = new Set<NodeId>()
  for (const n of doc.nodes) if (n.isEnding) endings.add(n.id)

  const words = new Map<NodeId, number>()
  for (const n of doc.nodes) words.set(n.id, wordCount(n.body))

  // Forward and reverse counts for every real passage, computed once and
  // reused by the endings table, the lint and the playthrough mean.
  //
  // Story passages only. A snippet is not in the graph, and `countPaths` would
  // read its missing out-edges as a leaf and report one route from it.
  const story = doc.nodes.filter((n) => !n.isSnippet)
  const from = new Map<NodeId, bigint>()
  for (const n of story) from.set(n.id, countPaths(graph, backEdges, n.id, endings))
  // One pass for the reverse direction, rather than a walk per passage.
  const to = countPathsToAll(graph, backEdges, startId, endings)
  const totalRoutes = startId === null ? 0n : (from.get(startId) ?? 0n)

  /** The route model's view: no self-loops, no back edges, nothing past an ending. */
  const forwardOut = (id: NodeId): NodeId[] => forwardTargets(graph, backEdges, id, endings)

  /**
   * Links the author actually wrote, which is a different question.
   *
   * Every out-edge counts here — a back edge included, since `Cave -> Hub` is a
   * link the reader really follows, and a link to a code no passage has, since
   * the author still wrote it. The route model drops both, and reading a lint
   * or a link count off it states something false about the prose.
   */
  const authoredOut = (id: NodeId): number => outDegree(graph, id)

  // The document as a fallback: a snippet is in no graph list, and a lint row
  // naming one still needs its title and code.
  const nodeOf = new Map(doc.nodes.map((n) => [n.id, n]))
  const titleOf = (id: NodeId) => graph.titleOf.get(id) ?? nodeOf.get(id)?.title ?? ''
  const codeOf = (id: NodeId) => graph.codeOf.get(id) ?? nodeOf.get(id)?.code ?? ''
  const entry = (id: NodeId, detail = ''): LintEntry => ({
    id,
    title: titleOf(id),
    code: codeOf(id),
    detail,
  })

  /* ---------- endings ---------- */

  const rows: EndingRow[] = doc.nodes
    .filter((n) => n.isEnding)
    .map((n) => {
      const routes = to.get(n.id) ?? 0n
      return {
        id: n.id,
        title: n.title,
        code: n.code,
        routes,
        percent: share(routes, totalRoutes),
      }
    })
    // Busiest first; title then code as tiebreaks, so the order is total and
    // never leans on sort stability — the same rule layout lives by.
    .sort(
      (a, b) =>
        (a.routes === b.routes ? 0 : a.routes > b.routes ? -1 : 1) ||
        compareStr(a.title, b.title) ||
        compareStr(a.code, b.code),
    )

  const markedRoutes = rows.reduce((sum, r) => sum + r.routes, 0n)
  const unmarkedRoutes = totalRoutes - markedRoutes

  /* ---------- lint ---------- */

  const brokenLinks: LintEntry[] = graph.phantoms.map((p) =>
    entry(p.id, plural((graph.inAdj.get(p.id) ?? []).length, 'link')),
  )

  const reachable = startId === null ? new Set<NodeId>() : reachableFrom(graph, startId)

  const unreachable: LintEntry[] = []
  const strandedBehindEnding: LintEntry[] = []
  const unmarkedDeadEnds: LintEntry[] = []
  const endingsWithLinks: LintEntry[] = []

  // Snippets are skipped outright. One is unreachable, linkless and on no route
  // by design, so every one of these would accuse it of being what it is for.
  for (const n of story) {
    // True reachability, not `to > 0n`: a passage you can only get to by going
    // round a loop is reachable, and accusing it would be a lie.
    if (!reachable.has(n.id)) {
      unreachable.push(entry(n.id))
    } else if ((to.get(n.id) ?? 0n) === 0n && n.id !== startId) {
      // Reachable by links, yet no route arrives — the reader is stopped by an
      // ending before they ever get here. This is the cost of the terminating
      // rule, so the tool has to name it.
      strandedBehindEnding.push(entry(n.id))
    }

    if (n.isEnding) {
      // Without `endings`, so the passage's own mark does not hide the links
      // the warning is about.
      const leaving = forwardTargets(graph, backEdges, n.id)
      if (leaving.length > 0) endingsWithLinks.push(entry(n.id, plural(leaving.length, 'link')))
    } else if (authoredOut(n.id) === 0) {
      // Authored links, not route edges. A passage whose one link goes back to
      // a hub is the commonest shape in the form; calling it an unwritten
      // branch is a false accusation, and the only fix offered — mark it as an
      // Ending — would be a lie.
      unmarkedDeadEnds.push(entry(n.id))
    }
  }

  // One row per offending passage, in canonical order — `snippetLinks` is
  // already in it, since `deriveGraph` walks the passages that way.
  const snippetLinks: LintEntry[] = []
  {
    const bySource = new Map<NodeId, { kind: 'in' | 'to'; targets: string[] }>()
    for (const l of graph.snippetLinks) {
      const row = bySource.get(l.sourceId) ?? { kind: l.kind, targets: [] }
      row.targets.push(l.targetCode)
      bySource.set(l.sourceId, row)
    }
    for (const [id, row] of bySource) {
      snippetLinks.push(
        entry(
          id,
          row.kind === 'in'
            ? `${plural(row.targets.length, 'link')} inside`
            : `links to snippet ${[...new Set(row.targets)].join(', ')}`,
        ),
      )
    }
  }

  // Every body, snippets included: a snippet may display another.
  //
  // Everything `runDisplay` refuses, not only a code that names no snippet: a
  // loop, a nest too deep and a render with too many displays all reach the
  // reader as the same unread marker, so a lint that passed them would say a
  // display works that the reader will not show.
  const brokenDisplays: LintEntry[] = []
  {
    const resolve = (code: string): string | null => {
      const id = displayedSnippet(graph, code)
      return id === null ? null : (nodeOf.get(id)?.body ?? null)
    }
    const reach = displayReach(resolve)
    for (const n of [...doc.nodes].sort(compareNodes)) {
      const problems: string[] = []
      const note = (problem: string) => {
        if (!problems.includes(problem)) problems.push(problem)
      }
      for (const d of parseDisplays(n.body)) {
        if (d.code === null) note('not a quoted code')
        else if (!graph.idByCode.has(d.code)) note(`no passage "${d.code}"`)
        else if (displayedSnippet(graph, d.code) === null) note(`"${d.code}" is not a snippet`)
      }
      const r = reach(n.body)
      if (r.cycle) note('a display loops back on itself')
      else if (r.depth > DISPLAY_DEPTH) note(`displays nest more than ${DISPLAY_DEPTH} deep`)
      else if (r.count > DISPLAY_BUDGET) note(`more than ${DISPLAY_BUDGET} displays`)
      if (problems.length > 0) brokenDisplays.push(entry(n.id, problems.join('; ')))
    }
  }

  /* ---------- completion ---------- */

  const states: NodeState[] = ['TODO', 'Draft', 'Done']
  const byState = states.map((st) => {
    const ns = doc.nodes.filter((n) => n.state === st)
    return {
      state: st,
      passages: ns.length,
      words: ns.reduce((sum, n) => sum + (words.get(n.id) ?? 0), 0),
    }
  })
  const totalWords = byState.reduce((sum, b) => sum + b.words, 0)
  const done = byState.find((b) => b.state === 'Done')!

  /* ---------- shape ---------- */

  // Authored links again: these two are reported as "how many links did I
  // write", so they must not drop a back edge, and must not move when a box is
  // ticked. Off the route model, three passages round a loop read as 0.7 links
  // each, and marking an ending changed the branching of passages it never
  // touched.
  let choicePoints = 0
  let outTotal = 0
  for (const n of story) {
    const k = authoredOut(n.id)
    outTotal += k
    if (k >= 2) choicePoints += 1
  }

  const passageHops = routeExtremes(startId, forwardOut, () => 1)
  const wordHops = routeExtremes(startId, forwardOut, (id) => words.get(id) ?? 0)

  /* ---------- playthrough ---------- */

  // Words as written, not as read: a displayed snippet's prose is counted once,
  // where it is written, and never on the routes that show it — a snippet has
  // `to(n) === 0n`. Crediting it to every host would make the number depend on
  // where a paragraph happens to live rather than on what was written.
  //
  // Exact rather than sampled. A node sits on `to(n) * from(n)` routes, so
  // summing `words(n)` over that product totals the words across every route
  // without enumerating any of them. A node stranded past an ending has
  // `to(n) === 0n` and correctly contributes nothing.
  let wordsAcrossRoutes = 0n
  for (const n of doc.nodes) {
    const through = (to.get(n.id) ?? 0n) * (from.get(n.id) ?? 0n)
    if (through > 0n) wordsAcrossRoutes += BigInt(words.get(n.id) ?? 0) * through
  }
  const meanWords = totalRoutes > 0n ? Number(wordsAcrossRoutes / totalRoutes) : 0

  return {
    totalRoutes,
    words: {
      total: totalWords,
      passages: doc.nodes.length,
      meanPerPassage: doc.nodes.length === 0 ? 0 : Math.round(totalWords / doc.nodes.length),
    },
    endings: {
      rows,
      unmarkedRoutes,
      unmarkedPercent: share(unmarkedRoutes, totalRoutes),
    },
    lint: {
      brokenLinks,
      unreachable,
      strandedBehindEnding,
      unmarkedDeadEnds,
      endingsWithLinks,
      snippetLinks,
      brokenDisplays,
    },
    completion: {
      byState,
      passagePercentDone: pct(done.passages, doc.nodes.length),
      wordPercentDone: pct(done.words, totalWords),
    },
    shape: {
      passages: story.length,
      snippets: doc.nodes.length - story.length,
      phantoms: graph.phantoms.length,
      // The story's layers, not `layout.levels`: that list carries a level-0
      // band while snippets exist, and a snippet makes no story deeper.
      depth: layout.stats.layers,
      choicePoints,
      meanBranching: story.length === 0 ? 0 : Math.round((outTotal / story.length) * 10) / 10,
      shortestRoutePassages: passageHops.min,
      longestRoutePassages: passageHops.max,
    },
    playthrough: {
      meanWords,
      shortestWords: wordHops.min,
      longestWords: wordHops.max,
      meanMinutes: Math.max(1, Math.round(meanWords / WORDS_PER_MINUTE)),
    },
  }
}

/**
 * Cheapest and dearest route from the start to any terminal, under `weight`.
 *
 * A plain memoized walk over the same forward edges the counts use, so it sees
 * exactly the routes they count. `seen` guards the recursion rather than the
 * graph's acyclicity: back edges are already filtered out by `forwardOut`, and
 * a node reached twice down different branches must reuse its answer, not
 * recompute it.
 */
function routeExtremes(
  startId: NodeId | null,
  forwardOut: (id: NodeId) => NodeId[],
  weight: (id: NodeId) => number,
): { min: number; max: number } {
  if (startId === null) return { min: 0, max: 0 }
  const memo = new Map<NodeId, { min: number; max: number }>()
  const seen = new Set<NodeId>()

  const walk = (id: NodeId): { min: number; max: number } => {
    const cached = memo.get(id)
    if (cached) return cached
    if (seen.has(id)) return { min: 0, max: 0 }
    seen.add(id)

    const w = weight(id)
    const kids = forwardOut(id)
    let result: { min: number; max: number }
    if (kids.length === 0) {
      result = { min: w, max: w }
    } else {
      let lo = Infinity
      let hi = -Infinity
      for (const k of kids) {
        const r = walk(k)
        lo = Math.min(lo, r.min)
        hi = Math.max(hi, r.max)
      }
      result = { min: w + lo, max: w + hi }
    }

    seen.delete(id)
    memo.set(id, result)
    return result
  }

  return walk(startId)
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
