<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import * as store from '../stores/story'
import { TRAIT_FIELDS, TRAIT_LABELS } from '../types/story'

/**
 * Reference for the passage being written: every cast member's story-wide
 * direction, side by side, while the body editor stays open on the right.
 *
 * Read-only throughout. Editing lives on the character sheet, so a panel meant
 * for looking things up can never change someone story-wide by accident.
 */

const emit = defineEmits<{ close: [] }>()

const node = store.selected
const entries = store.characterMap

/** Who else is on stage; a relation to anyone else is not this scene's business. */
const present = computed(() => new Set((node.value?.characters ?? []).map((c) => c.name)))

/**
 * The whole panel, projected once.
 *
 * The template reads each field several times per card and the panel re-renders
 * on every keystroke in the body editor, so deriving per-read would re-walk the
 * roster each time. The cast arrives sorted by name (`addPassageCharacter`), so
 * the cards need no sort of their own.
 */
const cards = computed(() =>
  (node.value?.characters ?? []).map((member) => {
    const entry = entries.value.get(member.name)
    const groups = entry
      ? TRAIT_FIELDS.filter((f) => entry[f].length > 0).map((f) => ({
          key: f as string,
          label: TRAIT_LABELS[f],
          points: entry[f],
        }))
      : []
    const relations = (entry?.relations ?? []).filter(
      (r) => r.points.length > 0 && present.value.has(r.to),
    )
    return {
      name: member.name,
      bio: entry?.note ?? '',
      sceneNote: member.note,
      groups,
      relations,
      empty: groups.length === 0 && relations.length === 0 && (entry?.note ?? '') === '',
    }
  }),
)

/**
 * Which subsections are folded away, keyed `character/group`.
 *
 * Collapsed is the side that is stored, so a character nobody has touched reads
 * as the full sheet — which is the entire point of the panel.
 */
const collapsed = ref<Set<string>>(new Set())

function isOpen(name: string, group: string) {
  return !collapsed.value.has(`${name}/${group}`)
}

function fold(name: string, group: string) {
  const key = `${name}/${group}`
  const next = new Set(collapsed.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsed.value = next
}

// Keyed on the id, not the node: every mutation re-clones it, so watching the
// object would wipe the folds on each keystroke in the body editor.
watch(
  () => node.value?.id,
  () => (collapsed.value = new Set()),
)
</script>

<template>
  <aside class="cheat">
    <header>
      <span class="eyebrow">Cheat sheet</span>
      <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
    </header>

    <div class="scroll">
      <p v-if="node" class="where">
        Cast of <strong>{{ node.title }}</strong>
      </p>

      <article v-for="card in cards" :key="card.name" class="member">
        <div class="head">
          <span class="name">{{ card.name }}</span>
          <button
            class="link"
            :title="`Open ${card.name}'s character sheet`"
            @click="store.openCharacterSheet(card.name)"
          >
            Edit
          </button>
        </div>

        <p v-if="card.sceneNote" class="scene-note">In this scene: {{ card.sceneNote }}</p>

        <div v-if="card.bio" class="group">
          <button class="group-label" @click="fold(card.name, 'bio')">
            <span class="caret" :class="{ open: isOpen(card.name, 'bio') }">&rsaquo;</span>
            Description
          </button>
          <p v-if="isOpen(card.name, 'bio')" class="bio">{{ card.bio }}</p>
        </div>

        <div v-for="group in card.groups" :key="group.key" class="group">
          <button class="group-label" @click="fold(card.name, group.key)">
            <span class="caret" :class="{ open: isOpen(card.name, group.key) }">&rsaquo;</span>
            {{ group.label }}
          </button>
          <ul v-if="isOpen(card.name, group.key)" class="bullets">
            <li v-for="(point, i) in group.points" :key="i">{{ point }}</li>
          </ul>
        </div>

        <!-- Relations are one-directional: this is only how the character
             regards others, never how they are regarded. Only relations toward
             the rest of this passage's cast appear — the panel is a reference
             for the scene being written, not the whole roster. -->
        <div v-if="card.relations.length > 0" class="group">
          <button class="group-label" @click="fold(card.name, 'relations')">
            <span class="caret" :class="{ open: isOpen(card.name, 'relations') }">&rsaquo;</span>
            Relations
          </button>
          <template v-if="isOpen(card.name, 'relations')">
            <div v-for="relation in card.relations" :key="relation.to" class="relation">
              <span class="toward">&rarr; {{ relation.to }}</span>
              <ul class="bullets">
                <li v-for="(point, i) in relation.points" :key="i">{{ point }}</li>
              </ul>
            </div>
          </template>
        </div>

        <p v-if="card.empty" class="nothing">No direction written yet.</p>
      </article>

      <p v-if="cards.length === 0" class="empty">
        No cast in this passage yet. Add someone under Characters in the passage sidebar.
      </p>
    </div>
  </aside>
</template>

<style scoped>
/* --left-panel-w, not --sidebar-w: this and StoryIndexPanel share the left
   gutter, and swapping between them must not reflow the stage. */
.cheat {
  display: flex;
  flex-direction: column;
  width: var(--left-panel-w);
  flex: 0 0 var(--left-panel-w);
  border-right: 1px solid var(--border);
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
  gap: 10px;
}

.where {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-dim);
}

.member {
  padding: 8px 9px;
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

.name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scene-note {
  margin: 4px 0 0;
  font-size: 11.5px;
  font-style: italic;
  color: var(--text-dim);
}

.group {
  margin-top: 8px;
}

.group-label {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-faint);
  text-align: left;
}

.group-label:hover {
  color: var(--text);
}

.caret {
  display: inline-block;
  width: 9px;
  transition: transform 0.12s;
}

.caret.open {
  transform: rotate(90deg);
}

.bio {
  margin: 3px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-dim);
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
  margin: 8px 0 0;
  font-size: 11px;
  font-style: italic;
  color: var(--text-faint);
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

.empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
