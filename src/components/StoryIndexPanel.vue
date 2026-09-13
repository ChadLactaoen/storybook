<script setup lang="ts">
import { computed, ref } from 'vue'
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

function move(name: string, delta: number) {
  pendingDelete.value = null
  store.characterMove(name, delta)
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
          <button
            v-if="characters.length > 1 && !alphabetical"
            class="mini"
            title="Put the cast back in alphabetical order"
            @click="store.characterSortByName()"
          >
            Sort A&ndash;Z
          </button>
        </div>

        <ul v-if="characters.length > 0" class="rows">
          <li
            v-for="(entry, index) in characters"
            :key="entry.value"
            class="row"
            :class="{ on: store.state.characterFilter.includes(entry.value) }"
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
                <span class="reorder">
                  <button
                    class="arrow"
                    title="Move up"
                    :disabled="index === 0"
                    @click="move(entry.value, -1)"
                  >
                    &#9650;
                  </button>
                  <button
                    class="arrow"
                    title="Move down"
                    :disabled="index === characters.length - 1"
                    @click="move(entry.value, 1)"
                  >
                    &#9660;
                  </button>
                </span>
                <button
                  class="value"
                  :title="`Show only passages with ${entry.value}`"
                  @click="store.toggleFilter('characterFilter', entry.value)"
                >
                  {{ entry.value }}
                </button>
                <span class="count" :class="{ zero: entry.count === 0 }">
                  {{ entry.count }}
                </span>
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
          </li>
        </ul>
        <p v-else class="empty">No characters yet.</p>

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
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row {
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

/* A two-arrow stack, kept the height of the row it reorders. */
.reorder {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  margin-left: -2px;
}

.arrow {
  padding: 0 3px;
  border: 0;
  border-radius: 3px;
  background: none;
  font-size: 8px;
  line-height: 10px;
  color: var(--text-faint);
}

.arrow:hover:not(:disabled) {
  background: var(--bg);
  color: var(--accent);
}

.arrow:disabled {
  opacity: 0.25;
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
