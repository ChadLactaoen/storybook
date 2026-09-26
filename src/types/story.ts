/** Core document model. This is exactly what gets serialized to the save file. */

export type NodeId = string

export const NODE_STATES = ['TODO', 'Draft', 'Done'] as const
export type NodeState = (typeof NODE_STATES)[number]

/**
 * How a click on a card changes the selection: plain click replaces it,
 * Cmd/Ctrl takes the passage and everything downstream, Shift toggles one.
 */
export type SelectMode = 'replace' | 'subtree' | 'toggle'

export const TAG_COLORS = [
  'none',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
] as const
export type TagColor = (typeof TAG_COLORS)[number]

/** A cast member's appearance in one passage. */
export interface SceneCharacter {
  /** Always names an entry in `StoryDoc.characters`. */
  name: string
  /** Direction for this scene only: how they feel, their state, relations. */
  note: string
}

export interface StoryNode {
  id: NodeId
  /**
   * A name for the author, and nothing more.
   *
   * Free-form and repeatable: two passages may share a title, and nothing
   * structural ever reads one. Renaming is a plain field write.
   */
  title: string
  /**
   * The passage's identity: unique across the story, case-sensitive, never empty,
   * and the link target in `[[Text|code]]`.
   *
   * Terse enough to write in notes and stable enough for a reader to quote when
   * comparing which ending they got. Auto-assigned as `P<id>` at creation and the
   * author's to change — changing it cascades through every inbound link, which
   * is the mirror of what renaming a title used to do.
   */
  code: string
  /**
   * A mark for this passage in a shareable route code, at most 10 characters.
   * Empty when unused, which is most passages.
   *
   * On its own it means nothing. Its purpose is the *running slug* — the marks
   * of the passages on the route to here, concatenated: `A -> B -> D` spells
   * `ABD`. Where routes disagree the running slug says so with `*`, so adding
   * `A -> C -> D` makes D read `A*D`. See `lib/graph/slugs.ts`; the derivation
   * lives there and nothing about it is stored.
   *
   * **`*` is reserved and `normalizeSlug` strips it**, or an author could write
   * a literal that is indistinguishable from the ambiguity marker, and the
   * running slug would state something false about the story.
   *
   * **Parentheses group part of a mark**, and the parts are compared
   * separately: two siblings marked `A(a)` and `A(b)` agree on the stem and
   * differ in the group, so they read `A(*)` rather than a flat `*`. Everything
   * outside a group is one atomic mark — `Ab` and `Bb` are two different marks
   * that happen to share a letter, and nothing pretends otherwise. A mark whose
   * brackets do not balance is simply left opaque.
   *
   * **Not unique, deliberately.** A passage with no slug contributes nothing,
   * so `A -> B(none) -> C(none)` gives all three the running slug `A` — and
   * that is right, because a running slug identifies *the route so far*, not
   * the passage standing at the end of it. `code` remains the passage's
   * identity, exactly as it was; a reader quotes the pair — "on `P7`, route
   * `A*D`" — and the pair is exact. Do not add a uniqueness constraint or a
   * duplicate lint here; both would be answering a question this field is not
   * asking.
   *
   * A card shows the running slug only while it is still going somewhere. A
   * passage carrying no mark, with no descendant carrying one either, spells
   * exactly what its parent spelled and always will, so the canvas stops
   * repeating a finished code down a corridor. That is a display rule and
   * nothing more — the code itself is still there for the search box and the
   * inspector (`cardSlugs` against `runningSlugs`).
   *
   * Absent from `layoutKey`, `DerivedGraph` and `NodeLayout` for the reason
   * `isEnding` is: it moves nothing on the canvas.
   */
  slug: string
  /**
   * A note to yourself about this passage. Free text, empty when unused.
   *
   * Nothing structural reads one: notes may repeat, and no link, layout or
   * export resolves against them. They are searchable, and they sit on the
   * inspector's Advanced tab — that is the whole of it.
   */
  note: string
  /** Harlowe source. The single source of truth for this passage's outgoing links. */
  body: string
  tags: string[]
  state: NodeState
  /**
   * The author's claim that a route stops here.
   *
   * Never inferred. A passage with no outgoing links is indistinguishable from
   * one whose links are simply unwritten, so deriving this would flag most of a
   * draft as finished. The author says so, or it is not so.
   *
   * It is a claim about the *story*, not about progress — `state` is the latter.
   * `countPaths` honours it by treating the passage as a leaf even when links
   * still leave it, which is what makes the endings a partition of the routes
   * rather than an overlapping tally. Anything past a marked ending is
   * unreachable by construction, and `stats.ts` reports it as stranded.
   *
   * Deliberately absent from `layoutKey`, `DerivedGraph` and `NodeLayout`: it
   * moves nothing on the canvas. It reaches the card as a prop map and path
   * counting as an explicit argument.
   */
  isEnding: boolean
  /**
   * The author's claim that this passage is a *snippet*: prose that other
   * passages show inline with `(display: "CODE")`, standing outside the tree.
   *
   * Never inferred, for `isEnding`'s reason: a passage nothing links to is far
   * more often one whose inbound link is unwritten than one meant for display.
   *
   * A snippet sits on level 0, above the story, and is on no route. It cannot
   * link — a link inside one is not an edge, and a link *to* one leads nowhere
   * — so it is never the start, never an ending, and its `levelOffset` is
   * always 0 (`setSnippet` and `parseDoc` both hold that). Unlike `isEnding`
   * it *is* in `layoutKey` and `NodeLayout`, because it moves the card.
   */
  isSnippet: boolean
  /** 0 or 1. The only persisted layout input. */
  levelOffset: number
  /** Where this passage takes place. Empty when unset. */
  setting: string
  /**
   * This passage's cast, stored sorted by name.
   *
   * Name order is storage only — it is what keeps the save file byte-stable,
   * and a node cannot see the roster. On screen the cast goes through
   * `castInRosterOrder`, which is the author's arrangement.
   */
  characters: SceneCharacter[]
}

