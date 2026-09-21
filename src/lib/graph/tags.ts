/**
 * The tag vocabulary, handed to the coverage engine.
 *
 * "Eleven passages are tagged `combat`" is a fact about the document. "Sixty
 * per cent of the routes a reader can take hit combat at least once" is a fact
 * about the story, and it is the one an author is actually asking.
 * `coverage.ts` answers the second, and its header is where the argument lives:
 * why the answer is a complement rather than a sum over tagged passages, which
 * of the sums beside it *are* legal, and which way the route model errs.
 *
 * What is left here is everything that is about tags rather than about routes —
 * the list of them, the ceiling on combining them, and what the buckets are
 * called. `characters.ts` is the same file with a different vocabulary.
 */

import type { StoryDoc, StoryNode } from '../../types/story'
import { compareStr } from '../../types/story'
import { combineCoverage, computeCoverage, coverageHits } from './coverage'
import type { Combination, CoverageAnalysis, Hits } from './coverage'
import type { LayoutResult } from './types'

/**
 * How many tags may be combined at once.
 *
 * Inclusion–exclusion costs one graph walk per subset, so each tag added
 * doubles the work: ten is a thousand walks and about a third of a second on a
 * large story, and eleven is twice that. The ceiling lives here rather than in
 * the panel because a cap enforced only by a disabled checkbox is a
 * coincidence, not a guarantee.
 */
export const MAX_COMBINED_TAGS = 10

/**
 * What the non-empty buckets are called, and — by being counted — how many
 * there are.
 *
 * The cap is read off the labels rather than declared beside them because the
 * two cannot be allowed to drift: a cap raised on its own leaves a bucket with
 * no row to print it in, and the saturating one keeps a name that has quietly
 * become a lie ("three or more" when it now means exactly three). One
 * description, the way `commands.ts` holds one description of a command; the
 * panel renders these and counts nothing itself.
 *
 * Three, because the question an author is asking is "once, twice, or a lot" —
 * past that the distinction stops changing what they would do about it, and an
 * uncapped histogram would be as long as the deepest route in the story. The
 * last label is not "exactly" anything, which is what makes it the saturating
 * bucket.
 *
 * They stay here rather than in `coverage.ts` because they are wording, not
 * arithmetic: a tag is collected, a character is met in a passage, and the two
 * do not read the same.
 */
export const TAG_HIT_LABELS = ['exactly once', 'exactly twice', 'three or more times'] as const

/** How many collections are counted apart before they are lumped together. */
export const TAG_HIT_CAP = TAG_HIT_LABELS.length

/** A passage's tags: the only thing the engine needs told. */
const TAG_KEYS = (n: StoryNode) => n.tags

/** Every tag the story knows about: in use, plus registered but not yet used. */
function allTagsOf(doc: StoryDoc): string[] {
  const set = new Set<string>()
  for (const n of doc.nodes) for (const t of n.tags) set.add(t)
  for (const t of doc.tagColors) set.add(t.name)
  return [...set].sort(compareStr)
}

/**
 * Every tag in the story, with the passages carrying it and the routes it
 * touches.
 *
 * Unused tags stay in the table at zero, the way `characterUsage` keeps a
 * roster member nobody has written yet: "I made this tag and never used it" is
 * a thing the author wants to see, not a row to hide.
 */
export function computeTagStats(doc: StoryDoc, layout: LayoutResult): CoverageAnalysis {
  return computeCoverage(doc, layout, allTagsOf(doc), TAG_KEYS)
}

/** How often the routes collect one tag: never, once, twice, or three or more. */
export function tagHits(doc: StoryDoc, layout: LayoutResult, tag: string): Hits {
  return coverageHits(doc, layout, tag, TAG_KEYS, TAG_HIT_CAP)
}

/** Routes that collect *all* of `tags`, and routes that collect none. */
export function combineTags(
  doc: StoryDoc,
  layout: LayoutResult,
  tags: readonly string[],
): Combination {
  return combineCoverage(doc, layout, tags, TAG_KEYS, MAX_COMBINED_TAGS)
}
