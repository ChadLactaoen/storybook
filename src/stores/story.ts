import { computed, markRaw, reactive, shallowRef, watch } from 'vue'
import { exportDoc, importDoc } from '../lib/doc/file'
import * as M from '../lib/doc/mutations'
import { serializeDoc } from '../lib/doc/serialize'
import { clearLocal, loadLocal, localMeta, saveLocal } from '../lib/doc/storage'
import type { SavedMeta } from '../lib/doc/storage'
import { buildLink } from '../lib/harlowe/links'
import { deriveGraph } from '../lib/graph/derive'
import { fnv1a } from '../lib/graph/hash'
import { isPhantomId } from '../lib/graph/constants'
import { layoutStory } from '../lib/graph/layout'
import { gatesOf } from '../lib/graph/gates'
import type { GateEntry } from '../lib/graph/gates'
import { countPaths } from '../lib/graph/paths'
import { drawingOrder, planRecode } from '../lib/graph/recode'
import type { RecodeEntry, RecodeOptions } from '../lib/graph/recode'
import { reachableFrom, strandedBy } from '../lib/graph/reachability'
import { readStoryMacros } from '../lib/harlowe/macros'
import type { LayoutResult } from '../lib/graph/types'
import type {
  NodeState,
  SelectMode,
  StoryDoc,
  StoryNode,
  TagColor,
  TraitField,
} from '../types/story'
import { compareNodes, compareStr, emptyDoc, nodeLabel } from '../types/story'
import { prefs } from './prefs'

const HISTORY_LIMIT = 100

interface State {
  doc: StoryDoc
  /**
   * The anchor: the card the inspector and the minimap point at. May be a
   * phantom id or null, neither of which can appear in `selectedIds`.
   */
  selectedId: string | null
  /**
   * The whole selection: real passage ids only, deduped, in click order. A real
   * anchor is always a member; a null or phantom anchor means this is empty.
   * Every write to either field goes through `setSelection` to keep that true.
   */
  selectedIds: string[]
  started: boolean
  search: string
  tagFilter: string[]
  stateFilter: NodeState[]
  settingFilter: string[]
  characterFilter: string[]
  /** Which character's sheet is open, if any. */
  openCharacter: string | null
  savedAt: number | null
  notice: string | null
  warnings: string[]
}

const state = reactive<State>({
  doc: emptyDoc(),
  selectedId: null,
  selectedIds: [],
  started: false,
  search: '',
  tagFilter: [],
  stateFilter: [],
  settingFilter: [],
  characterFilter: [],
  openCharacter: null,
  savedAt: null,
  notice: null,
  warnings: [],
})

const undoStack: StoryDoc[] = []
const redoStack: StoryDoc[] = []

/**
 * Layout lives in a shallowRef and is marked raw. Deep-proxying the thousands
 * of plain objects a large story produces costs considerably more than running
 * the layout itself, and nothing in the result is ever mutated in place.
 */
const layout = shallowRef<LayoutResult>(markRaw(layoutStory(state.doc)))
const layoutVersion = shallowRef(0)

/**
 * Memoize on the inputs layout actually depends on. Editing a tag or a state is
 * a large share of real editing and leaves the geometry untouched, so those
 * edits become pure re-renders.
 *
 * `code` has to be in here: it is what links resolve against, so leaving it out
 * would let a recode go unnoticed while every inbound edge re-resolved to a
 * phantom — which presents as "the canvas didn't update". `title` is in here
 * only because it reaches `NodeLayout.title` and the diagnostic strings, both of
 * which live inside the memoized result.
 *
 * Fields join on NUL rather than a space so that `{code:'A B', title:'C'}` and
 * `{code:'A', title:'B C'}` cannot hash alike now that codes are author-typed.
 */
let lastLayoutKey = ''

const KEY_SEP = '\u0000'

function layoutKey(doc: StoryDoc): string {
  const parts = doc.nodes.map((n) =>
    [n.id, n.code, n.title, n.levelOffset, n.body].join(KEY_SEP),
  )
  parts.push(String(doc.startNodeId))
  return fnv1a(parts.join('|'))
}

/**
 * Install a new document and bring layout with it, synchronously.
 *
 * Deliberately not done in a watcher: a Vue watcher flushes on the next tick,
 * which would leave `layout` describing the previous document for anyone who
 * reads it in the same turn as an edit.
 *
 * `precomputed` is the layout of `next`, for a caller that already had to build
 * it — a recode may settle by laying its own result out, and the Sugiyama
 * pipeline is the most expensive thing here to run twice on one button press.
 * Pass it only for a layout of exactly this document; the memo key is written
 * either way.
 */