export interface TagColorEntry {
  name: string
  color: TagColor
}

/**
 * How one character regards another — strictly one-directional.
 *
 * Mira's relation to Tam says only how Mira treats him. What Tam makes of her
 * is a separate entry on Tam, and the two never merge.
 */
export interface CharacterRelation {
  /** Names another entry in `StoryDoc.characters`. Never the character itself. */
  to: string
  /** Key points, in the author's order. */
  points: string[]
}

/** The trait lists a character carries, beyond their prose description. */
export const TRAIT_FIELDS = ['personality', 'dialogue', 'mannerisms'] as const
export type TraitField = (typeof TRAIT_FIELDS)[number]

export const TRAIT_LABELS: Record<TraitField, string> = {
  personality: 'Personality',
  dialogue: 'Dialogue characteristics',
  mannerisms: 'Mannerisms',
}

/** A story-global cast member. */
export interface CharacterEntry {
  name: string
  /**
   * Position in the author's roster, 0-based and contiguous.
   *
   * The one field here that is not content: it exists because a cast has a
   * shape — leads first, walk-ons last — that alphabetical order destroys.
   * Every mutation that touches the roster renumbers it (see `orderRoster`),
   * so the canonical order is always `order`, with `name` as the tiebreak.
   */
  order: number
  /** Story-wide prose: who this character is. Distinct from the per-passage note. */
  note: string
  personality: string[]
  /** How they speak. */
  dialogue: string[]
  mannerisms: string[]
  relations: CharacterRelation[]
}

export function isTraitField(v: unknown): v is TraitField {
  return typeof v === 'string' && (TRAIT_FIELDS as readonly string[]).includes(v)
}

/**
 * The single construction site for a roster entry.
 *
 * Both `createCharacter` and the import repair build characters; routing them
 * through here is what stops the two from drifting apart as fields are added.
 */
export function emptyCharacter(name: string, order = 0): CharacterEntry {
  return { name, order, note: '', personality: [], dialogue: [], mannerisms: [], relations: [] }
}

export interface StoryDoc {
  version: 1
  storyTitle: string
  startNodeId: NodeId | null
  /** Serialized sorted by canonical key (code, then id). */
  nodes: StoryNode[]
  /** Story-global tag registry, sorted by name. */
  tagColors: TagColorEntry[]
  /**
   * Story-global cast roster, in the author's order (see `compareCharacters`).
   *
   * The only valid source of `SceneCharacter.name`. Holding that invariant is
   * what makes the cast counts meaningful, and it is why renaming a character
   * must cascade and why deleting one cannot simply drop the roster entry.
   */
  characters: CharacterEntry[]
  /**
   * A scratchpad for the story as a whole. Free text, empty when unused.
   *
   * Nothing structural reads it: no link, level or gate resolves against it,
   * and it is deliberately outside `searchableText` — a story-wide string would
   * match every passage at once, which is no filter at all.
   */
  notes: string
  /** Monotonic id counter. Deliberately not random UUIDs. */
  nextId: number
}

/**
 * What a running slug writes where the routes disagree, and therefore the one
 * character a slug may not contain.
 *
 * Lives here rather than in either of the two places that need it, because both
 * halves of the bargain have to name the same character: `normalizeSlug` strips
 * it on the way in, and `graph/slugs.ts` writes it on the way out. Two literals
 * could drift, and the drift would let an authored literal pass for the marker
 * — which is exactly the "states something false about the story" failure the
 * whole analysis is built to avoid.
 */
export const SLUG_AMBIGUOUS = '*'

export const DOC_VERSION = 1

export function isNodeState(v: unknown): v is NodeState {
  return typeof v === 'string' && (NODE_STATES as readonly string[]).includes(v)
}

export function isTagColor(v: unknown): v is TagColor {
  return typeof v === 'string' && (TAG_COLORS as readonly string[]).includes(v)
}

/**
 * Codepoint-order comparison. Never `localeCompare`, which varies with the
 * host's ICU version and would make layout non-deterministic across browsers.
 */
