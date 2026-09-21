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
import { compareByName, compareNodes, compareStr, emptyCharacter, orderRoster, SLUG_AMBIGUOUS } from '../../types/story'
import type { Span } from '../harlowe/links'
import { linkSyntaxIn, parseLinks, remapLinks } from '../harlowe/links'

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
 *
 * The rule that has to hold is narrower than "copy everything", though, and
 * `replaceNode` relies on the difference: **a mutation never writes to an object
 * it did not itself create.** `clone` is the one way to acquire writable
 * objects, and anything reached from the input document is read-only. The
 * handful of mutations here that do assign in place — `setTagColor`,
 * `renameTag`, `renameSetting`, `recodeAll`, and the roster edits — all call
 * this first and write only onto what it handed back.
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

/**
 * Patch one passage, sharing everything the patch does not touch.
 *
 * Deliberately not `clone`. Cloning gave every one of a story's passages — and
 * every `tags` array on them — a fresh identity on each edit, which meant the
 * canvas could never tell a keystroke apart from a rewrite: Vue compares props
 * by reference, so all several hundred cards re-rendered for one character typed
 * in one body. Sharing the untouched nodes is what lets that comparison say
 * "nothing here moved", and it is why the memoized layout above is worth having
 * at all.
 *
 * Safe under the rule stated on `clone`: nothing shared out of here is ever
 * written to. A mutation that wants a passage's tags builds a new array and
 * passes it as `patch`; one that rewrites the roster calls `clone` and writes
 * onto its own copy. `doc.test.ts` deep-freezes a document and runs every
 * mutation against it, so a future caller that patches in place fails loudly
 * rather than quietly rewriting an undo entry.
 *
 * The nodes array is copied rather than indexed into, which matters more than it
 * looks: `state.doc` is a reactive proxy, so `{ ...doc }` hands back the *same*
 * array, and assigning into it would write straight through into the document
 * already sitting on the undo stack.
 */
function replaceNode(doc: StoryDoc, id: string, patch: Partial<StoryNode>): StoryDoc {
  const i = doc.nodes.findIndex((n) => n.id === id)
  if (i === -1) return doc
  const nodes = [...doc.nodes]
  nodes[i] = { ...nodes[i]!, ...patch }
  return { ...doc, nodes }
}

/** A code that is some prefix followed by a run of digits: `P7`, `T001`, `12`. */
const NUMBERED_CODE = /^(\D*)(\d+)$/

/** What `freeCode` falls back to when a story's codes say nothing useful. */
const DEFAULT_SHAPE = { prefix: 'P', width: 1 } as const

/**
 * The shape a story's existing codes are in: what they start with, and how wide
 * their numbers are padded.
 *
 * Read from the document rather than remembered as a preference, so it survives
 * export, import and a story someone else wrote. Codes that are not a prefix
 * plus a number — `Grotto`, or the `3N01` a level-and-node recode produces — are
 * ignored, and if the ones that *do* fit disagree about their prefix, the
 * default wins. Guessing wrong here is cheap (an odd-looking code on one new
 * passage); guessing confidently wrong across a whole story would not be.
 */
export function codeShape(taken: ReadonlySet<string>): { prefix: string; width: number } {
  let prefix: string | null = null
  let width = 1
  for (const code of taken) {
    const m = NUMBERED_CODE.exec(code)
    if (!m) continue
    if (prefix === null) prefix = m[1]!
    else if (prefix !== m[1]!) return DEFAULT_SHAPE
    width = Math.max(width, m[2]!.length)
  }
  if (prefix === null) return DEFAULT_SHAPE
  // A hand-edited file can carry a code `setCode` would have refused, and
  // copying its punctuation forward would mint a code that re-points the very
  // links written for it: `[[Head north|A|B4]]` parses as a link to `B4`.
  if (linkSyntaxIn(prefix) !== null) return DEFAULT_SHAPE
  return { prefix, width }
}

/**
 * The first free code in the story's own shape, starting at `seed`.
 *
 * `P<id>` is the default shape so that an auto-created passage's code and id
 * agree, which is what lets `parseDoc` reproduce the same code for a file that
 * lost one. But a story the author has recoded to `T001`..`T101` should not mint
 * `P102` for the next passage they add — the odd one out is the new passage, not
 * the hundred that were renumbered — so the prefix and padding are taken from
 * what is already there.
 *
 * The loop is not redundant: an author may have typed `P7` by hand long before
 * the counter ever reached 7.
 */