function setDoc(next: StoryDoc, precomputed?: LayoutResult): void {
  state.doc = next
  const key = layoutKey(next)
  if (key === lastLayoutKey) return
  lastLayoutKey = key
  layout.value = markRaw(precomputed ?? layoutStory(next))
  // A stale-result guard from day one, so moving layout into a worker later is
  // a change of plumbing rather than a redesign.
  layoutVersion.value++
}

/* ---------- autosave ---------- */

let saveTimer: ReturnType<typeof setTimeout> | null = null

function cancelPendingSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
}

watch(
  () => state.doc,
  () => {
    if (!state.started) return
    cancelPendingSave()
    saveTimer = setTimeout(() => {
      const meta = saveLocal(state.doc)
      state.savedAt = meta?.savedAt ?? null
      if (!meta) state.notice = 'Could not auto-save. Browser storage is unavailable.'
    }, 300)
  },
  { deep: false },
)

/* ---------- history ---------- */

function commit(next: StoryDoc, precomputed?: LayoutResult): void {
  if (next === state.doc) return
  undoStack.push(state.doc)
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
  redoStack.length = 0
  setDoc(next, precomputed)
}

export function undo(): void {
  const prev = undoStack.pop()
  if (!prev) return
  redoStack.push(state.doc)
  setDoc(prev)
  dropDanglingSheet()
  pruneSelection()
}

export function redo(): void {
  const next = redoStack.pop()
  if (!next) return
  undoStack.push(state.doc)
  setDoc(next)
  dropDanglingSheet()
  pruneSelection()
}

/** Stepping through history can remove the character the sheet is describing. */
function dropDanglingSheet(): void {
  if (state.openCharacter === null) return
  if (!state.doc.characters.some((c) => c.name === state.openCharacter)) {
    state.openCharacter = null
  }
}

/* ---------- session ---------- */

/**
 * Drop every piece of state that describes the document being replaced.
 *
 * Filters and the open character sheet name content by value, so carrying them
 * into a different story leaves the whole tree dimmed for no visible reason, or
 * a sheet describing someone who no longer exists.
 */
function resetViewState(): void {
  undoStack.length = 0
  redoStack.length = 0
  state.openCharacter = null
  state.warnings = []
  clearFilters()
}

/**
 * The link is written in its bound form on purpose. `P2` is exactly the code the
 * next passage will be minted with, so the dashed card the author sees is the
 * one that appears when they double-click it.
 */
const STARTER_BODY = [
  'Your story begins here.',
  '',
  'Write a link like [[Head north|P2]] to branch. The part after the bar is the',
  'passage code — that is what a link points at, and titles never matter to it.',
].join('\n')

export function newStory(title = 'Untitled Story'): void {
  const { doc, node } = M.createNode(M.setStoryTitle(emptyDoc(), title), {
    title: 'Start',
    body: STARTER_BODY,
  })
  resetViewState()
  setDoc(doc)
  select(node.id)
  state.started = true
  state.savedAt = saveLocal(doc)?.savedAt ?? null
}

export function resumeStory(): boolean {
  const loaded = loadLocal()
  if (!loaded) return false
  resetViewState()
  setDoc(loaded)
  select(loaded.startNodeId ?? loaded.nodes[0]?.id ?? null)
  state.started = true
  state.savedAt = localMeta()?.savedAt ?? null
  return true
}

export function loadStory(json: string): void {
  const { doc: loaded, warnings } = importDoc(json)
  resetViewState()
  setDoc(loaded)
  select(loaded.startNodeId ?? loaded.nodes[0]?.id ?? null)
  state.started = true
  state.warnings = warnings
  state.savedAt = saveLocal(loaded)?.savedAt ?? null
}

export function saveToFile(): void {
  exportDoc(state.doc)
}

export function discardStory(): void {
  // Cancel first: the doc watcher bails out on `!state.started`, so a timer
  // armed by the last edit would otherwise fire after the wipe and write the
  // now-empty document straight back into storage.
  cancelPendingSave()
  clearLocal()
  state.started = false
  select(null)
  resetViewState()
  lastLayoutKey = ''
  setDoc(emptyDoc())
}

/* ---------- selection ---------- */

/** The one place both selection fields are written, so the invariant stays local. */
function setSelection(ids: readonly string[], anchor: string | null): void {
  state.selectedIds = [...new Set(ids)]
  state.selectedId = anchor
}

