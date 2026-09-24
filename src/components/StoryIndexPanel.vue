<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import * as store from '../stores/story'
import { TRAIT_FIELDS } from '../types/story'

const emit = defineEmits<{ close: [] }>()

type Kind = 'character' | 'setting'

const newCharacter = ref('')
const createError = ref<string | null>(null)

/** Whichever row is currently being renamed, plus its draft text. */
const editing = ref<{ kind: Kind; value: string } | null>(null)
const draft = ref('')
const renameError = ref<string | null>(null)

/** The character a delete confirmation is pending for. */
const pendingDelete = ref<string | null>(null)

const settings = store.settingUsage
const characters = store.characterUsage
const entries = store.characterMap

function create() {
  const name = newCharacter.value.trim()
  if (name.length === 0) return
  createError.value = store.characterCreate(name)
  if (!createError.value) newCharacter.value = ''
}

function startRename(kind: Kind, value: string) {
  editing.value = { kind, value }
  draft.value = value
  renameError.value = null
  pendingDelete.value = null
}

function commitRename() {
  const target = editing.value
  if (!target) return
  const next = draft.value.trim()
  if (next === target.value) {
    editing.value = null
    return
  }
  if (target.kind === 'character') {
    renameError.value = store.characterRename(target.value, next)
    if (renameError.value) return
  } else {
    store.settingRename(target.value, next)
  }
  editing.value = null
  renameError.value = null
}

function cancelRename() {
  editing.value = null
  renameError.value = null
}

function isEditing(kind: Kind, value: string) {
  return editing.value?.kind === kind && editing.value.value === value
}

/** Read out after a move, since nothing else tells a screen reader where the row went. */
const announcement = ref('')

function move(name: string, delta: number) {
  pendingDelete.value = null
  const before = store.state.doc
  store.characterMove(name, delta)
  if (store.state.doc === before) return
  const at = characters.value.findIndex((c) => c.value === name)
  announcement.value = `${name} moved to position ${at + 1} of ${characters.value.length}.`
}

/**
 * A private type rather than `text/plain`: a row dropped on the body editor
 * would otherwise paste its name. Firefox refuses to start a drag carrying no
 * data at all, so something has to be set.
 */
const DRAG_TYPE = 'application/x-storyboard-character'

/** The character being dragged, and the slot (0..n) it would land in. */
const dragging = ref<string | null>(null)
const dropAt = ref<number | null>(null)

const dragFrom = computed(() => characters.value.findIndex((c) => c.value === dragging.value))

/** A slot either side of the dragged row puts it back where it was, so no line. */
const dropMoves = computed(
  () => dropAt.value !== null && dropAt.value !== dragFrom.value && dropAt.value !== dragFrom.value + 1,
)

function dragStart(e: DragEvent, name: string) {
  pendingDelete.value = null
  dragging.value = name
  const dt = e.dataTransfer
  if (!dt) return
  dt.setData(DRAG_TYPE, name)
  dt.effectAllowed = 'move'
  // The handle alone makes a meaningless ghost; carry the whole row.
  const row = e.target instanceof Element ? e.target.closest('li') : null
  if (row) dt.setDragImage(row, 12, 12)
}

const list = ref<HTMLElement | null>(null)

/**
 * The slot (0..n) a drop at `clientY` lands in: before the first row whose
 * midpoint is below the pointer, or after the last.
 *
 * Read off the rows' boxes rather than the event's target, so the gap between
 * two rows has an answer too — and so does a row's text, which Firefox can
 * hand over as the target in place of an element.
 */
function slotAt(clientY: number): number {
  const rows = Array.from(list.value?.children ?? [])
  const i = rows.findIndex((row) => {
    const rect = row.getBoundingClientRect()
    return clientY < rect.top + rect.height / 2
  })
  return i === -1 ? rows.length : i
}

/**
 * Bound to `dragenter` as well: the spec accepts a drop target when that event
 * is cancelled, and a quick flick can be released before any `dragover`.
 */
function dragOver(e: DragEvent) {
  // Anything not started here — a file, a selection — passes through.
  if (dragging.value === null) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropAt.value = slotAt(e.clientY)
}

/**
 * Out of the list, a drop does nothing, so the line has to go. Moving between
 * a row and its own children leaves too; `relatedTarget` says where to, and a
 * browser that leaves it empty is put right by the next `dragover`.
 */
