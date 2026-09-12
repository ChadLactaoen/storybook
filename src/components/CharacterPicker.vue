<script setup lang="ts">
import { computed, ref } from 'vue'
import * as store from '../stores/story'
import type { CharacterEntry, SceneCharacter } from '../types/story'
import { TRAIT_FIELDS, TRAIT_LABELS } from '../types/story'

const props = defineProps<{
  /** This passage's cast. */
  cast: SceneCharacter[]
  /** The story-global roster — the only valid source of names. */
  roster: CharacterEntry[]
}>()

const emit = defineEmits<{
  add: [name: string]
  create: [name: string]
  remove: [name: string]
  note: [name: string, note: string]
}>()

const draft = ref('')
const open = ref(false)
const error = ref<string | null>(null)

/**
 * Only roster members are offered. Someone not on the roster can still be
 * created inline, which registers them story-wide first and then casts them —
 * the same move TagPicker makes, and it keeps the invariant intact.
 */
const available = computed(() => {
  const cast = new Set(props.cast.map((c) => c.name))
  const q = draft.value.trim().toLowerCase()
  return props.roster.filter(
    (c) => !cast.has(c.name) && (q.length === 0 || c.name.toLowerCase().includes(q)),
  )
})

const canCreate = computed(() => {
  const name = draft.value.trim()
  return name.length > 0 && !props.roster.some((c) => c.name === name)
})

const entries = computed(() => new Map(props.roster.map((c) => [c.name, c])))

/** Who else is in this scene — relations toward them are the relevant ones. */
const present = computed(() => new Set(props.cast.map((c) => c.name)))

const expanded = ref<string | null>(null)
const showAllRelations = ref<Set<string>>(new Set())

function toggle(name: string) {
  expanded.value = expanded.value === name ? null : name
}