export function select(id: string | null): void {
  if (id === null || isPhantomId(id)) setSelection([], id)
  else setSelection([id], id)
}

/** Cmd/Ctrl click: the passage and everything it leads to. */
export function selectSubtree(id: string): void {
  const g = layout.value.graph
  if (isPhantomId(id) || !g.byId.has(id)) return select(id)
  // Phantoms are sinks in the walk, so dropping them here cannot cut the
  // traversal short — it only keeps undeletable ids out of the selection.
  setSelection(
    [...reachableFrom(g, id)].filter((n) => !isPhantomId(n)),
    id,
  )
}

/** Shift click: add or drop one passage, leaving the rest of the selection alone. */
export function toggleSelected(id: string): void {
  if (isPhantomId(id)) return select(id)
  if (!state.selectedIds.includes(id)) {
    return setSelection([...state.selectedIds, id], id)
  }
  const rest = state.selectedIds.filter((x) => x !== id)
  // Dropping the anchor re-anchors on whatever is left, so the inspector never
  // describes a passage that is no longer selected.
  setSelection(rest, state.selectedId === id ? (rest[0] ?? null) : state.selectedId)
}

/** The single entry point the canvas calls; the card decides the mode. */
export function applySelect(id: string | null, mode: SelectMode): void {
  if (id === null || mode === 'replace') return select(id)
  if (mode === 'subtree') return selectSubtree(id)
  toggleSelected(id)
}

/** Stepping through history can remove passages the selection names. */
function pruneSelection(): void {
  const live = new Set(state.doc.nodes.map((n) => n.id))
  const kept = state.selectedIds.filter((id) => live.has(id))
  const anchorLives =
    state.selectedId !== null && (isPhantomId(state.selectedId) || live.has(state.selectedId))
  setSelection(kept, anchorLives ? state.selectedId : (kept[0] ?? null))
}

/* ---------- delete ---------- */

export interface DeleteImpact {
  /** Passages the delete would remove, canonical order. */
  removed: StoryNode[]
  /** Links in surviving prose that would be left pointing at nothing. */
  dangling: number
  /** Surviving passages that would lose their route from the start. */
  stranded: StoryNode[]
}

/**
 * What deleting `ids` would do, or null when none of them exist.
 *
 * Reuses the graph layout already derived for the current document: `layoutKey`
 * memoizes on exactly the fields the graph is built from, so it is never stale.
 */
function impactOf(ids: readonly string[]): DeleteImpact | null {
  const drop = new Set(ids)
  const removed = state.doc.nodes.filter((n) => drop.has(n.id)).sort(compareNodes)
  if (removed.length === 0) return null
  const g = layout.value.graph
  const dangling = g.edges.filter((e) => !drop.has(e.sourceId) && drop.has(e.targetId)).length
  const next = M.deleteNodes(state.doc, [...drop])
  return { removed, dangling, stranded: strandedBy(state.doc, next, g) }
}

/** Non-null only for a multi-selection; the single-passage path is unchanged. */
export const deleteImpact = computed<DeleteImpact | null>(() =>
  state.selectedIds.length > 1 ? impactOf(state.selectedIds) : null,
)

const NAME_LIMIT = 3

/** `"A", "B" and 2 more` — enough to recognise, short enough for a banner. */
function quoteList(nodes: readonly StoryNode[]): string {
  const shown = nodes.slice(0, NAME_LIMIT).map((n) => `"${nodeLabel(n.code, n.title)}"`)
  const rest = nodes.length - shown.length
  if (rest > 0) shown.push(`${rest} more`)
  if (shown.length === 1) return shown[0]!
  return shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1]!
}

function strandedMessage(stranded: readonly StoryNode[]): string {
  const who =
    stranded.length === 1
      ? `"${nodeLabel(stranded[0]!.code, stranded[0]!.title)}" would no longer be reachable from the start`
      : `${stranded.length} passages would no longer be reachable from the start — ${quoteList(stranded)}`
  const fix = stranded.length === 1 ? 'Delete it too' : 'Delete them too'
  return `Delete refused: ${who}. ${fix}, or link to ${stranded.length === 1 ? 'it' : 'them'} from a passage that survives.`
}

function deletedMessage(impact: DeleteImpact): string {
  const what =
    impact.removed.length === 1
      ? `Deleted "${nodeLabel(impact.removed[0]!.code, impact.removed[0]!.title)}".`
      : `Deleted ${impact.removed.length} passages.`
  if (impact.dangling === 0) return what
  const links =
    impact.dangling === 1
      ? '1 link now points at nothing and shows as a dashed card.'
      : `${impact.dangling} links now point at nothing and show as dashed cards.`
  return `${what} ${links}`
}

