import type {
  CharacterEntry,
  NodeId,
  NodeState,
  SceneCharacter,
  StoryDoc,
  StoryNode,
  TagColor,
  TraitField,
} from '../../types/story'
import {
  compareByName,
  compareStr,
  emptyCharacter,
  orderRoster,
} from '../../types/story'
import { parseLinks, retargetLinks } from '../harlowe/links'

/**
 * Every mutation returns a fresh document. Nothing here reads layout, and
 * layout never writes back, so the document stays the single source of truth.
 */

/**
 * Deep enough that no mutation can reach into a previous document.
 *
 * Every array- or object-valued field has to be copied here. Miss one and it
 * aliases across undo-history entries, so editing the present would silently
 * rewrite the past — a bug that only shows up as a broken undo much later.
 */
function clone(doc: StoryDoc): StoryDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => ({
      ...n,
      tags: [...n.tags],
      characters: n.characters.map((c) => ({ ...c })),
    })),
    tagColors: doc.tagColors.map((t) => ({ ...t })),
    characters: doc.characters.map((c) => ({
      ...c,
      personality: [...c.personality],
      dialogue: [...c.dialogue],
      mannerisms: [...c.mannerisms],
      relations: c.relations.map((r) => ({ ...r, points: [...r.points] })),
    })),
  }
}

function replaceNode(doc: StoryDoc, id: string, patch: Partial<StoryNode>): StoryDoc {
  const next = clone(doc)
  const i = next.nodes.findIndex((n) => n.id === id)
  if (i === -1) return doc
  next.nodes[i] = { ...next.nodes[i]!, ...patch }
  return next
}