export function mintCode(shape: { prefix: string; width: number }, n: number): string {
  return `${shape.prefix}${String(n).padStart(shape.width, '0')}`
}

function freeCode(taken: ReadonlySet<string>, seed: number): string {
  const shape = codeShape(taken)
  let n = seed
  while (taken.has(mintCode(shape, n))) n++
  return mintCode(shape, n)
}

/**
 * What a passage created from another one copies across.
 *
 * An explicit argument rather than anything read from app state: this module is
 * pure, and whether to inherit is an editor preference (`stores/prefs.ts`), not
 * something the document knows. Both absent means inherit nothing, so a call
 * site that says nothing gets the plain behaviour.
 */
export interface InheritOptions {
  setting?: boolean
  characters?: boolean
}

/**
 * The cast a brand-new passage starts with, built from a list of names.
 *
 * Names rather than whole `SceneCharacter`s, and that is the point: a note is
 * direction for one scene, so it can never be carried forward by accident, and
 * a string cannot be aliased into the parent's array the way a shared object
 * would be — the failure `clone()` warns about. Off-roster names are dropped on
 * the same rule `addPassageCharacter` applies, and the result is stored in name
 * order, which is what keeps the save file byte-stable.
 */
function castFrom(doc: StoryDoc, names: readonly string[] | undefined): SceneCharacter[] {
  if (names === undefined || names.length === 0) return []
  const roster = new Set(doc.characters.map((c) => c.name))
  const seen = new Set<string>()
  const out: SceneCharacter[] = []
  for (const name of names) {
    if (!roster.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push({ name, note: '' })
  }
  return out.sort(compareByName)
}

/**
 * Create a passage. `opts.code` asks for a specific code and is honoured only if
 * it is free — a caller passing one got it from author text, which may collide.
 */
export function createNode(
  doc: StoryDoc,
  opts: {
    title?: string
    code?: string
    body?: string
    setting?: string
    /** Names only. Notes are per-scene and never reach a new passage. */
    characters?: readonly string[]
  } = {},
): { doc: StoryDoc; node: StoryNode } {
  const next = clone(doc)
  const taken = new Set(next.nodes.map((n) => n.code))
  const wanted = opts.code?.trim() ?? ''
  const node: StoryNode = {
    id: String(next.nextId),
    // A passage the app makes deserves a placeholder name. A passage the author
    // wrote by hand does not get one invented for it — see `parseDoc`.
    title: opts.title?.trim() || 'Untitled Passage',
    code: wanted.length > 0 && !taken.has(wanted) ? wanted : freeCode(taken, next.nextId),
    slug: '',
    note: '',
    body: opts.body ?? '',
    tags: [],
    state: 'TODO',
    isEnding: false,
    levelOffset: 0,
    setting: opts.setting?.trim() ?? '',
    characters: castFrom(next, opts.characters),
  }
  next.nextId += 1
  next.nodes.push(node)
  if (next.startNodeId === null) next.startNodeId = node.id
  return { doc: next, node }
}

/**
 * Delete several passages in one document edit, so a multi-select delete lands
 * as a single undo step rather than one entry per passage.
 *
 * Returns `doc` itself when no id matches, so the store's reference compare can
 * tell a real edit from a no-op and never pushes an empty history entry.
 */
export function deleteNodes(doc: StoryDoc, ids: readonly string[]): StoryDoc {
  const drop = new Set(ids)
  if (!doc.nodes.some((n) => drop.has(n.id))) return doc
  const next = clone(doc)
  next.nodes = next.nodes.filter((n) => !drop.has(n.id))
  // Inbound [[...]] markup is deliberately left alone: the author wrote that
  // prose, and a delete is not a statement about what the text should say. The
  // dangling links surface as phantom cards instead.
  if (next.startNodeId !== null && drop.has(next.startNodeId)) {
    next.startNodeId = next.nodes[0]?.id ?? null
  }
  return next
}

export function deleteNode(doc: StoryDoc, id: string): StoryDoc {
  return deleteNodes(doc, [id])
}

export interface CodeResult {
  doc: StoryDoc
  error: string | null
}

/**
 * What to call a passage in a message to the author.
 *
 * An empty title is allowed — such a passage is identified by its code alone —
 * so a refusal that interpolated the title raw would name neither side of a
 * collision.
 */
function nameOf(node: StoryNode): string {
  return node.title.length > 0 ? node.title : node.code
}

/**
 * Rename a passage.
 *
 * A plain field write, and deliberately so: a title is a name for the author's
 * benefit, nothing structural reads it, and two passages may share one. There is
 * nothing to validate and nothing to cascade. The cascade that used to live here
 * belongs to `setCode` now, because the code is what links actually name.
 *
 * An empty title is allowed — such a passage is identified by its code alone.
 */
export function renameNode(doc: StoryDoc, id: string, rawTitle: string): StoryDoc {
  const node = doc.nodes.find((n) => n.id === id)
  const title = rawTitle.trim()
  // Returning the same object matters: `commit` compares by reference, so a
  // fresh document here would push an empty undo entry and wipe the redo stack.
  if (!node || title === node.title) return doc
  return replaceNode(doc, id, { title })
}

/**
 * Apply a body edit. A plain field write — link resolution is `resolveLinks`.
 *
 * The two are separate because this runs on every keystroke. Creating passages
 * and rewriting link text here would splice `|P8` in under the author's caret
 * mid-word, and the editor's textarea is value-bound, so the caret would then
 * jump to the end of the field.
 */
export function setBody(doc: StoryDoc, id: string, body: string): StoryDoc {
  if (!doc.nodes.some((n) => n.id === id)) return doc
  return replaceNode(doc, id, { body })
}

/**
 * Create the passages this body links to, and bind its bare links to the codes
 * just minted for them.
 *
 * Runs when the author leaves the editor, not while they type. `bodyAtFocus` is
 * the body as it stood when they entered it, which is the only way to tell a
 * link they just wrote from one that was already there.
 *
 * Creation lives here rather than in the derive step on purpose: if deriving
 * created nodes, deleting a still-linked passage would resurrect it on the very
 * next re-derive. That guard matters twice over now, because `[[Go|3A]]` is
 * itself an instruction to create `3A` — without it, merely opening a passage
 * that linked to a deleted one would bring it back.
 *
 * Bare links are rewritten in place: `[[Head north]]` names no code, so the
 * passage it creates gets a minted one and the link becomes
 * `[[Head north|P7]]`. Only the target half of the `[[...]]` is spliced, and the
 * splices run right-to-left so earlier spans stay valid — the same discipline
 * `retargetLinks` follows.
 */
export function resolveLinks(
  doc: StoryDoc,
  id: string,
  bodyAtFocus: string,
  inherit: InheritOptions = {},
): StoryDoc {
  const before = doc.nodes.find((n) => n.id === id)
  if (!before) return doc
  const body = before.body

  // Snapshotted once, above the loop: every passage a single blur creates is
  // written from the same parent, so they all start from the same scene.
  const setting = inherit.setting === true ? before.setting : ''
  const cast = inherit.characters === true ? before.characters.map((c) => c.name) : []

  const byCode = new Set(doc.nodes.map((n) => n.code))
  const previous = new Set(parseLinks(bodyAtFocus).map((l) => l.target))
  /** Bare link target -> the code minted for it, so `[[X]]` twice is one passage. */
  const minted = new Map<string, string>()
  const splices: { span: Span; text: string }[] = []

  let next = doc
  for (const link of parseLinks(body)) {
    const target = link.target
    if (byCode.has(target)) continue
    if (previous.has(target)) continue

    if (link.label === null) {
      // `[[Head north]]`: the text is a title, and the code is ours to mint.
      let code = minted.get(target)
      if (code === undefined) {
        // A passage written from here starts in the same scene as the one that
        // wrote it — but only as far as the author has asked it to.
        const made = createNode(next, { title: target, setting, characters: cast })
        next = made.doc
        code = made.node.code
        minted.set(target, code)
        byCode.add(code)
      }
      splices.push({ span: link.targetSpan, text: `${target}|${code}` })
    } else {
      // `[[Head north|3A]]`: the author named the code; the label is the title.
      const made = createNode(next, {
        code: target,
        title: link.label,
        setting,
        characters: cast,
      })
      next = made.doc
      byCode.add(made.node.code)
    }
  }

  if (splices.length === 0) return next

  let rewritten = body
  for (let i = splices.length - 1; i >= 0; i--) {
    const { span, text } = splices[i]!
    rewritten = rewritten.slice(0, span.start) + text + rewritten.slice(span.end)
  }
  return replaceNode(next, id, { body: rewritten })
}

/**
 * The setting a newly created passage should start with, given the passages
 * that link to it.
 *
 * Inherits only when every parent agrees. A phantom can be linked from several
 * passages set in different places, and picking one arbitrarily would plant
 * wrong metadata silently — ambiguity means don't guess.
 */
export function inheritedSetting(doc: StoryDoc, code: string): string {
  let agreed: string | null = null
  for (const n of doc.nodes) {
    if (!parseLinks(n.body).some((l) => l.target === code)) continue
    if (agreed === null) agreed = n.setting
    else if (agreed !== n.setting) return ''
  }
  return agreed ?? ''
}

/** Whether two casts name the same people. Notes are not part of the question. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}

/**
 * A passage's cast as a sorted name list — the comparable form of a cast.
 *
 * Sorted here rather than trusting that storage already is. Every write path
 * does sort, but `inheritedCast` turns on this comparison, and a hand-edited
 * file reaching it out of order would silently refuse to inherit.
 */
function castNames(node: StoryNode): string[] {
  return node.characters.map((c) => c.name).sort(compareStr)
}

/**
 * The cast a newly created passage should start with, given the passages that
 * link to it.
 *
 * The same rule as `inheritedSetting`, for the same reason: a phantom can be
 * linked from several passages with different people in them, and merging or
 * picking one would plant wrong metadata silently. Ambiguity means don't guess.
 * One parent with a cast and one without disagree, exactly as a blank setting
 * disagrees with a filled one.
 */
export function inheritedCast(doc: StoryDoc, code: string): string[] {
  let agreed: string[] | null = null
  for (const n of doc.nodes) {
    if (!parseLinks(n.body).some((l) => l.target === code)) continue
    const names = castNames(n)
    if (agreed === null) agreed = names
    else if (!sameNames(agreed, names)) return []
  }
  return agreed ?? []
}

/**
 * Turn a phantom (a link with no passage behind it) into a real passage.
 *
 * `label` is the display text some link proposed for it, which becomes the
 * title. A phantom reached only by bare `[[3A]]` links has none, so it is named
 * after its code until the author says otherwise.
 */
export function materializePhantom(
  doc: StoryDoc,
  code: string,
  label?: string | null,
  inherit: InheritOptions = {},
): StoryDoc {
  if (doc.nodes.some((n) => n.code === code)) return doc
  // Gated here rather than inside the queries, so a preference that is off
  // skips the graph walks entirely.
  return createNode(doc, {
    code,
    title: label?.trim() || code,
    setting: inherit.setting === true ? inheritedSetting(doc, code) : '',
    characters: inherit.characters === true ? inheritedCast(doc, code) : [],
  }).doc
}

/**
 * Set the state of several passages in one document edit, so a multi-select
 * change lands as a single undo step rather than one entry per passage.
 *
 * Guarded like `setEndingMany`: `commit` compares by reference, so returning a
 * fresh document when every id already holds `value` would push an empty undo
 * entry and wipe redo. A whole selection already agreeing is the common case,
 * not the rare one — the author clicks Done on a branch that is mostly done.
 */
export function setStateMany(
  doc: StoryDoc,
  ids: readonly string[],
  value: NodeState,
): StoryDoc {
  const pick = new Set(ids)
  if (!doc.nodes.some((n) => pick.has(n.id) && n.state !== value)) return doc
  const next = clone(doc)
  next.nodes = next.nodes.map((n) => (pick.has(n.id) ? { ...n, state: value } : n))
  return next
}

export function setState(doc: StoryDoc, id: string, state: NodeState): StoryDoc {
  return setStateMany(doc, [id], state)
}

/**
 * Mark several passages as places a route stops, or unmark them, in one edit.
 *
 * Guarded like `setNote`: `commit` compares by reference, so returning a fresh
 * document for an unchanged value would push an empty undo entry and wipe redo.
 * A checkbox is easy to toggle twice.
 */
export function setEndingMany(
  doc: StoryDoc,
  ids: readonly string[],
  value: boolean,
): StoryDoc {
  const pick = new Set(ids)
  if (!doc.nodes.some((n) => pick.has(n.id) && n.isEnding !== value)) return doc
  const next = clone(doc)
  next.nodes = next.nodes.map((n) => (pick.has(n.id) ? { ...n, isEnding: value } : n))
  return next
}

export function setEnding(doc: StoryDoc, id: string, value: boolean): StoryDoc {
  return setEndingMany(doc, [id], value)
}

/**
 * Nudge several passages below their structural floor, or return them to it,
 * in one edit — so a multi-select move lands as a single undo step rather than
 * one entry, and one Sugiyama pass, per passage.
 *
 * `setStateMany`'s shape, and guarded for its reason: `commit` compares by
 * reference, so a fresh document for a batch that changes nothing would push an
 * empty undo entry and wipe redo. Unlike State and Ending this field *is* in
 * `layoutKey`, so a spurious clone would also buy a re-layout.
 *
 * Clamped once, ahead of the guard — `setLevelOffset(doc, id, 9)` on a passage
 * already at 1 has to be the no-op it looks like, which the `replaceNode` this
 * replaced cloned straight through.
 */
export function setLevelOffsetMany(
  doc: StoryDoc,
  ids: readonly string[],
  offset: number,
): StoryDoc {
  const value = Math.min(1, Math.max(0, Math.trunc(offset)))
  const pick = new Set(ids)
  if (!doc.nodes.some((n) => pick.has(n.id) && n.levelOffset !== value)) return doc
  const next = clone(doc)
  next.nodes = next.nodes.map((n) => (pick.has(n.id) ? { ...n, levelOffset: value } : n))
  return next
}

export function setLevelOffset(doc: StoryDoc, id: string, offset: number): StoryDoc {
  return setLevelOffsetMany(doc, [id], offset)
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

/**
 * The story-wide scratchpad.
 *
 * Deliberately unnormalized, unlike `setStoryTitle` above: a title is a label
 * and wants trimming, but a scratchpad's trailing newline is the author's, and
 * trimming here without trimming in `parseDoc` would stop a hand-edited file
 * re-serializing to itself.
 *
 * Returning the same object for a no-op matters for the same reason it does in
 * `setNote`: `commit` compares by reference, and this runs on every keystroke.
 */
export function setStoryNotes(doc: StoryDoc, notes: string): StoryDoc {
  if (notes === doc.notes) return doc
  return { ...clone(doc), notes }
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

/**
 * Drop a tag from the story's registry.
 *
 * Only when nothing carries it. A tag still in use is refused rather than
 * stripped from the passages carrying it: removing a label is a tidying-up
 * action, and quietly rewriting six passages because a button said "remove" is
 * not what anyone pressing it meant. Un-tag them first and the tag becomes
 * removable — which is also why `allTags` keeps reporting the unused ones:
 * they are the rows this exists to clear.
 *
 * Refusing returns the document unchanged, by reference, so `commit` pushes no
 * undo entry for a press that did nothing. Same rule `setTagColor` follows.
 */
export function deleteTag(doc: StoryDoc, tag: string): StoryDoc {
  if (doc.nodes.some((n) => n.tags.includes(tag))) return doc
  if (!doc.tagColors.some((t) => t.name === tag)) return doc
  const next = clone(doc)
  next.tagColors = next.tagColors.filter((t) => t.name !== tag)
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
 * Set a passage's code, retargeting every link that pointed at it.
 *
 * This is the operation renaming a title used to be, and for the same reason: a
 * code change is intent-preserving — the author wants those links to keep
 * working — whereas a delete is not. Only the target half of each `[[...]]` is
 * rewritten; display text and surrounding prose are untouched.
 *
 * Comparison is exact. `a3` and `A3` are different passages, so a code copied by
 * eye has to be copied exactly.
 *
 * The one-entry case of `recodeAll`, and routed through it rather than
 * reimplemented: a hand-written loop here used to skip the recoded passage's own
 * body, which quietly dropped a self-link into a phantom.
 */
export function setCode(doc: StoryDoc, id: string, rawCode: string): CodeResult {
  return recodeAll(doc, new Map([[id, rawCode]]))
}

/**
 * Recode many passages at once, retargeting every link in one pass.
 *
 * One mutation rather than a loop of `setCode` calls, because a recode is a
 * *permutation*: `P1 -> P2` while `P2` still exists is a collision `setCode` is
 * right to refuse, and pairs applied one at a time would double-move a link an
 * earlier pair already rewrote. Both disappear when the whole rewrite is a
 * single pass — every target is looked up once, in the old vocabulary.
 *
 * Keyed by node id, not by code: ids are the document's only guaranteed-unique
 * key, so a hand-edited file carrying a duplicate code still recodes exactly the
 * passages asked for, and repairs the duplicate as a side effect.
 *
 * Unlike `setCode` this also rewrites a recoded passage's *own* body, so a
 * self-link survives the recode instead of falling out as a phantom.
 *
 * A target no entry names is left alone. A dangling `[[Cave]]` is the author's
 * prose, and a recode says nothing about it.
 *
 * Where the new codes come from is not this module's business — see
 * `lib/graph/recode.ts`, which reads them off the drawing. Mutations never read
 * layout; this one receives finished text.
 */
export function recodeAll(doc: StoryDoc, mapping: ReadonlyMap<string, string>): CodeResult {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))

  /** node id -> trimmed new code. */
  const resolved = new Map<string, string>()
  /** new code -> the passage claiming it, for the collision message. */
  const claimed = new Map<string, string>()
  /** old code -> new code, changes only: what the bodies are rewritten through. */
  const rewrite = new Map<string, string>()
  /**
   * Whether any passage's code actually changes.
   *
   * Tracked separately from `rewrite`, which is keyed by *old code* and so is
   * empty when the only passage moving is the second holder of a duplicated
   * code — links resolve to the first holder, so there is nothing to splice.
   * Returning early on an empty `rewrite` would drop that write and report
   * success, leaving the duplicate the caller asked to repair.
   */
  let moved = false

  // Everything is validated before the first clone, so a refusal provably leaves
  // `doc` identical and `commit`'s reference compare sees a no-op.
  for (const [id, raw] of mapping) {
    const node = byId.get(id)
    if (!node) return { doc, error: 'That passage no longer exists.' }

    const code = raw.trim()
    if (code.length === 0) return { doc, error: 'A passage needs a code.' }

    const offending = linkSyntaxIn(code)
    if (offending) {
      return {
        doc,
        error: `A code cannot contain "${offending}" — it is link syntax, and would break the links pointing here.`,
      }
    }

    const rival = claimed.get(code)
    if (rival !== undefined) {
      return { doc, error: `"${rival}" and "${nameOf(node)}" would both be given the code "${code}".` }
    }
    claimed.set(code, nameOf(node))
    resolved.set(id, code)
    if (code !== node.code) moved = true
  }

  // A passage the mapping leaves alone keeps its code, and that code is still
  // taken — a partial recode may not walk onto it.
  for (const n of doc.nodes) {
    if (resolved.has(n.id)) continue
    if (claimed.has(n.code)) {
      return { doc, error: `Code "${n.code}" is already used by "${nameOf(n)}".` }
    }
  }

  // Which passage a link reaches is decided by `deriveGraph`: the *first* node
  // in canonical order holding that code wins. The rewrite has to resolve the
  // same way, or a file carrying a duplicate code would see its links quietly
  // move to the other passage — the codes repaired, the story re-plumbed.
  const firstByCode = new Map<string, string>()
  for (const n of [...doc.nodes].sort(compareNodes)) {
    if (!firstByCode.has(n.code)) firstByCode.set(n.code, n.id)
  }
  for (const [code, id] of firstByCode) {
    const to = resolved.get(id)
    if (to !== undefined && to !== code) rewrite.set(code, to)
  }

  if (!moved) return { doc, error: null }

  const next = clone(doc)
  for (const n of next.nodes) {
    const code = resolved.get(n.id)
    if (code !== undefined) n.code = code
    n.body = remapLinks(n.body, rewrite)
  }
  return { doc: next, error: null }
}


/* ---------- slug ---------- */

/**
 * Long enough to be legible in a route code, short enough that a dozen of them
 * still fit on a card line.
 */
export const SLUG_MAX = 10

/**
 * Trim, drop every `*`, cut to length, trim again.
 *
 * **The `*` is the point.** A running slug writes `*` where the routes to a
 * passage disagree (`lib/graph/slugs.ts`), so a slug containing one could not
 * be told from the marker and the card would state something false about the
 * story. Stripping is right rather than refusing: this commits on every
 * keystroke, and a refusal mid-word would fight the author's caret.
 *
 * The rest is `normalizeNote`'s shape, and for its reasons. Trimming last makes
 * this idempotent — cut mid-space and a second pass would trim again, so a
 * hand-edited file would not re-serialize to itself and the canonical-JSON
 * invariant breaks. The cut counts characters, not UTF-16 units, or a slug
 * ending in an emoji is truncated into half a surrogate pair.
 *
 * ---
 *
 * On reviving a concatenation this repo deliberately abandoned (see `setNote`,
 * and invariant 3 in CLAUDE.md). Four things make this a different proposition
 * from the `D-LY` grammar:
 *
 * - It is **its own field**. The note is free prose and carries no grammar; the
 *   two uses were fighting over one string before, and that was most of the
 *   problem.
 * - It is **derived, not authored**. The author writes one mark per passage and
 *   never maintains the sequence; the route string is computed from the graph
 *   and stored nowhere.
 * - It **marks its own ambiguity**. `D-LY` asserted a single route because it
 *   had no way to say otherwise. `A*D` says out loud that the middle varies,
 *   which is the fail-closed direction `gates.ts` argues for.
 * - It is **display, not identity**. A route's identity is still the code
 *   sequence, and running slugs are explicitly allowed to collide.
 *
 * What is *not* rebutted is the growth: a running slug still gets longer with
 * depth, and the leading characters are still the part you skip. That is real,
 * and it is answered by showing the tail on the card rather than by pretending
 * it does not happen.
 */
export function normalizeSlug(raw: string): string {
  return [...raw.trim()]
    .filter((c) => c !== SLUG_AMBIGUOUS)
    .slice(0, SLUG_MAX)
    .join('')
    .trim()
}

/**
 * Set a passage's slug.
 *
 * Nothing structural reads one, and nothing resolves against one: slugs repeat,
 * and a route code built from them is for a reader to quote, not for the tool
 * to look anything up by.
 */
export function setSlug(doc: StoryDoc, id: string, value: string): StoryDoc {
  const node = doc.nodes.find((n) => n.id === id)
  const slug = normalizeSlug(value)
  // Same reference-equality guard as `setNote`: this commits on every
  // keystroke, and past the cap every further character would otherwise push an
  // empty undo entry and wipe the redo stack.
  if (!node || slug === node.slug) return doc
  return replaceNode(doc, id, { slug })
}

/* ---------- note ---------- */

/**
 * Set a passage's note.
 *
 * Free text, and deliberately so. This field once carried a grammar — a case
 * rule that let per-passage notes concatenate into a route like `D-LY` — and
 * the concatenation turned out to be noise: in a real story an early branch is
 * often irrelevant to a later one, so the leading characters were something to
 * mentally strip rather than context to read. What survived is the useful half,
 * a note to yourself, which needs no grammar at all.
 *
 * The concatenation itself came back, on `slug`, and none of the above is
 * retracted — see `normalizeSlug` for why that is not the same mistake twice.
 *
 * Nothing structural reads a note. They may repeat, may be empty, and are only
 * ever shown on their own passage — see `searchableText`, which is the other
 * place they matter.
 */
export function setNote(doc: StoryDoc, id: string, value: string): StoryDoc {
  const node = doc.nodes.find((n) => n.id === id)
  // Stored exactly as typed, like `setStoryNotes` and for its reasons: nothing
  // normalizes on the way out or back in, so the round trip is identity rather
  // than a fixed point. Trailing whitespace is where the caret is parked, and a
  // blank line between paragraphs is a blank line.
  if (!node || value === node.note) return doc
  return replaceNode(doc, id, { note: value })
}

/* ---------- setting ---------- */

/**
 * Put several passages in one place, in one edit — so a multi-select change
 * lands as a single undo step rather than one entry per passage.
 *
 * `setStateMany`'s shape, and guarded for its reason: `commit` compares by
 * reference, so a fresh document for a batch that changes nothing would push an
 * empty undo entry and wipe redo. A run of passages already sharing a setting
 * is the common case here, not the rare one — the author is usually adding the
 * one that was missed.
 *
 * Trimmed once, ahead of the guard, for the reason `setLevelOffsetMany` clamps
 * ahead of its own: `"  Alley  "` applied to a set already on `"Alley"` has to
 * be the no-op it looks like, which the `replaceNode` this replaced cloned
 * straight through.
 */
export function setSettingMany(
  doc: StoryDoc,
  ids: readonly string[],
  value: string,
): StoryDoc {
  const setting = value.trim()
  const pick = new Set(ids)
  if (!doc.nodes.some((n) => pick.has(n.id) && n.setting !== setting)) return doc
  const next = clone(doc)
  next.nodes = next.nodes.map((n) => (pick.has(n.id) ? { ...n, setting } : n))
  return next
}

export function setSetting(doc: StoryDoc, id: string, value: string): StoryDoc {
  return setSettingMany(doc, [id], value)
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