/**
 * Delete a set of passages as one undo step, or refuse.
 *
 * A delete that would cut a surviving passage off from the start splits the
 * story into two trees, which is a bug rather than an edit — so it is refused
 * before anything is committed. Returns the refusal message, else null.
 */
function removeIds(ids: readonly string[]): string | null {
  const impact = impactOf(ids)
  if (!impact) return null
  if (impact.stranded.length > 0) {
    state.notice = strandedMessage(impact.stranded)
    return state.notice
  }
  commit(M.deleteNodes(state.doc, [...ids]))
  state.notice = deletedMessage(impact)
  pruneSelection()
  if (state.selectedId === null) select(state.doc.startNodeId)
  return null
}

/* ---------- passage edits ---------- */

/**
 * The author's inheritance preferences, in the shape the document layer takes.
 *
 * The single point where a preference crosses into `mutations.ts`, which is
 * pure and must never read app state for itself.
 */
function inheritance(): M.InheritOptions {
  return { setting: prefs.inheritSetting, characters: prefs.inheritCharacters }
}

export function addPassage(linkFrom?: string): string {
  // Named `source` rather than `parent`: the block below needs its own lookup
  // against the cloned document, and two bindings of the same name would be a
  // quiet way to read from the wrong one.
  const source = linkFrom ? (state.doc.nodes.find((n) => n.id === linkFrom) ?? null) : null
  const inherit = inheritance()
  const { doc: withNode, node } = M.createNode(state.doc, {
    title: 'Untitled Passage',
    setting: source && inherit.setting ? source.setting : '',
    characters: source && inherit.characters ? source.characters.map((c) => c.name) : [],
  })
  let next = withNode
  if (linkFrom) {
    const parent = next.nodes.find((n) => n.id === linkFrom)
    if (parent) {
      const gap = parent.body.length > 0 && !parent.body.endsWith('\n') ? '\n' : ''
      // Through `buildLink`, so the link is written the one way the app teaches:
      // display text on the left, the code that actually resolves on the right.
      next = M.setBody(next, linkFrom, parent.body + gap + buildLink(node.code, node.title))
    }
  }
  commit(next)
  select(node.id)
  return node.id
}

/** Returns the refusal message when the delete would strand a passage, else null. */
export function removePassage(id: string): string | null {
  return removeIds([id])
}

/** Delete everything currently selected, as one undo step. */
export function removeSelected(): string | null {
  return removeIds([...state.selectedIds])
}

/** Titles are cosmetic and repeatable, so a rename can never be refused. */
export function rename(id: string, title: string): void {
  commit(M.renameNode(state.doc, id, title))
}

export function editBody(id: string, body: string): void {
  commit(M.setBody(state.doc, id, body))
}

/**
 * Bind the links in a body once the author leaves the editor: create the
 * passages they name, and give bare links the code minted for them.
 *
 * Split from `editBody` because that fires on every keystroke. `bodyAtFocus` is
 * the body as it stood when the editor took focus — the only way to tell a link
 * the author just wrote from one that was already there and deliberately left
 * dangling. Lands as one undo step rather than one per keystroke.
 */
export function resolveBody(id: string, bodyAtFocus: string): void {
  commit(M.resolveLinks(state.doc, id, bodyAtFocus, inheritance()))
}

export function changeState(id: string, value: NodeState): void {
  commit(M.setState(state.doc, id, value))
}

export function changeLevelOffset(id: string, offset: number): void {
  commit(M.setLevelOffset(state.doc, id, offset))
}

export function makeStart(id: string): void {
  commit(M.setStartNode(state.doc, id))
}

export function renameStory(title: string): void {
  commit(M.setStoryTitle(state.doc, title))
}

/**
 * The story's scratchpad.
 *
 * Deliberately absent from `layoutKey` and from `searchableText`: nothing on
 * the canvas moves for it, and search filters passages, so a story-level hit
 * would have no card to light up.
 */
export function storyNotesSet(value: string): void {
  commit(M.setStoryNotes(state.doc, value))
}

/** Turn a dashed placeholder card into a real passage, and select it. */
export function createFromPhantom(phantomId: string): void {
  const phantom = layout.value.graph.phantoms.find((p) => p.id === phantomId)
  if (!phantom) return
  const next = M.materializePhantom(state.doc, phantom.code, phantom.label, inheritance())
  commit(next)
  select(next.nodes.find((n) => n.code === phantom.code)?.id ?? state.selectedId)
}