export function uniqueTitle(doc: StoryDoc, base: string, exceptId?: string): string {
  const taken = new Set(doc.nodes.filter((n) => n.id !== exceptId).map((n) => n.title))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

export function createNode(
  doc: StoryDoc,
  opts: { title?: string; body?: string; setting?: string } = {},
): { doc: StoryDoc; node: StoryNode } {
  const next = clone(doc)
  const node: StoryNode = {
    id: String(next.nextId),
    title: uniqueTitle(next, opts.title?.trim() || 'Untitled Passage'),
    body: opts.body ?? '',
    tags: [],
    state: 'TODO',
    levelOffset: 0,
    setting: opts.setting?.trim() ?? '',
    code: '',
    characters: [],
  }
  next.nextId += 1
  next.nodes.push(node)
  if (next.startNodeId === null) next.startNodeId = node.id
  return { doc: next, node }
}

export function deleteNode(doc: StoryDoc, id: string): StoryDoc {
  const next = clone(doc)
  next.nodes = next.nodes.filter((n) => n.id !== id)
  // Inbound [[...]] markup is deliberately left alone: the author wrote that
  // prose, and a delete is not a statement about what the text should say. The
  // dangling links surface as phantom cards instead.
  if (next.startNodeId === id) next.startNodeId = next.nodes[0]?.id ?? null
  return next
}

/** Sequences that change how a `[[...]]` link is parsed. */
const LINK_SYNTAX = ['->', '<-', '|', '[[', ']]'] as const

export interface RenameResult {
  doc: StoryDoc
  error: string | null
}

/**
 * Rename a passage, retargeting every inbound link.
 *
 * This is the mirror image of the delete rule, and deliberately so: a rename is
 * intent-preserving — the author wants those links to keep working — whereas a
 * delete is not. Only the target half of each `[[...]]` is rewritten; display
 * text and surrounding prose are untouched.
 *
 * Validated before it commits, so the document never holds duplicate titles and
 * the derive step can assume uniqueness.
 */
export function renameNode(doc: StoryDoc, id: string, rawTitle: string): RenameResult {
  const node = doc.nodes.find((n) => n.id === id)
  if (!node) return { doc, error: 'That passage no longer exists.' }

  const title = rawTitle.trim()
  if (title.length === 0) return { doc, error: 'A passage needs a title.' }
  if (title === node.title) return { doc, error: null }

  // The title is spliced into every inbound `[[...]]`, so link punctuation in
  // it would silently re-point those links somewhere else. `[[Go|North]]`
  // renamed to `North->South` parses back out as a link to "South".
  const offending = LINK_SYNTAX.find((token) => title.includes(token))
  if (offending) {
    return {
      doc,
      error: `A title cannot contain "${offending}" — it is link syntax, and would break the links pointing here.`,
    }
  }

  const clash = doc.nodes.find((n) => n.id !== id && n.title === title)
  if (clash) return { doc, error: `A passage named "${title}" already exists.` }

  const next = clone(doc)
  for (const n of next.nodes) {
    if (n.id === id) n.title = title
    else n.body = retargetLinks(n.body, node.title, title)
  }
  return { doc: next, error: null }
}

/**
 * Apply a body edit, creating any passage the author just linked to.
 *
 * Auto-creation lives here rather than in the derive step on purpose: if
 * deriving created nodes, deleting a still-linked passage would resurrect it on
 * the very next re-derive. Creating only in response to an actual edit means a
 * deleted passage stays deleted and shows up as a phantom.
 */
export function setBody(doc: StoryDoc, id: string, body: string): StoryDoc {
  const before = doc.nodes.find((n) => n.id === id)
  if (!before) return doc

  const known = new Set(doc.nodes.map((n) => n.title))
  const previous = new Set(parseLinks(before.body).map((l) => l.target))

  let next = replaceNode(doc, id, { body })
  for (const link of parseLinks(body)) {
    if (known.has(link.target) || previous.has(link.target)) continue
    known.add(link.target)
    // A passage written from here starts in the same place, until told otherwise.
    next = createNode(next, { title: link.target, setting: before.setting }).doc
  }
  return next
}

/**
 * The setting a newly created passage should start with, given the passages
 * that link to it.
 *
 * Inherits only when every parent agrees. A phantom can be linked from several
 * passages set in different places, and picking one arbitrarily would plant
 * wrong metadata silently — ambiguity means don't guess.
 */
export function inheritedSetting(doc: StoryDoc, title: string): string {
  let agreed: string | null = null
  for (const n of doc.nodes) {
    if (!parseLinks(n.body).some((l) => l.target === title)) continue
    if (agreed === null) agreed = n.setting
    else if (agreed !== n.setting) return ''
  }
  return agreed ?? ''
}

/** Turn a phantom (a link with no passage behind it) into a real passage. */
export function materializePhantom(doc: StoryDoc, title: string): StoryDoc {
  if (doc.nodes.some((n) => n.title === title)) return doc
  return createNode(doc, { title, setting: inheritedSetting(doc, title) }).doc
}

export function setState(doc: StoryDoc, id: string, state: NodeState): StoryDoc {
  return replaceNode(doc, id, { state })
}

export function setLevelOffset(doc: StoryDoc, id: string, offset: number): StoryDoc {
  return replaceNode(doc, id, { levelOffset: Math.min(1, Math.max(0, Math.trunc(offset))) })
}

export function setStartNode(doc: StoryDoc, id: string): StoryDoc {
  if (!doc.nodes.some((n) => n.id === id) || doc.startNodeId === id) return doc
  return { ...clone(doc), startNodeId: id }
}

export function setStoryTitle(doc: StoryDoc, title: string): StoryDoc {
  const next = title.trim() || 'Untitled Story'
  // Returning a fresh document for an unchanged title would push an empty
  // entry onto the undo stack and wipe the redo stack.
  if (next === doc.storyTitle) return doc
  return { ...clone(doc), storyTitle: next }
}

/* ---------- tags ---------- */

export function addTag(doc: StoryDoc, id: string, rawTag: string): StoryDoc {
  const tag = rawTag.trim()
  if (tag.length === 0) return doc
  const node = doc.nodes.find((n) => n.id === id)
  if (!node || node.tags.includes(tag)) return doc

  let next = replaceNode(doc, id, { tags: [...node.tags, tag].sort(compareStr) })
  // Tags are story-global, so a brand new one joins the registry immediately
  // and becomes offerable on every other passage.
  if (!next.tagColors.some((t) => t.name === tag)) {
    next = {
      ...next,
      tagColors: [...next.tagColors, { name: tag, color: 'none' as TagColor }].sort((a, b) =>
        compareStr(a.name, b.name),
      ),
    }
  }
  return next
}

export function removeTag(doc: StoryDoc, id: string, tag: string): StoryDoc {
  const node = doc.nodes.find((n) => n.id === id)
  if (!node) return doc
  return replaceNode(doc, id, { tags: node.tags.filter((t) => t !== tag) })
}

/** Recolour a tag everywhere it appears — a single registry edit. */
export function setTagColor(doc: StoryDoc, tag: string, color: TagColor): StoryDoc {
  if (doc.tagColors.some((t) => t.name === tag && t.color === color)) return doc
  const next = clone(doc)
  const existing = next.tagColors.find((t) => t.name === tag)
  if (existing) existing.color = color
  else next.tagColors.push({ name: tag, color })
  next.tagColors.sort((a, b) => compareStr(a.name, b.name))
  return next
}

export function renameTag(doc: StoryDoc, from: string, to: string): StoryDoc {
  const target = to.trim()
  if (target.length === 0 || from === target) return doc
  const next = clone(doc)
  for (const n of next.nodes) {
    if (!n.tags.includes(from)) continue
    n.tags = [...new Set(n.tags.map((t) => (t === from ? target : t)))].sort(compareStr)
  }
  const entry = next.tagColors.find((t) => t.name === from)
  const color = entry?.color ?? 'none'
  next.tagColors = next.tagColors.filter((t) => t.name !== from && t.name !== target)
  next.tagColors.push({ name: target, color })
  next.tagColors.sort((a, b) => compareStr(a.name, b.name))
  return next
}

/** Every tag in use, plus any registered but currently unused. */
export function allTags(doc: StoryDoc): string[] {
  const set = new Set<string>()
  for (const n of doc.nodes) for (const t of n.tags) set.add(t)
  for (const t of doc.tagColors) set.add(t.name)
  return [...set].sort(compareStr)
}

export function tagColorMap(doc: StoryDoc): Map<string, TagColor> {
  return new Map(doc.tagColors.map((t) => [t.name, t.color]))
}

/* ---------- code ---------- */

/**
 * Set a passage's short reference code, or clear it with an empty value.
 *
 * Validated like `renameNode` rather than written blind like `setSetting`: a
 * code is an identifier, and two passages sharing one would defeat the whole
 * point of quoting it. Comparison is case-insensitive — `a3` and `A3` reading
 * as different passages is a trap for anyone copying a code by eye — but the
 * author's own capitalisation is what gets stored.
 */
export function setCode(doc: StoryDoc, id: string, rawCode: string): RenameResult {
  const node = doc.nodes.find((n) => n.id === id)
  if (!node) return { doc, error: 'That passage no longer exists.' }

  const code = rawCode.trim()
  // Returning the same object matters: `commit` compares by reference, so a
  // fresh document here would push an empty undo entry and wipe the redo stack.
  if (code === node.code) return { doc, error: null }

  // Clearing is always allowed; uniqueness only constrains non-empty codes.
  if (code.length > 0) {
    const folded = code.toLowerCase()
    const clash = doc.nodes.find((n) => n.id !== id && n.code.toLowerCase() === folded)
    if (clash) {
      return { doc, error: `Code "${clash.code}" is already used by "${clash.title}".` }
    }
  }

  return { doc: replaceNode(doc, id, { code }), error: null }
}

/** Every code in use, for the inspector hint and the story index. */
export function allCodes(doc: StoryDoc): string[] {
  return doc.nodes
    .map((n) => n.code)
    .filter((c) => c.length > 0)
    .sort(compareStr)
}

/* ---------- setting ---------- */

export function setSetting(doc: StoryDoc, id: string, value: string): StoryDoc {
  return replaceNode(doc, id, { setting: value.trim() })
}

/**
 * Rename a setting everywhere it appears.
 *
 * Settings are free text with no registry, so this is purely a convenience —
 * but without it a typo fixed on one passage leaves the rest, and the index
 * counts them as two different places.
 */
export function renameSetting(doc: StoryDoc, from: string, to: string): StoryDoc {
  const target = to.trim()
  // An empty target would clear the setting from every passage using it —
  // data loss disguised as a rename. Clearing one passage's setting is what
  // the inspector field is for.
  if (from.length === 0 || target.length === 0 || target === from) return doc
  if (!doc.nodes.some((n) => n.setting === from)) return doc

  const next = clone(doc)
  for (const n of next.nodes) {
    if (n.setting === from) n.setting = target
  }
  return next
}

/* ---------- cast roster ---------- */

export interface CastResult {
  doc: StoryDoc
  error: string | null
}

export function createCharacter(doc: StoryDoc, rawName: string): CastResult {
  const name = rawName.trim()
  if (name.length === 0) return { doc, error: 'A character needs a name.' }
  if (doc.characters.some((c) => c.name === name)) {
    return { doc, error: `A character named "${name}" already exists.` }
  }

  // New arrivals land at the end. A cast has a shape the author chose, and
  // slotting someone into the middle of it alphabetically is exactly the
  // reshuffle this ordering exists to prevent.
  const next = clone(doc)
  next.characters.push(emptyCharacter(name, next.characters.length))
  next.characters = orderRoster(next.characters)
  return { doc: next, error: null }
}

/**
 * Rename a character across the roster, every passage carrying them, and every
 * other character's relations toward them.
 *
 * The cascade is not optional: a passage's cast and a relation target may only
 * name roster entries, so renaming the roster entry alone would orphan every
 * reference to it.
 */
export function renameCharacter(doc: StoryDoc, from: string, rawTo: string): CastResult {
  const to = rawTo.trim()
  if (to.length === 0) return { doc, error: 'A character needs a name.' }
  if (to === from) return { doc, error: null }
  if (!doc.characters.some((c) => c.name === from)) {
    return { doc, error: 'That character no longer exists.' }
  }
  if (doc.characters.some((c) => c.name === to)) {
    return { doc, error: `A character named "${to}" already exists.` }
  }

  const next = clone(doc)
  for (const c of next.characters) {
    if (c.name === from) c.name = to
    // Retarget everyone who had a relation toward the old name. No merge is
    // needed: `to` was rejected above if it was already on the roster, and a
    // relation may only target a roster member — so nobody can already hold a
    // relation to `to`, and a retarget cannot collide or become self-directed.
    if (c.relations.some((r) => r.to === from)) {
      c.relations = c.relations
        .map((r) => (r.to === from ? { ...r, to } : r))
        .sort((a, b) => compareStr(a.to, b.to))
    }
  }
  // Renaming keeps their place: `order` is untouched, so the roster does not
  // jump around underneath the author mid-edit.
  next.characters = orderRoster(next.characters)

  for (const n of next.nodes) {
    if (!n.characters.some((c) => c.name === from)) continue
    n.characters = mergeCast(
      n.characters.map((c) => (c.name === from ? { ...c, name: to } : c)),
    )
  }
  return { doc: next, error: null }
}

/** Collapse duplicate names, keeping the first non-empty note. */
function mergeCast(cast: readonly SceneCharacter[]): SceneCharacter[] {
  const byName = new Map<string, SceneCharacter>()
  for (const c of cast) {
    const existing = byName.get(c.name)
    if (existing === undefined) byName.set(c.name, { ...c })
    else if (existing.note.length === 0 && c.note.length > 0) existing.note = c.note
  }
  return [...byName.values()].sort(compareByName)
}

/** The character's story-wide description, distinct from any per-passage note. */
export function setCharacterBio(doc: StoryDoc, name: string, note: string): StoryDoc {
  const next = clone(doc)
  const entry = next.characters.find((c) => c.name === name)
  if (!entry) return doc
  entry.note = note
  return next
}

/**
 * Remove a character from the roster and from every passage at once.
 *
 * Leaving the passages alone is not an option here — unlike prose, a cast entry
 * is a reference, and an orphaned one would break the roster invariant. The UI
 * warns with the usage count first, and the whole thing is a single undo step.
 */
export function deleteCharacter(doc: StoryDoc, name: string): StoryDoc {
  if (!doc.characters.some((c) => c.name === name)) return doc
  const next = clone(doc)
  next.characters = orderRoster(next.characters.filter((c) => c.name !== name))
  for (const c of next.characters) {
    // Relations toward them go too; an orphaned target breaks the invariant.
    if (c.relations.some((r) => r.to === name)) {
      c.relations = c.relations.filter((r) => r.to !== name)
    }
  }
  for (const n of next.nodes) {
    if (!n.characters.some((c) => c.name === name)) continue
    n.characters = n.characters.filter((c) => c.name !== name)
  }
  return next
}

/**
 * Move a character `delta` places along the roster, clamped by its ends.
 *
 * A move off either end is a no-op returning the same document, so the caller
 * never has to guard the edges and no empty undo step is recorded.
 */
export function moveCharacter(doc: StoryDoc, name: string, delta: number): StoryDoc {
  const ordered = orderRoster(doc.characters)
  const from = ordered.findIndex((c) => c.name === name)
  if (from === -1) return doc
  const to = from + delta
  if (to < 0 || to >= ordered.length || delta === 0) return doc

  const next = clone(doc)
  next.characters = orderRoster(next.characters)
  const [mover] = next.characters.splice(from, 1)
  next.characters.splice(to, 0, mover!)
  next.characters = next.characters.map((c, i) => ({ ...c, order: i }))
  return next
}

/** Put the roster back in alphabetical order — the way out of a bad shuffle. */
export function sortCharacters(doc: StoryDoc): StoryDoc {
  const next = clone(doc)
  next.characters = [...next.characters]
    .sort(compareByName)
    .map((c, i) => ({ ...c, order: i }))
  return next
}

/* ---------- character profiles ---------- */

/** Trim and drop blanks, but never reorder — the author's order is the content. */
function cleanPoints(points: readonly string[]): string[] {
  const out: string[] = []
  for (const p of points) {
    const text = p.trim()
    if (text.length > 0) out.push(text)
  }
  return out
}

/**
 * Replace one trait list wholesale.
 *
 * The unit of change is the whole array: the editor computes the next list and
 * hands it over, which keeps the mutation surface small and makes one blur one
 * undo step rather than one per keystroke.
 */
export function setCharacterTrait(
  doc: StoryDoc,
  name: string,
  field: TraitField,
  points: readonly string[],
): StoryDoc {
  if (!doc.characters.some((c) => c.name === name)) return doc
  const next = clone(doc)
  const entry = next.characters.find((c) => c.name === name)!
  entry[field] = cleanPoints(points)
  return next
}

export function addRelation(doc: StoryDoc, name: string, rawTo: string): CastResult {
  const to = rawTo.trim()
  const entry = doc.characters.find((c) => c.name === name)
  if (!entry) return { doc, error: 'That character no longer exists.' }
  if (to.length === 0) return { doc, error: 'Pick a character.' }
  if (to === name) return { doc, error: 'A character cannot have a relation to themselves.' }
  if (!doc.characters.some((c) => c.name === to)) {
    return { doc, error: `There is no character named "${to}".` }
  }
  if (entry.relations.some((r) => r.to === to)) {
    return { doc, error: `${name} already has a relation to ${to}.` }
  }

  const next = clone(doc)
  const target = next.characters.find((c) => c.name === name)!
  target.relations.push({ to, points: [] })
  target.relations.sort((a, b) => compareStr(a.to, b.to))
  return { doc: next, error: null }
}

export function setRelationPoints(
  doc: StoryDoc,
  name: string,
  to: string,
  points: readonly string[],
): StoryDoc {
  const entry = doc.characters.find((c) => c.name === name)
  if (!entry || !entry.relations.some((r) => r.to === to)) return doc
  const next = clone(doc)
  const relation = next.characters.find((c) => c.name === name)!.relations.find((r) => r.to === to)!
  relation.points = cleanPoints(points)
  return next
}

export function removeRelation(doc: StoryDoc, name: string, to: string): StoryDoc {
  const entry = doc.characters.find((c) => c.name === name)
  if (!entry || !entry.relations.some((r) => r.to === to)) return doc
  const next = clone(doc)
  const target = next.characters.find((c) => c.name === name)!
  target.relations = target.relations.filter((r) => r.to !== to)
  return next
}

/**
 * Who holds a relation *toward* `name`, for the reverse-direction context.
 *
 * Read-only by design: relations are one-directional, so seeing what Tam makes
 * of Mira on Mira's sheet must not become a way to edit Tam's view from there.
 */
export function relationsToward(
  doc: StoryDoc,
  name: string,
): { from: string; points: string[] }[] {
  const out: { from: string; points: string[] }[] = []
  for (const c of doc.characters) {
    if (c.name === name) continue
    const relation = c.relations.find((r) => r.to === name)
    if (relation && relation.points.length > 0) {
      out.push({ from: c.name, points: [...relation.points] })
    }
  }
  return out.sort((a, b) => compareStr(a.from, b.from))
}

/* ---------- a passage's cast ---------- */

export function addPassageCharacter(doc: StoryDoc, id: string, name: string): StoryDoc {
  // Silently refuses anyone off the roster; that invariant is what makes the
  // index counts trustworthy.
  if (!doc.characters.some((c) => c.name === name)) return doc
  const node = doc.nodes.find((n) => n.id === id)
  if (!node || node.characters.some((c) => c.name === name)) return doc
  return replaceNode(doc, id, {
    characters: [...node.characters, { name, note: '' }].sort(compareByName),
  })
}

export function removePassageCharacter(doc: StoryDoc, id: string, name: string): StoryDoc {
  const node = doc.nodes.find((n) => n.id === id)
  if (!node || !node.characters.some((c) => c.name === name)) return doc
  return replaceNode(doc, id, { characters: node.characters.filter((c) => c.name !== name) })
}

export function setPassageCharacterNote(
  doc: StoryDoc,
  id: string,
  name: string,
  note: string,
): StoryDoc {
  const node = doc.nodes.find((n) => n.id === id)
  if (!node || !node.characters.some((c) => c.name === name)) return doc
  return replaceNode(doc, id, {
    characters: node.characters.map((c) => (c.name === name ? { ...c, note } : c)),
  })
}

/* ---------- aggregation ---------- */

export interface MetaUsage {
  value: string
  count: number
  nodeIds: NodeId[]
}

/**
 * Sorted by count descending, name ascending. The name tiebreak makes it a
 * total order, so the index never reshuffles between renders.
 */
function byUsage(a: MetaUsage, b: MetaUsage): number {
  return b.count - a.count || compareStr(a.value, b.value)
}

function tally(doc: StoryDoc, valuesOf: (n: StoryNode) => string[]): Map<string, NodeId[]> {
  const out = new Map<string, NodeId[]>()
  for (const n of doc.nodes) {
    for (const value of valuesOf(n)) {
      if (value.length === 0) continue
      const list = out.get(value)
      if (list) list.push(n.id)
      else out.set(value, [n.id])
    }
  }
  return out
}

/** Every distinct setting in use, with the passages carrying it. */
export function settingUsage(doc: StoryDoc): MetaUsage[] {
  const counts = tally(doc, (n) => [n.setting])
  return [...counts]
    .map(([value, nodeIds]) => ({ value, count: nodeIds.length, nodeIds }))
    .sort(byUsage)
}

/**
 * Every character on the roster, with the passages they appear in.
 *
 * Includes unused roster members at zero — "who have I created but not written
 * yet" is worth seeing, and they're exactly who you'd want to place next.
 *
 * Unlike settings, these keep the author's roster order instead of sorting by
 * count: the leads belong at the top whether or not they are the most cast.
 */
export function characterUsage(doc: StoryDoc): MetaUsage[] {
  const counts = tally(doc, (n) => n.characters.map((c) => c.name))
  return orderRoster(doc.characters).map((c) => ({
    value: c.name,
    count: counts.get(c.name)?.length ?? 0,
    nodeIds: counts.get(c.name) ?? [],
  }))
}

/** The whole roster entry by name — the picker and index both need more than the bio. */
export function characterMap(doc: StoryDoc): Map<string, CharacterEntry> {
  return new Map(doc.characters.map((c) => [c.name, c]))
}

/** Settings already used somewhere, for the inspector's autocomplete. */
export function allSettings(doc: StoryDoc): string[] {
  const set = new Set<string>()
  for (const n of doc.nodes) if (n.setting.length > 0) set.add(n.setting)
  return [...set].sort(compareStr)
}