function dragLeave(e: DragEvent) {
  if (dragging.value === null) return
  const to = e.relatedTarget
  if (to instanceof Node && list.value?.contains(to)) return
  dropAt.value = null
}

function drop(e: DragEvent) {
  if (dragging.value === null) return
  e.preventDefault()
  const at = slotAt(e.clientY)
  const from = dragFrom.value
  if (from !== -1) move(dragging.value, (at > from ? at - 1 : at) - from)
  // Firefox can skip `dragend` when the dragged element moves during the drop,
  // which this one just has — so the drop cleans up for itself as well.
  dragEnd()
}

/** The cleanup for a cancelled drag, and a second, harmless one after a drop. */
function dragEnd() {
  dragging.value = null
  dropAt.value = null
}

/** Arrow keys on a focused handle: the drag without a pointer. */
async function nudge(name: string, delta: number) {
  move(name, delta)
  // Vue may reorder by moving this row's element, which drops its focus.
  await nextTick()
  const grips = Array.from(list.value?.querySelectorAll<HTMLElement>('.grip') ?? [])
  grips.find((g) => g.dataset.name === name)?.focus()
}

/** Names only: a long cast fits on screen, for dragging it into order. */
const compact = computed(() => store.state.compactCast)

function toggleCompact() {
  // A pending confirmation would vanish with the rest of the card, and turn up
  // again unasked whenever the cards came back.
  pendingDelete.value = null
  store.setCompactCast(!store.state.compactCast)
}

/** True when the roster is already alphabetical, so offering the sort is pointless. */
const alphabetical = computed(() =>
  characters.value.every((c, i) => i === 0 || characters.value[i - 1]!.value <= c.value),
)

function confirmDelete(name: string) {
  store.characterDelete(name)
  pendingDelete.value = null
}

const deleteCount = computed(
  () => characters.value.find((c) => c.value === pendingDelete.value)?.count ?? 0,
)

const isFiltering = store.filtering