/* ---------- tags ---------- */

export function tagAdd(id: string, tag: string): void {
  commit(M.addTag(state.doc, id, tag))
}

export function tagRemove(id: string, tag: string): void {
  commit(M.removeTag(state.doc, id, tag))
}

export function tagRecolor(tag: string, color: TagColor): void {
  commit(M.setTagColor(state.doc, tag, color))
}

/** Returns an error message when the code is already taken, else null. */
export function codeSet(id: string, value: string): string | null {
  const { doc: next, error } = M.setCode(state.doc, id, value)
  if (error) return error
  commit(next)
  return null
}

/**
 * How many times a recode is re-planned against its own result.
 *
 * Padding makes a numbering a fixed point of its own layout, so an ordinary
 * recode settles on the first pass and the second only confirms it. A second
 * pass is still needed because applying can change the *graph*: a new code may
 * land on one a dangling link already names, which attaches that link and
 * redraws the tree the numbering was read from. Two such captures in a row are
 * conceivable; a third is not, and the budget fails soft either way — unsettled
 * codes are still unique and complete.
 */
const RECODE_PASSES = 3

export interface SettledRecode {
  /** Every passage: `from` is the code it has now, `to` the code it would end with. */
  entries: RecodeEntry[]
  /** How many codes actually move. */
  changed: number
  /** Dangling links the new codes would attach, as the tree stands today. */
  captures: string[]
  /** Blocks the apply, or null. */
  error: string | null
  /** The document this was settled from, so a stale result can be spotted. */
  base: StoryDoc
  /** The finished document. */
  doc: StoryDoc
  /**
   * The layout of `doc`, when settling had to build one anyway — null when it
   * did not, in which case `setDoc` computes it at commit time as usual.
   */
  layout: LayoutResult | null
}

/**
 * Run a recode to completion without installing it.
 *
 * Preview and apply share this so that the panel cannot show one answer and the
 * document receive another: the rows the author reads *are* the settled result,
 * not the first guess at it.
 *
 * The numbering is planned in `graph/recode.ts` rather than in `mutations.ts`,
 * which may not read layout: "the first passage on level 3" is a fact about the
 * drawing. The mutation receives a finished id -> code map and knows nothing
 * about levels.
 */
function settleRecode(options: RecodeOptions): SettledRecode {
  const base = state.doc
  const before = layout.value
  const origin = new Map(base.nodes.map((n) => [n.id, n.code]))

  let doc = base
  /** Always an ordering valid for `doc`; `fresh` says whether it is also its layout. */
  let result = before
  let fresh = true

  const refuse = (error: string): SettledRecode => ({
    entries: [], changed: 0, captures: [], error, base, doc: base, layout: null,
  })

  for (let pass = 0; pass < RECODE_PASSES; pass++) {
    const plan = planRecode(result, options)
    if (plan.error !== null) return refuse(plan.error)

    const { doc: next, error } = M.recodeAll(doc, plan.mapping)
    if (error !== null) return refuse(error)

    // The plan came back the identity: the numbering already matches the tree.
    if (next === doc) break
    doc = next
    fresh = false

    // Attaching a dangling link is the *only* way applying a plan can change the
    // graph — a code and every link naming it are rewritten together, so every
    // other edge survives untouched. With no capture the levels and the ordering
    // are exactly what they were, so `before` still orders `doc` correctly and
    // laying it out again would be a full Sugiyama pass per keystroke to confirm
    // what the padding already guarantees.
    if (plan.captures.length === 0) break

    // Deliberately not `setDoc`: these are trial layouts for a document that may
    // never be installed, and touching the memo key would leave it describing one.
    result = layoutStory(doc)
    fresh = true
  }

  const entries = readBack(result, doc, origin)
  return {
    entries,
    changed: entries.filter((e) => e.from !== e.to).length,
    captures: attached(before, doc),
    error: null,
    base,
    doc,
    layout: fresh ? result : null,
  }
}

/**
 * The preview rows, in drawing order, with `from` wound back to the code each
 * passage had before any of this — an intermediate was never on screen.
 *
 * `result` is the layout the ordering is read from; the codes come from `doc`,
 * which is what actually gets committed. Taking `to` from a fresh plan instead
 * would describe something else entirely if the pass loop ran out of passes.
 */
