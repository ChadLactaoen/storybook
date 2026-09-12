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
  /** Unique across the story; doubles as the link target in `[[Text|title]]`. */
  title: string
  /**
   * Short author-assigned reference, unique across the story. Empty when unset.
   *
   * A handle on a passage that is not its title: terse enough to write in notes,
   * and stable enough for a reader to quote when comparing which ending they got.
   */
  code: string
  /** Harlowe source. The single source of truth for this passage's outgoing links. */
  body: string
  tags: string[]
  state: NodeState
  /** 0 or 1. The only persisted layout input. */
  levelOffset: number
  /** Where this passage takes place. Empty when unset. */
  setting: string
  /** This passage's cast, sorted by name. */
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
  /** Serialized sorted by canonical key (title, then id). */
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
  /** Monotonic id counter. Deliberately not random UUIDs. */
  nextId: number
}

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

/** Total order over nodes: title first, id as the unique tiebreak. */
export function compareNodes(a: StoryNode, b: StoryNode): number {
  return compareStr(a.title, b.title) || compareStr(a.id, b.id)
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

export function emptyDoc(storyTitle = 'Untitled Story'): StoryDoc {
  return {
    version: DOC_VERSION,
    storyTitle,
    startNodeId: null,
    nodes: [],
    tagColors: [],
    characters: [],
    nextId: 1,
  }
}