export function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Total order over nodes: code first, id as the tiebreak.
 *
 * Code rather than title because titles are cosmetic and repeatable. Ordering on
 * one would let a rename reshuffle `doc.nodes`, which reshuffles the derived
 * adjacency, which moves cards on a canvas for an edit that means nothing
 * structurally. The id tiebreak keeps the order total while `parseDoc` is
 * mid-repair and a code may still be missing or duplicated.
 */
export function compareNodes(a: StoryNode, b: StoryNode): number {
  return compareStr(a.code, b.code) || compareStr(a.id, b.id)
}

/**
 * Separator for `nodeLabel`. Deliberately not `|`, `->` or `<-`: those are link
 * syntax, and a label is often quoted back inside prose.
 */
const LABEL_SEP = ' \u00b7 '

/**
 * How a passage is named to the author: `"P7 · Head north"`.
 *
 * Every banner, list row, picker row and diagnostic goes through here. Titles
 * repeat, so a title alone no longer identifies a passage; the code always does.
 * Falls back to whichever half is present when the other is empty.
 */
export function nodeLabel(code: string, title: string): string {
  if (code.length === 0) return title
  if (title.length === 0) return code
  return code + LABEL_SEP + title
}

/** Total order over named entries: name, which is unique in both registries. */
export function compareByName(a: { name: string }, b: { name: string }): number {
  return compareStr(a.name, b.name)
}

/**
 * Total order over roster entries: the author's order, name as the tiebreak.
 *
 * The tiebreak is what keeps serialization byte-stable while a hand-edited file
 * still carries duplicate or missing `order` values.
 */
export function compareCharacters(a: CharacterEntry, b: CharacterEntry): number {
  return a.order - b.order || compareStr(a.name, b.name)
}

/**
 * The roster in canonical order, renumbered 0..n-1.
 *
 * Every roster mutation ends here, so `order` never drifts into gaps or
 * duplicates and array position always agrees with the field.
 */
export function orderRoster(characters: readonly CharacterEntry[]): CharacterEntry[] {
  return [...characters]
    .sort(compareCharacters)
    .map((c, i) => (c.order === i ? c : { ...c, order: i }))
}

/**
 * A passage's cast in the author's roster order.
 *
 * Storage stays alphabetical — `addPassageCharacter` sorts and `serializeDoc`
 * re-sorts — because that is what keeps the save file byte-stable, and a
 * `StoryNode` cannot see the roster anyway. Roster order is a view over it,
 * derived at render time, so one move in the roster reorders every passage's
 * cast at once without touching the document.
 */
export function castInRosterOrder(
  cast: readonly SceneCharacter[],
  roster: readonly CharacterEntry[],
): SceneCharacter[] {
  const rank = new Map(roster.map((c) => [c.name, c.order]))
  // Anyone off the roster shouldn't exist, but sorting them last on a name
  // tiebreak keeps the comparator total rather than trusting the invariant.
  const at = (name: string) => rank.get(name) ?? Number.MAX_SAFE_INTEGER
  return [...cast].sort((a, b) => at(a.name) - at(b.name) || compareStr(a.name, b.name))
}

/**
 * A tag list in the palette order the card's stripe already draws.
 *
 * Storage stays alphabetical — `addTag` sorts and `serializeDoc` re-sorts —
 * because that is what keeps the save file byte-stable, and a `StoryNode`
 * cannot see the colour registry anyway. Palette order is a view over it,
 * derived at render time, so one recolour reorders every passage's chips at
 * once without touching the document.
 *
 * It exists so the chips agree with the stripe above them. `stripes` in
 * `StoryNodeCard` walks `TAG_COLORS` rather than the tags, so red has always
 * sat left of purple on every card in the story; the chips underneath were
 * listing the same tags by name, which said a different thing about which tag
 * was which colour.
 *
 * `'none'` is `TAG_COLORS[0]`, so its index is the one that cannot be used:
 * an uncoloured tag earns no stripe, and sorting it first would put the tags
 * the stripe drops in front of the ones it draws. It ranks last instead, and a
 * tag missing from the map ranks with it — the `?? 'none'` every call site
 * already reads it as. The name tiebreak is what keeps the comparator total,
 * so this never leans on sort stability.
 */
export function tagsInPaletteOrder(
  tags: readonly string[],
  colors: ReadonlyMap<string, TagColor>,
): string[] {
  const at = (tag: string) => {
    const i = TAG_COLORS.indexOf(colors.get(tag) ?? 'none')
    return i <= 0 ? TAG_COLORS.length : i
  }
  return [...tags].sort((a, b) => at(a) - at(b) || compareStr(a, b))
}

export function emptyDoc(storyTitle = 'Untitled Story'): StoryDoc {
  return {
    version: DOC_VERSION,
    storyTitle,
    startNodeId: null,
    nodes: [],
    tagColors: [],
    characters: [],
    notes: '',
    nextId: 1,
  }
}