function readBack(
  result: LayoutResult,
  doc: StoryDoc,
  origin: ReadonlyMap<string, string>,
): RecodeEntry[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const out: RecodeEntry[] = []
  for (const n of drawingOrder(result)) {
    const node = byId.get(n.id)
    if (!node) continue
    out.push({
      id: n.id,
      from: origin.get(n.id) ?? node.code,
      to: node.code,
      title: node.title.length > 0 ? node.title : node.code,
      level: n.level,
    })
  }
  return out
}

/**
 * Which dangling links this recode attaches.
 *
 * Measured rather than predicted: the phantoms the tree has now, minus the ones
 * still dangling in the settled document. A plan's own `captures` only speaks
 * for the pass that produced it, so reporting the first pass's would under-warn
 * exactly when the loop ran more than once.
 *
 * Asking whether the code ended up on a real passage is not the same question
 * and gets it wrong: a passage that captured a link on one pass can be numbered
 * again on the next, so the code that did the capturing need not be the code it
 * finishes with. Whether the link still dangles is the thing the author cares
 * about, and it is directly observable.
 */
function attached(before: LayoutResult, doc: StoryDoc): string[] {
  const stillDangling = new Set(deriveGraph(doc).phantoms.map((p) => p.code))
  return before.nodes
    .filter((n) => n.isPhantom && !stillDangling.has(n.code))
    .map((n) => n.code)
    .sort(compareStr)
}

/** What a recode would do, settled, without writing anything. */
export function recodePreview(options: RecodeOptions): SettledRecode {
  return settleRecode(options)
}

/**
 * Recode every passage, as one undo step. Returns the refusal message, or null.
 *
 * `settled` is the panel's own preview, handed straight back so the work is not
 * done twice on one button press. It is checked against the current document
 * rather than trusted: the store is a singleton, and a result computed before
 * some other edit landed would write codes read off a tree that has since moved.
 */
export function codesRecode(options: RecodeOptions, settled?: SettledRecode): string | null {
  const plan = settled?.base === state.doc ? settled : settleRecode(options)
  if (plan.error !== null) return plan.error
  // One commit, so one Cmd Z takes the whole story back. Any layout the settle
  // already had to build is handed over rather than recomputed from scratch.
  commit(plan.doc, plan.layout ?? undefined)
  return null
}

/* ---------- token ---------- */

export function tokenSet(id: string, value: string): void {
  commit(M.setToken(state.doc, id, value))
}

/* ---------- scene: setting and cast ---------- */

export function settingSet(id: string, value: string): void {
  commit(M.setSetting(state.doc, id, value))
}

export function settingRename(from: string, to: string): void {
  commit(M.renameSetting(state.doc, from, to))
  const target = to.trim()
  const i = state.settingFilter.indexOf(from)
  if (i !== -1) state.settingFilter.splice(i, 1, target)
}

export function characterCreate(name: string): string | null {
  const { doc: next, error } = M.createCharacter(state.doc, name)
  if (error) return error
  commit(next)
  return null
}

export function characterRename(from: string, to: string): string | null {
  const { doc: next, error } = M.renameCharacter(state.doc, from, to)
  if (error) return error
  commit(next)
  const i = state.characterFilter.indexOf(from)
  if (i !== -1) state.characterFilter.splice(i, 1, to.trim())
  if (state.openCharacter === from) state.openCharacter = to.trim()
  return null
}

/**
 * Move a character up (-1) or down (+1) the roster.
 *
 * A move off either end changes nothing, and `commit` on an unchanged document
 * would still push an undo entry — so the no-op is filtered here.
 */
export function characterMove(name: string, delta: number): void {
  const next = M.moveCharacter(state.doc, name, delta)
  if (next !== state.doc) commit(next)
}

/** Alphabetize the roster, undoing any hand ordering. */
export function characterSortByName(): void {
  commit(M.sortCharacters(state.doc))
}

export function characterSetBio(name: string, note: string): void {
  commit(M.setCharacterBio(state.doc, name, note))
}

export function characterDelete(name: string): void {
  commit(M.deleteCharacter(state.doc, name))
  const i = state.characterFilter.indexOf(name)
  if (i !== -1) state.characterFilter.splice(i, 1)
  if (state.openCharacter === name) state.openCharacter = null
}

export function characterSetTrait(
  name: string,
  field: TraitField,
  points: readonly string[],
): void {
  commit(M.setCharacterTrait(state.doc, name, field, points))
}

export function relationAdd(name: string, to: string): string | null {
  const { doc: next, error } = M.addRelation(state.doc, name, to)
  if (error) return error
  commit(next)
  return null
}

export function relationSetPoints(name: string, to: string, points: readonly string[]): void {
  commit(M.setRelationPoints(state.doc, name, to, points))
}