function toggleAllRelations(name: string) {
  const next = new Set(showAllRelations.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  showAllRelations.value = next
}

/**
 * Everything the expanded row renders, computed once.
 *
 * Only one member is ever expanded, and the template reads these values half a
 * dozen times per render, so deriving them per-read would redo the same
 * filtering on every keystroke in the scene-note field.
 */
const direction = computed(() => {
  const name = expanded.value
  const entry = name === null ? undefined : entries.value.get(name)
  if (!entry || name === null) {
    return { traits: [], shown: [], hidden: 0, empty: true, showingAll: false }
  }

  const traits = TRAIT_FIELDS.filter((f) => entry[f].length > 0).map((f) => ({
    field: f,
    label: TRAIT_LABELS[f],
    points: entry[f],
  }))

  const all = entry.relations.filter((r) => r.points.length > 0)
  const showingAll = showAllRelations.value.has(name)
  const shown = showingAll ? all : all.filter((r) => present.value.has(r.to))

  return {
    traits,
    shown,
    hidden: all.length - shown.length,
    empty: traits.length === 0 && shown.length === 0,
    showingAll,
  }
})

function add(name: string) {
  error.value = null
  emit('add', name)
  reset()
}

function create() {
  const name = draft.value.trim()
  if (name.length === 0) return
  const onRoster = props.roster.find((c) => c.name === name)
  if (onRoster) {
    add(name)
    return
  }
  error.value = null
  // The parent handles this synchronously and reports failure through
  // setError, so clearing the field unconditionally here would erase the
  // message before it could ever be shown.
  emit('create', name)
  if (error.value === null) reset()
}

function reset() {
  draft.value = ''
  open.value = false
}

defineExpose({ setError: (msg: string | null) => (error.value = msg) })
</script>

<template>
  <div class="picker">
    <ul v-if="cast.length > 0" class="cast">
      <li v-for="member in cast" :key="member.name" class="member">
        <div class="head">
          <button
            class="disclose"
            :title="expanded === member.name ? 'Hide direction' : 'Show writing direction'"
            @click="toggle(member.name)"
          >
            <span class="caret" :class="{ open: expanded === member.name }">&rsaquo;</span>
            <span class="name">{{ member.name }}</span>
          </button>
          <button class="x" :title="`Remove ${member.name} from this passage`" @click="emit('remove', member.name)">
            &times;
          </button>
        </div>

        <p v-if="entries.get(member.name)?.note" class="bio">
          {{ entries.get(member.name)!.note }}
        </p>

        <input
          class="field note"
          :value="member.note"
          :placeholder="`How is ${member.name} in this scene?`"
          @change="emit('note', member.name, ($event.target as HTMLInputElement).value)"
        />

        <!-- Read-only direction. Editing lives on the character sheet, so a
             passage can never change someone story-wide by accident. -->
        <div v-if="expanded === member.name" class="direction">
          <div v-for="group in direction.traits" :key="group.field" class="group">
            <span class="group-label">{{ group.label }}</span>
            <ul class="bullets">
              <li v-for="(point, i) in group.points" :key="i">{{ point }}</li>
            </ul>
          </div>

          <div v-if="direction.shown.length > 0" class="group">
            <span class="group-label">Relations</span>
            <div v-for="relation in direction.shown" :key="relation.to" class="relation">
              <span class="toward">&rarr; {{ relation.to }}</span>
              <ul class="bullets">
                <li v-for="(point, i) in relation.points" :key="i">{{ point }}</li>
              </ul>
            </div>
          </div>

          <p v-if="direction.empty" class="nothing">No direction written yet.</p>

          <div class="direction-foot">
            <button
              v-if="direction.hidden > 0 || direction.showingAll"
              class="link"
              @click="toggleAllRelations(member.name)"
            >
              {{
                direction.showingAll
                  ? 'Only this scene'
                  : `Show ${direction.hidden} more relation${direction.hidden === 1 ? '' : 's'}`
              }}
            </button>
            <button class="link" @click="store.openCharacterSheet(member.name)">
              Edit character
            </button>
          </div>
        </div>
      </li>
    </ul>

    <div class="entry">
      <input
        v-model="draft"
        class="field"
        :class="{ 'field-error': error }"
        placeholder="Add a character…"
        @focus="open = true"
        @keydown.enter.prevent="create"
        @keydown.esc="reset"
        @blur="open = false"
      />
      <div v-if="open && (available.length > 0 || canCreate)" class="menu">
        <button
          v-for="member in available"
          :key="member.name"
          class="item"
          @mousedown.prevent="add(member.name)"
        >
          <span class="item-name">{{ member.name }}</span>
          <span v-if="member.note" class="item-bio">{{ member.note }}</span>
        </button>
        <button v-if="canCreate" class="item create" @mousedown.prevent="create">
          Create &ldquo;{{ draft.trim() }}&rdquo; and add
        </button>
      </div>
    </div>
    <p v-if="error" class="hint hint-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cast {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.member {
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.disclose {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
}

.caret {
  display: inline-block;
  width: 9px;
  color: var(--text-faint);
  transition: transform 0.12s;
}

.caret.open {
  transform: rotate(90deg);
}

.name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.direction {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.bullets {
  margin: 3px 0 0;
  padding-left: 16px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-dim);
}

.relation {
  margin-top: 5px;
}

.toward {
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
}

.nothing {
  margin: 0;
  font-size: 11px;
  font-style: italic;
  color: var(--text-faint);
}

.direction-foot {
  display: flex;
  gap: 10px;
}

.link {
  padding: 0;
  border: 0;
  background: none;
  font-size: 11px;
  color: var(--accent);
}

.link:hover {
  text-decoration: underline;
}

.x {
  padding: 0 2px;
  border: 0;
  background: none;
  color: var(--text-faint);
  font-size: 14px;
  line-height: 1;
}

.x:hover {
  color: var(--todo);
}

.bio {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--text-faint);
}

.note {
  margin-top: 6px;
  height: 26px;
  font-size: 12px;
}

.entry {
  position: relative;
}

.menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 20;
  max-height: 190px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel);
  box-shadow: var(--shadow-md);
}

.item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 5px 7px;
  border: 0;
  border-radius: 5px;
  background: none;
  text-align: left;
}

.item:hover {
  background: var(--panel-alt);
}

.item-bio {
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.create {
  color: var(--accent);
  font-weight: 600;
}
</style>
