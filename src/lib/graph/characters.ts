/**
 * The cast vocabulary, handed to the coverage engine.
 *
 * "Mira is in eleven passages" is a fact about the document, and the story
 * index already prints it. "Sixty per cent of the routes a reader can take meet
 * Mira at least once" is a fact about the *story*, and it is the one an author
 * asking whether a character is actually in their book wants. `coverage.ts`
 * answers the second; its header is where the argument lives, and it applies
 * here word for word — a route through three scenes with Mira in them meets her
 * three times, so the answer cannot be a sum over her passages.
 *
 * What is left here is everything that is about the cast rather than about
 * routes: who is in it, the ceiling on combining them, and what the buckets are
 * called. `tags.ts` is the same file with a different vocabulary.
 *
 * The one thing worth saying that `tags.ts` has no equivalent of: a route
 * "collecting" a character is a route that reaches a passage they are cast in.
 * That is presence on the page, not a speaking part — `SceneCharacter` records
 * a name and a scene note and nothing that would grade one appearance against
 * another, so neither does this.
 */

import type { StoryDoc, StoryNode } from '../../types/story'
import { compareStr, orderRoster } from '../../types/story'
import { combineCoverage, computeCoverage, coverageHits } from './coverage'
import type { Combination, CoverageAnalysis, Hits } from './coverage'
import type { LayoutResult } from './types'

/**
 * How many characters may be combined at once.
 *
 * The same cost model as `MAX_COMBINED_TAGS`, and the same argument for where
 * the number lives: inclusion–exclusion is one graph walk per subset, so each
 * character added doubles the work, and a cap enforced only by a disabled
 * checkbox is a coincidence rather than a guarantee. Its own constant rather
 * than a shared one because it is a tolerance, not a law — a story with forty
 * tags and six characters may well want different answers.
 */
export const MAX_COMBINED_CHARACTERS = 10

/**
 * What the non-empty buckets are called, and — by being counted — how many
 * there are.
 *
 * The cap is read off the labels for the reason `TAG_HIT_CAP` is: a cap raised
 * on its own leaves a bucket with no row to print it in, and the saturating one
 * keeps a name that has quietly become a lie.
 *
 * Worded in passages rather than in bare counts, because "exactly twice" says
 * nothing about what is being counted twice, and for a character the thing
 * being counted is scenes they are in. The last label is not "exactly"
 * anything, which is what makes it the saturating bucket.
 */
export const CAST_HIT_LABELS = [
  'in exactly one passage',
  'in exactly two passages',
  'in three or more passages',
] as const

/** How many appearances are counted apart before they are lumped together. */
export const CAST_HIT_CAP = CAST_HIT_LABELS.length

/** A passage's cast, by name: the only thing the engine needs told. */
const CAST_KEYS = (n: StoryNode) => n.characters.map((c) => c.name)

/**
 * Every character the story knows about: on the roster, plus anyone cast into a
 * passage without one.
 *
 * `StoryDoc.characters` is meant to be the only source of a `SceneCharacter`'s
 * name and every mutation holds that, so the second half normally finds
 * nothing. It is here because a hand-edited save file is not a mutation, and a
 * character dropped silently out of the table would be the one row the author
 * most needs to see.
 *
 * Roster order decides *which* names appear, not the order they appear in — the
 * engine sorts the rows busiest-first, because the question this panel is asked
 * is who carries the story rather than who the author listed first.
 */
function castNamesOf(doc: StoryDoc): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of orderRoster(doc.characters)) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c.name)
  }
  const strays: string[] = []
  for (const n of doc.nodes) {
    for (const c of n.characters) {
      if (seen.has(c.name)) continue
      seen.add(c.name)
      strays.push(c.name)
    }
  }
  // Canonical among themselves, since `doc.nodes` order is not a thing the
  // author arranged and an off-roster name has no `order` to read.
  return [...out, ...strays.sort(compareStr)]
}

/**
 * Every character in the story, with the passages they are cast in and the
 * routes that reach one.
 *
 * A roster member nobody has written yet stays in the table at zero, the
 * decision `characterUsage` already made: "I made this character and never
 * wrote them" is a thing the author wants to see, not a row to hide.
 */
export function computeCastStats(doc: StoryDoc, layout: LayoutResult): CoverageAnalysis {
  return computeCoverage(doc, layout, castNamesOf(doc), CAST_KEYS)
}

/** How many of a character's passages a route meets: none, one, two, or more. */
export function castHits(doc: StoryDoc, layout: LayoutResult, name: string): Hits {
  return coverageHits(doc, layout, name, CAST_KEYS, CAST_HIT_CAP)
}

/** Routes that meet *all* of `names`, and routes that meet none of them. */
export function combineCast(
  doc: StoryDoc,
  layout: LayoutResult,
  names: readonly string[],
): Combination {
  return combineCoverage(doc, layout, names, CAST_KEYS, MAX_COMBINED_CHARACTERS)
}