export function relationRemove(name: string, to: string): void {
  commit(M.removeRelation(state.doc, name, to))
}

/* ---------- the character sheet ---------- */

export function openCharacterSheet(name: string): void {
  state.openCharacter = name
}

export function closeCharacterSheet(): void {
  state.openCharacter = null
}

/** Who regards this character, for the read-only reverse direction on the sheet. */
export function relationsToward(name: string) {
  return M.relationsToward(state.doc, name)
}

export function castAdd(id: string, name: string): void {
  commit(M.addPassageCharacter(state.doc, id, name))
}

/** Create a roster entry and put them in this passage in one undo step. */
export function castCreateAndAdd(id: string, rawName: string): string | null {
  const { doc: withCharacter, error } = M.createCharacter(state.doc, rawName)
  if (error) return error
  commit(M.addPassageCharacter(withCharacter, id, rawName.trim()))
  return null
}

export function castRemove(id: string, name: string): void {
  commit(M.removePassageCharacter(state.doc, id, name))
}

export function castSetNote(id: string, name: string, note: string): void {
  commit(M.setPassageCharacterNote(state.doc, id, name, note))
}

/* ---------- derived ---------- */

export const doc = computed(() => state.doc)

export const selected = computed(
  () => state.doc.nodes.find((n) => n.id === state.selectedId) ?? null,
)

export const selectedLayout = computed(() =>
  state.selectedId ? (layout.value.nodeById.get(state.selectedId) ?? null) : null,
)

/** Membership test for the canvas and the minimap. */
export const selectedIdSet = computed(() => new Set(state.selectedIds))

/** The selection as passages, canonical order, ids the document lost dropped. */
export const selectedNodes = computed(() =>
  state.doc.nodes.filter((n) => state.selectedIds.includes(n.id)).sort(compareNodes),
)

export const tags = computed(() => M.allTags(state.doc))
export const tagColors = computed(() => M.tagColorMap(state.doc))

/** The cast roster itself, for the picker. */
export const roster = computed(() => state.doc.characters)
export const characterMap = computed(() => M.characterMap(state.doc))
/** Distinct settings and characters with passage counts, for the story index. */
export const settingUsage = computed(() => M.settingUsage(state.doc))
export const characterUsage = computed(() => M.characterUsage(state.doc))
export const settingSuggestions = computed(() => M.allSettings(state.doc))

/** The parent that pins the selected passage to its current floor, if any. */
export const blockingParent = computed(() => {
  const id = state.selectedId
  if (!id) return null
  const me = layout.value.nodeById.get(id)
  if (!me) return null
  const g = layout.value.graph
  for (const eid of g.inAdj.get(id) ?? []) {
    const parent = layout.value.nodeById.get(g.edgeById.get(eid)!.sourceId)
    if (parent && parent.level + 1 === me.minLevel) return parent
  }
  return null
})

/**
 * Reuses the graph `layoutStory` already derived.
 *
 * Safe because `layoutKey` memoizes layout on exactly the fields the graph is
 * built from — titles, bodies, ids and the start node — so whenever any of them
 * changes, `layout` has already been recomputed. Re-deriving here would parse
 * every passage body a second and third time on every keystroke, since the
 * toolbar and the inspector both read this.
 */
export function pathsFrom(id: string): bigint {
  const { graph, backEdges } = layout.value
  return countPaths(graph, backEdges, id)
}

let lastGateKey = ''
let lastGates = new Map<string, GateEntry>()

/**
 * What the story's `(if:)` macros say about which routes exist.
 *
 * Deliberately not part of `layoutStory`: a gate moves nothing on the canvas,
 * and the macro read is only wanted when something asks. Same reasoning as
 * `pathsFrom`, and safe for the same reason — layout is memoized on exactly the
 * fields the graph is built from, so the graph it retains is never stale.
 *
 * Memoized on `layoutVersion` alone, because this reads `state.doc`, which
 * *every* edit replaces. Without the key a tag edit — which reaches no macro —
 * would re-parse every body in the story. No reset is needed on a new story:
 * `layoutVersion` only ever increments, so a stale key cannot be matched again.
 */
