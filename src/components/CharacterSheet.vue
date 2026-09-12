<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import * as store from '../stores/story'
import type { TraitField } from '../types/story'
import { TRAIT_FIELDS, TRAIT_LABELS } from '../types/story'
import TraitList from './TraitList.vue'

const props = defineProps<{ name: string }>()
const emit = defineEmits<{ close: [] }>()

const character = computed(() => store.characterMap.value.get(props.name) ?? null)
const usage = computed(() => store.characterUsage.value.find((u) => u.value === props.name))

/* ---------- description ---------- */

const description = ref('')
const descriptionEl = ref<HTMLTextAreaElement | null>(null)
/** Set while the textarea holds uncommitted text; see TraitList for the why. */
const descriptionDirty = ref(false)

/** Grow to fit the prose rather than trapping it in one scrolling line. */
function autoGrow() {
  const el = descriptionEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 260)}px`
}

watch(
  character,
  (c) => {
    // Every document mutation re-clones the roster, so this fires constantly;
    // accepting the stored note mid-edit would discard what is being typed.
    if (descriptionDirty.value) return
    description.value = c?.note ?? ''
    void nextTick(autoGrow)
  },
  { immediate: true },
)

function commitDescription() {
  descriptionDirty.value = false
  if (character.value && description.value !== character.value.note) {
    store.characterSetBio(props.name, description.value)
  }
}

/* ---------- rename ---------- */

const renaming = ref(false)
const nameDraft = ref('')
const nameError = ref<string | null>(null)

function startRename() {
  nameDraft.value = props.name
  nameError.value = null
  renaming.value = true
}

function commitRename() {
  if (!renaming.value) return
  if (nameDraft.value.trim() === props.name) {
    renaming.value = false
    return
  }
  nameError.value = store.characterRename(props.name, nameDraft.value)
  if (!nameError.value) renaming.value = false
}

/* ---------- relations ---------- */

const relationDraft = ref('')
const relationError = ref<string | null>(null)
const pendingDelete = ref(false)

/** Roster members who aren't this character and aren't already related to. */
const relatable = computed(() => {
  const taken = new Set(character.value?.relations.map((r) => r.to) ?? [])
  return store.roster.value
    .map((c) => c.name)
    .filter((n) => n !== props.name && !taken.has(n))
})

function addRelation() {
  const to = relationDraft.value
  if (!to) return
  relationError.value = store.relationAdd(props.name, to)
  if (!relationError.value) relationDraft.value = ''
}

/**
 * What other characters make of this one. Read-only here: relations are
 * one-directional, so Tam's view of Mira belongs on Tam's sheet, not as an
 * editable field on hers.
 *
 * Who regards this character. Reactive through the document read inside
 * `relationsToward` — no other dependency is needed, and `layoutVersion`
 * deliberately does not change on a profile edit.
 */
const inbound = computed(
  () => new Map(store.relationsToward(props.name).map((r) => [r.from, r.points])),
)

/**
 * Inbound relations with no outbound counterpart.
 *
 * Without these, someone who regards this character would be invisible unless
 * this character happened to regard them back — which is exactly the asymmetry
 * the reverse view exists to show.
 */
const inboundOnly = computed(() => {
  const outbound = new Set(character.value?.relations.map((r) => r.to) ?? [])
  return [...inbound.value.entries()]
    .filter(([from]) => !outbound.has(from))
    .map(([from, points]) => ({ from, points }))
})

function setTrait(field: TraitField, points: string[]) {
  store.characterSetTrait(props.name, field, points)
}
</script>

<template>
  <div class="veil" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="sheet" role="dialog" :aria-label="`Character: ${name}`">
      <header>
        <div class="ident">
          <template v-if="renaming">
            <input
              v-model="nameDraft"
              class="field name-field"
              autofocus
              @keydown.enter.prevent="commitRename"
              @keydown.esc="renaming = false"
              @blur="commitRename"
            />
          </template>
          <template v-else>
            <h2>{{ name }}</h2>
            <button class="mini" @click="startRename">Rename</button>
          </template>
        </div>
        <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
      </header>

      <p v-if="nameError" class="hint hint-error head-error">{{ nameError }}</p>

      <div v-if="character" class="scroll">
        <section>
          <label class="label" for="character-description">Description</label>
          <textarea
            id="character-description"
            ref="descriptionEl"
            v-model="description"
            class="field description"
            rows="2"
            placeholder="Who are they? Shown wherever they appear in the cast list."
            @input="descriptionDirty = true; autoGrow()"
            @change="commitDescription"
            @blur="commitDescription"
          />
        </section>

        <div class="grid">
          <section v-for="field in TRAIT_FIELDS" :key="field">
            <span class="label">{{ TRAIT_LABELS[field] }}</span>
            <TraitList
              :points="character[field]"
              placeholder="A key point…"
              @change="setTrait(field, $event)"
            />
          </section>

          <section class="relations">
            <span class="label">Relations</span>
            <p class="hint top-hint">
              One-directional &mdash; this is how {{ name }} regards them, not the reverse.
            </p>

            <div v-for="relation in character.relations" :key="relation.to" class="relation">
              <div class="relation-head">
                <span class="arrow">&rarr;</span>
                <button class="target" @click="store.openCharacterSheet(relation.to)">
                  {{ relation.to }}
                </button>
                <button
                  class="op remove"
                  :title="`Remove the relation to ${relation.to}`"
                  @click="store.relationRemove(name, relation.to)"
                >
                  &times;
                </button>
              </div>

              <TraitList
                :points="relation.points"
                :placeholder="`How ${name} treats ${relation.to}…`"
                @change="store.relationSetPoints(name, relation.to, $event)"
              />

              <p v-if="inbound.get(relation.to)" class="reverse">
                <span class="arrow">&larr;</span>
                <span>
                  <em>{{ relation.to }} sees {{ name }} as:</em>
                  {{ inbound.get(relation.to)!.join(' · ') }}
                </span>
              </p>
            </div>

            <div
              v-for="entry in inboundOnly"
              :key="`in-${entry.from}`"
              class="relation inbound-only"
            >
              <div class="relation-head">
                <span class="arrow">&larr;</span>
                <button class="target" @click="store.openCharacterSheet(entry.from)">
                  {{ entry.from }}
                </button>
                <span class="tag-oneway">sees {{ name }}</span>
              </div>
              <ul class="reverse-points">
                <li v-for="(point, i) in entry.points" :key="i">{{ point }}</li>
              </ul>
              <p class="hint reciprocate">
                {{ name }} has nothing recorded about {{ entry.from }}.
              </p>
            </div>

            <div class="add-relation">
              <select v-model="relationDraft" class="field" :disabled="relatable.length === 0">
                <option value="">
                  {{ relatable.length === 0 ? 'No one left to relate to' : 'Add a relation…' }}
                </option>
                <option v-for="other in relatable" :key="other" :value="other">{{ other }}</option>
              </select>
              <button class="btn" :disabled="!relationDraft" @click="addRelation">Add</button>
            </div>
            <p v-if="relationError" class="hint hint-error">{{ relationError }}</p>
          </section>
        </div>
      </div>

      <footer>
        <span class="count">
          Appears in {{ usage?.count ?? 0 }}
          {{ (usage?.count ?? 0) === 1 ? 'passage' : 'passages' }}
        </span>
        <template v-if="pendingDelete">
          <span class="confirm-text">Remove {{ name }} from the story?</span>
          <button class="btn" @click="pendingDelete = false">Cancel</button>
          <button class="btn danger" @click="store.characterDelete(name)">Remove</button>
        </template>
        <button v-else class="btn danger" @click="pendingDelete = true">Delete character</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.veil {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--text) 32%, transparent);
}

.sheet {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 720px;
  max-height: 100%;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 10px 12px 18px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

.ident {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

h2 {
  margin: 0;
  font-size: 17px;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name-field {
  width: 260px;
  height: 28px;
  font-size: 15px;
  font-weight: 600;
}

.head-error {
  margin: 8px 18px 0;
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.description {
  height: auto;
  min-height: 58px;
  padding: 8px 9px;
  line-height: 1.5;
  resize: none;
  overflow-y: auto;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}

.relations {
  grid-column: 1 / -1;
}

.top-hint {
  margin-top: 0;
  margin-bottom: 8px;
}

.relation {
  padding: 9px 10px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel-alt);
}

.relation-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.arrow {
  color: var(--text-faint);
  font-size: 12px;
}

.target {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  font-weight: 600;
  text-align: left;
}

.target:hover {
  color: var(--accent);
  text-decoration: underline;
}

.op {
  width: 20px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1;
}

.op.remove:hover {
  color: var(--todo);
  background: var(--bg);
}

.reverse {
  display: flex;
  gap: 6px;
  margin: 8px 0 0;
  padding-top: 7px;
  border-top: 1px dashed var(--border);
  font-size: 11px;
  color: var(--text-faint);
}

.reverse em {
  font-style: normal;
  font-weight: 600;
}

.inbound-only {
  border-style: dashed;
  background: transparent;
}

.tag-oneway {
  font-size: 10px;
  color: var(--text-faint);
}

.reverse-points {
  margin: 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.reciprocate {
  margin-top: 5px;
  font-style: italic;
}

.add-relation {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.add-relation .field {
  flex: 1;
}

footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}

.count {
  flex: 1;
  font-size: 11px;
  color: var(--text-faint);
}

.confirm-text {
  font-size: 11px;
  color: var(--todo);
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

.danger:hover:not(:disabled) {
  border-color: var(--todo);
  color: var(--todo);
}

@media (max-width: 640px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