/** A one-line "what's filled in" summary, so the list still says something. */
function profileSummary(name: string): string {
  const entry = entries.value.get(name)
  if (!entry) return ''
  // The bare field name, not the full label: "1 dialogue characteristics"
  // reads badly, and this line is a density cue rather than prose.
  const parts: string[] = []
  for (const field of TRAIT_FIELDS) {
    if (entry[field].length > 0) parts.push(`${entry[field].length} ${field}`)
  }
  const related = entry.relations.filter((r) => r.points.length > 0).length
  if (related > 0) parts.push(`${related} relation${related === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
</script>

<template>
  <aside class="index">
    <header>
      <span class="eyebrow">Story index</span>
      <div class="head-actions">
        <button v-if="isFiltering" class="btn btn-ghost clear" @click="store.clearFilters()">
          Clear filters
        </button>
        <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
      </div>
    </header>

    <div class="scroll">
      <section>
        <div class="section-head">
          <span class="label">Cast &middot; {{ characters.length }}</span>
          <!-- Compact last, so it holds still while Sort comes and goes. -->
          <span class="section-actions">
            <button
              v-if="characters.length > 1 && !alphabetical"
              class="mini"
              title="Put the cast back in alphabetical order"
              @click="store.characterSortByName()"
            >
              Sort A&ndash;Z
            </button>
            <button
              v-if="characters.length > 0"
              class="mini"
              :class="{ on: compact }"
              :aria-pressed="compact"
              :title="compact ? 'Show each character in full' : 'Show names only, to fit more of the cast'"
              @click="toggleCompact"
            >
              Compact
            </button>
          </span>
        </div>

        <ul
          v-if="characters.length > 0"
          ref="list"
          class="rows cast"
          :class="{ compact, 'drop-end': dropMoves && dropAt === characters.length }"
          @dragenter="dragOver"
          @dragover="dragOver"
          @dragleave="dragLeave"
          @drop="drop"
        >
          <li
            v-for="(entry, index) in characters"
            :key="entry.value"
            class="row"
            :data-index="index"
            :class="{
              on: store.state.characterFilter.includes(entry.value),
              dragging: dragging === entry.value,
              'drop-before': dropMoves && dropAt === index,
            }"
          >
            <template v-if="isEditing('character', entry.value)">
              <input
                v-model="draft"
                class="field"
                :class="{ 'field-error': renameError }"
                autofocus
                @keydown.enter.prevent="commitRename"
                @keydown.esc="cancelRename"
                @blur="commitRename"
              />
              <p v-if="renameError" class="hint hint-error">{{ renameError }}</p>
            </template>

            <template v-else>
              <div class="row-head">
                <!-- A span, not a button: Firefox will not start a drag from a
                     button. The handle alone is draggable so the rest of the
                     row keeps its clicks and its text selection. -->
                <span
                  class="grip"
                  role="button"
                  draggable="true"
                  tabindex="0"
                  :data-name="entry.value"
                  :aria-label="`Reorder ${entry.value}`"
                  aria-describedby="cast-reorder-hint"
                  title="Drag to reorder (or focus and press ↑ ↓)"
                  @dragstart="dragStart($event, entry.value)"
                  @dragend="dragEnd"
                  @keydown.up.prevent="nudge(entry.value, -1)"
                  @keydown.down.prevent="nudge(entry.value, 1)"
                >
                  &#10303;
                </span>
                <button
                  class="value name"
                  :title="`Show only passages with ${entry.value}`"
                  @click="store.toggleFilter('characterFilter', entry.value)"
                >
                  {{ entry.value }}
                </button>
                <span v-if="!compact" class="count" :class="{ zero: entry.count === 0 }">
                  {{ entry.count }}
                </span>
              </div>

              <template v-if="!compact">
                <!-- On a line of their own, so a long name has the whole width. -->
                <div class="actions">
                  <button
                    class="mini"
                    title="Open the character sheet"
                    @click="store.openCharacterSheet(entry.value)"
                  >
                    Open
                  </button>
                  <button class="mini" title="Rename everywhere" @click="startRename('character', entry.value)">
                    Rename
                  </button>
                  <button class="mini danger" title="Remove from the story" @click="pendingDelete = entry.value">
                    Delete
                  </button>
                  <!-- Real buttons beside the handle: a touch screen may never
                       start a native drag, and a screen reader in browse mode
                       keeps the arrow keys for itself. -->
                  <span class="arrows">
                    <button
                      class="mini arrow"
                      title="Move up"
                      :aria-label="`Move ${entry.value} up`"
                      :disabled="index === 0"
                      @click="move(entry.value, -1)"
                    >
                      &#9650;
                    </button>
                    <button
                      class="mini arrow"
                      title="Move down"
                      :aria-label="`Move ${entry.value} down`"
                      :disabled="index === characters.length - 1"
                      @click="move(entry.value, 1)"
                    >
                      &#9660;
                    </button>
                  </span>
                </div>

                <p class="bio" @click="store.openCharacterSheet(entry.value)">
                  <template v-if="entries.get(entry.value)?.note">
                    {{ entries.get(entry.value)!.note }}
                  </template>
                  <em v-else>No description yet.</em>
                </p>

                <p v-if="profileSummary(entry.value)" class="profile">
                  {{ profileSummary(entry.value) }}
                </p>

                <div v-if="pendingDelete === entry.value" class="confirm">
                  <span>
                    <template v-if="deleteCount > 0">
                      {{ entry.value }} appears in {{ deleteCount }}
                      {{ deleteCount === 1 ? 'passage' : 'passages' }}. Remove from all of them?
                    </template>
                    <template v-else>Remove {{ entry.value }} from the story?</template>
                  </span>
                  <button class="btn btn-icon" title="Cancel" @click="pendingDelete = null">&times;</button>
                  <button class="btn danger" @click="confirmDelete(entry.value)">Remove</button>
                </div>
              </template>
            </template>
          </li>
        </ul>
        <p v-else class="empty">No characters yet.</p>
        <p id="cast-reorder-hint" class="sr-only">Drag to reorder, or press the up and down arrow keys.</p>
        <p class="sr-only" aria-live="polite">{{ announcement }}</p>

        <div class="add">
          <input
            v-model="newCharacter"
            class="field"
            :class="{ 'field-error': createError }"
            placeholder="New character…"
            @keydown.enter.prevent="create"
          />
          <button class="btn" @click="create">Add</button>
        </div>
        <p v-if="createError" class="hint hint-error">{{ createError }}</p>
      </section>

      <section>
        <span class="label">Settings &middot; {{ settings.length }}</span>

        <ul v-if="settings.length > 0" class="rows">
          <li
            v-for="entry in settings"
            :key="entry.value"
            class="row"
            :class="{ on: store.state.settingFilter.includes(entry.value) }"
          >
            <input
              v-if="isEditing('setting', entry.value)"
              v-model="draft"
              class="field"
              autofocus
              @keydown.enter.prevent="commitRename"
              @keydown.esc="cancelRename"
              @blur="commitRename"
            />
            <div v-else class="row-head">
              <button
                class="value"
                :title="`Show only passages set in ${entry.value}`"
                @click="store.toggleFilter('settingFilter', entry.value)"
              >
                {{ entry.value }}
              </button>
              <span class="count">{{ entry.count }}</span>
              <button class="mini" title="Rename everywhere" @click="startRename('setting', entry.value)">
                Rename
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="empty">No settings yet. Add one from a passage.</p>
      </section>
    </div>
  </aside>
</template>

<style scoped>
/* Width and the gutter's right edge belong to .left-gutter in App.vue. This
   panel only says how it fills the share of height it is handed — `min-height:
   0` so .scroll scrolls inside that share instead of growing past it and
   squeezing whatever is stacked below. */
.index {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  background: var(--panel-alt);
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--toolbar-h);
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.clear {
  font-size: 11px;
  color: var(--accent);
}

.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.rows {
  --gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}

/* Where the name starts: the grip's 14px, less its -2px margin, plus the gap.
   The action row lines up under it. */
.cast {
  --name-inset: 18px;
  /* From a row's outer edge to the far edge of a 2px line centred in the gap. */
  --line-reach: calc(var(--gap) / 2 + 1px);
  position: relative;
}

.cast.compact {
  --gap: 3px;
}

.cast.compact .row {
  padding: 4px 8px;
}

.row {
  position: relative;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}

.row.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.row-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Baseline, so the count stays on the name's first line when it wraps. */
.cast .row-head {
  align-items: baseline;
}

.value {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  font-weight: 600;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A character's name wraps rather than truncating: with the actions on their
   own line it has the width to, and a cut-off name is the one thing on the
   card that cannot be read anywhere else in the panel. */
.value.name {
  white-space: normal;
  overflow-wrap: anywhere;
}

.value:hover {
  color: var(--accent);
}

.count {
  min-width: 22px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.count.zero {
  color: var(--text-faint);
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}

.section-actions {
  display: flex;
  gap: 2px;
}

.grip {
  flex: 0 0 auto;
  width: 14px;
  margin-left: -2px;
  padding: 1px 0;
  text-align: center;
  border-radius: 3px;
  font-size: 12px;
  line-height: 1;
  color: var(--text-faint);
  cursor: grab;
  user-select: none;
}

.grip:hover,
.grip:focus-visible {
  background: var(--bg);
  color: var(--accent);
}

.grip:active {
  cursor: grabbing;
}

.row.dragging {
  opacity: 0.4;
}

/* The insertion line sits in the gap between rows, so nothing shifts under
   the pointer while it moves. Before a row it hangs off that row, past its 1px
   border; after the last it hangs off the list, which has none. */
.row.drop-before::before,
.cast.drop-end::after {
  content: '';
  position: absolute;
  left: -1px;
  right: -1px;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
}

.row.drop-before::before {
  top: calc(-1px - var(--line-reach));
}

.cast.drop-end::after {
  left: 0;
  right: 0;
  bottom: calc(-1 * var(--line-reach));
}

/* Above the bio, under the name, with the first button's padding pulled back
   so its label starts where the name does. */
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin: 3px 0 0 calc(var(--name-inset) - 5px);
}

.mini {
  padding: 1px 5px;
  border: 0;
  border-radius: 4px;
  background: none;
  font-size: 11px;
  color: var(--text-dim);
}

.mini:hover {
  background: var(--bg);
  color: var(--text);
}

.mini.danger:hover {
  color: var(--todo);
}

.mini.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.arrows {
  display: flex;
  gap: 2px;
  margin-left: auto;
}

.mini.arrow {
  font-size: 9px;
}

.mini.arrow:disabled {
  opacity: 0.25;
  background: none;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.bio {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--text-dim);
  cursor: pointer;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.bio:hover {
  color: var(--accent);
}

.bio em {
  color: var(--text-faint);
}

.profile {
  margin: 4px 0 0;
  font-size: 10.5px;
  color: var(--text-faint);
}

.confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
  padding: 7px 8px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--todo) 12%, transparent);
  font-size: 11px;
}

.confirm span {
  flex: 1;
}

.danger:hover:not(:disabled) {
  border-color: var(--todo);
  color: var(--todo);
}

.add {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.add .field {
  flex: 1;
}

.empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
