import { computed, markRaw, reactive, shallowRef, watch } from 'vue'
import { exportDoc, importDoc } from '../lib/doc/file'
import * as M from '../lib/doc/mutations'
import { serializeDoc } from '../lib/doc/serialize'
import { clearLocal, loadLocal, localMeta, saveLocal } from '../lib/doc/storage'
import type { SavedMeta } from '../lib/doc/storage'
import { fnv1a } from '../lib/graph/hash'
import { layoutStory } from '../lib/graph/layout'
import { countPaths } from '../lib/graph/paths'
import type { LayoutResult } from '../lib/graph/types'
import type { NodeState, StoryDoc, StoryNode, TagColor, TraitField } from '../types/story'
import { emptyDoc } from '../types/story'

const HISTORY_LIMIT = 100

interface State {
  doc: StoryDoc
  selectedId: string | null
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
 * Memoize on the inputs layout actually depends on. Editing a title, a tag or a
 * state is a large share of real editing and leaves the geometry untouched, so
 * those edits become pure re-renders.
 */
let lastLayoutKey = ''

function layoutKey(doc: StoryDoc): string {
  const parts = doc.nodes.map((n) => [n.id, n.title, n.levelOffset, n.body].join(' '))
  parts.push(String(doc.startNodeId))
  return fnv1a(parts.join('|'))
}

/**
 * Install a new document and bring layout with it, synchronously.
 *
 * Deliberately not done in a watcher: a Vue watcher flushes on the next tick,
 * which would leave `layout` describing the previous document for anyone who
 * reads it in the same turn as an edit.
 */
function setDoc(next: StoryDoc): void {
  state.doc = next
  const key = layoutKey(next)
  if (key === lastLayoutKey) return
  lastLayoutKey = key
  layout.value = markRaw(layoutStory(next))
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

function commit(next: StoryDoc): void {
  if (next === state.doc) return
  undoStack.push(state.doc)
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
  redoStack.length = 0
  setDoc(next)
}

export function undo(): void {
  const prev = undoStack.pop()
  if (!prev) return
  redoStack.push(state.doc)
  setDoc(prev)
  dropDanglingSheet()
}

export function redo(): void {
  const next = redoStack.pop()
  if (!next) return
  undoStack.push(state.doc)
  setDoc(next)
  dropDanglingSheet()
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

const STARTER_BODY = [
  'Your story begins here.',
  '',
  'Write a link like [[Head north->North Road]] to branch.',
].join('\n')

export function newStory(title = 'Untitled Story'): void {
  const { doc, node } = M.createNode(M.setStoryTitle(emptyDoc(), title), {
    title: 'Start',
    body: STARTER_BODY,
  })
  resetViewState()
  setDoc(doc)
  state.selectedId = node.id
  state.started = true
  state.savedAt = saveLocal(doc)?.savedAt ?? null
}

export function resumeStory(): boolean {
  const loaded = loadLocal()
  if (!loaded) return false
  resetViewState()
  setDoc(loaded)
  state.selectedId = loaded.startNodeId ?? loaded.nodes[0]?.id ?? null
  state.started = true
  state.savedAt = localMeta()?.savedAt ?? null
  return true
}

export function loadStory(json: string): void {
  const { doc: loaded, warnings } = importDoc(json)
  resetViewState()
  setDoc(loaded)
  state.selectedId = loaded.startNodeId ?? loaded.nodes[0]?.id ?? null
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
  state.selectedId = null
  resetViewState()
  lastLayoutKey = ''
  setDoc(emptyDoc())
}

/* ---------- selection ---------- */

export function select(id: string | null): void {
  state.selectedId = id
}

/* ---------- passage edits ---------- */

export function addPassage(linkFrom?: string): string {
  const parentSetting = linkFrom
    ? (state.doc.nodes.find((n) => n.id === linkFrom)?.setting ?? '')
    : ''
  const { doc: withNode, node } = M.createNode(state.doc, {
    title: 'Untitled Passage',
    setting: parentSetting,
  })
  let next = withNode
  if (linkFrom) {
    const parent = next.nodes.find((n) => n.id === linkFrom)
    if (parent) {
      const gap = parent.body.length > 0 && !parent.body.endsWith('\n') ? '\n' : ''
      next = M.setBody(next, linkFrom, parent.body + gap + '[[' + node.title + ']]')
    }
  }
  commit(next)
  state.selectedId = node.id
  return node.id
}

export function removePassage(id: string): void {
  commit(M.deleteNode(state.doc, id))
  if (state.selectedId === id) state.selectedId = state.doc.startNodeId
}

export function rename(id: string, title: string): string | null {
  const { doc: next, error } = M.renameNode(state.doc, id, title)
  if (error) return error
  commit(next)
  return null
}

export function editBody(id: string, body: string): void {
  commit(M.setBody(state.doc, id, body))
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

export function createFromPhantom(title: string): void {
  const next = M.materializePhantom(state.doc, title)
  commit(next)
  state.selectedId = next.nodes.find((n) => n.title === title)?.id ?? state.selectedId
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

/**
 * Everything free-text search looks at. Setting, cast names and scene notes are
 * included so typing a character's name finds their scenes, and the code so a
 * partial code still turns something up when it is not an exact hit.
 */
function searchableText(n: StoryNode): string {
  return [
    n.title,
    n.code,
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
  const exactCode = q.length > 0 && state.doc.nodes.some((n) => n.code.toLowerCase() === q)

  const out = new Set<string>()
  for (const n of state.doc.nodes) {
    if (q.length > 0) {
      const hit = exactCode
        ? n.code.toLowerCase() === q
        : searchableText(n).toLowerCase().includes(q)
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