export const gates = computed(() => {
  const key = String(layoutVersion.value)
  if (key === lastGateKey) return lastGates
  lastGateKey = key

  const { graph, backEdges, nodeById } = layout.value
  const { guardOf, assignersOf, opaqueVars } = readStoryMacros(state.doc.nodes)

  // Memoized per gate: a story has few gates and they are asked about
  // repeatedly, once per passage the gate covers.
  const reach = new Map<string, Set<string>>()
  const isAncestor = (gate: string, node: string): boolean => {
    let seen = reach.get(gate)
    if (!seen) {
      seen = reachableFrom(graph, gate)
      reach.set(gate, seen)
    }
    return seen.has(node)
  }

  lastGates = gatesOf(graph, {
    backEdges,
    levelOf: new Map(graph.ids.map((id) => [id, nodeById.get(id)?.level ?? 1])),
    guardOf,
    assignersOf,
    opaqueVars,
    isAncestor,
  })
  return lastGates
})

/**
 * What the macros say about the selected passage.
 *
 * `gate` is the passage every route here provably passes; `dead` means no route
 * can satisfy its condition at all. Both are inferences the author never asked
 * for and cannot see in the body, so the inspector shows them rather than
 * quietly acting on them.
 */
export const selectedGate = computed<{ gate: StoryNode | null; dead: boolean }>(() => {
  const id = state.selectedId
  const entry = id ? gates.value.get(id) : undefined
  if (!entry) return { gate: null, dead: false }
  return {
    gate: entry.gateId ? (state.doc.nodes.find((n) => n.id === entry.gateId) ?? null) : null,
    dead: entry.dead,
  }
})

/**
 * Everything free-text search looks at. Setting, cast names and scene notes are
 * included so typing a character's name finds their scenes, the note so a passage
 * can be found by what you wrote about it, and the code so a partial code still
 * turns something up when it is not an exact hit.
 */
function searchableText(n: StoryNode): string {
  return [
    n.title,
    n.code,
    n.token,
    n.body,
    n.setting,
    ...n.characters.map((c) => c.name + ' ' + c.note),
  ].join('\n')
}

/** Which passages currently match the search box and filter chips. */
export const matches = computed((): Set<string> | null => {
  const q = state.search.trim().toLowerCase()
  const filtering =
    q.length > 0 ||
    state.tagFilter.length > 0 ||
    state.stateFilter.length > 0 ||
    state.settingFilter.length > 0 ||
    state.characterFilter.length > 0
  if (!filtering) return null

  // A code is an exact handle, so typing one means "this passage" and nothing
  // else. Without this a short code like "a3" would also drag in every passage
  // whose prose happens to contain those letters, burying the one you asked for.
  //
  // Matched against the raw query, so this only fires on the exact code. Typing
  // `a3` when the code is `A3` falls through to the folded prose search below and
  // still finds it — links have to be exact, but a search box does not.
  const raw = state.search.trim()
  const exactCode = raw.length > 0 && state.doc.nodes.some((n) => n.code === raw)

  const out = new Set<string>()
  for (const n of state.doc.nodes) {
    if (q.length > 0) {
      const hit = exactCode ? n.code === raw : searchableText(n).toLowerCase().includes(q)
      if (!hit) continue
    }
    if (state.tagFilter.length > 0 && !state.tagFilter.some((t) => n.tags.includes(t))) continue
    if (state.stateFilter.length > 0 && !state.stateFilter.includes(n.state)) continue
    if (state.settingFilter.length > 0 && !state.settingFilter.includes(n.setting)) continue
    if (
      state.characterFilter.length > 0 &&
      !state.characterFilter.some((name) => n.characters.some((c) => c.name === name))
    ) {
      continue
    }
    out.add(n.id)
  }
  return out
})

/** Clear every filter dimension at once; used by the filter bar and the index. */
export function clearFilters(): void {
  state.search = ''
  state.tagFilter = []
  state.stateFilter = []
  state.settingFilter = []
  state.characterFilter = []
}

export const filtering = computed(
  () =>
    // Must use the same predicate as `matches`, or the UI offers a "clear
    // filters" control while nothing is actually filtered.
    state.search.trim().length > 0 ||
    state.tagFilter.length > 0 ||
    state.stateFilter.length > 0 ||
    state.settingFilter.length > 0 ||
    state.characterFilter.length > 0,
)

/** Toggle a value in one of the list filters. */
export function toggleFilter(
  which: 'tagFilter' | 'settingFilter' | 'characterFilter',
  value: string,
): void {
  const list = state[which]
  const i = list.indexOf(value)
  if (i === -1) list.push(value)
  else list.splice(i, 1)
}

export const storyJson = computed(() => serializeDoc(state.doc))
export const canUndo = computed(() => undoStack.length > 0)
export const canRedo = computed(() => redoStack.length > 0)

export { state, layout, layoutVersion }
export type { SavedMeta }
