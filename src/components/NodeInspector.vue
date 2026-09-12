<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { formatCount } from '../lib/graph/paths'
import * as store from '../stores/story'
import type { NodeState, TagColor } from '../types/story'
import { NODE_STATES } from '../types/story'
import BodyDialog from './BodyDialog.vue'
import CharacterPicker from './CharacterPicker.vue'
import HarloweEditor from './HarloweEditor.vue'
import TagPicker from './TagPicker.vue'

const emit = defineEmits<{ close: []; cheatSheet: [] }>()

const node = store.selected
const geom = store.selectedLayout

const titleDraft = ref('')
const titleError = ref<string | null>(null)
const codeDraft = ref('')
const codeError = ref<string | null>(null)

watch(
  node,
  (n) => {
    titleDraft.value = n?.title ?? ''
    titleError.value = null
    codeDraft.value = n?.code ?? ''
    codeError.value = null
  },
  { immediate: true },
)

function commitTitle() {
  if (!node.value) return
  if (titleDraft.value.trim() === node.value.title) {
    titleError.value = null
    return
  }
  titleError.value = store.rename(node.value.id, titleDraft.value)
}

function revertTitle() {
  titleDraft.value = node.value?.title ?? ''
  titleError.value = null
}

// Committed on blur rather than per keystroke, because a code has to be unique:
// typing "A3" over an existing "A" would otherwise fail on every character.
function commitCode() {
  if (!node.value) return
  if (codeDraft.value.trim() === node.value.code) {
    codeError.value = null
    return
  }
  codeError.value = store.codeSet(node.value.id, codeDraft.value)
}

function revertCode() {
  codeDraft.value = node.value?.code ?? ''
  codeError.value = null
}

const body = computed({
  get: () => node.value?.body ?? '',
  set: (v: string) => node.value && store.editBody(node.value.id, v),
})

const pathCount = computed(() =>
  node.value ? formatCount(store.pathsFrom(node.value.id)) : '0',
)

const isStart = computed(() => node.value?.id === store.state.doc.startNodeId)

/**
 * The inspector is a fixed-width column, so long prose is written through a
 * letterbox. Expanding swaps in the same editor over the whole window; both
 * write the same v-model, so there is nothing to sync when it closes.
 */
const expanded = ref(false)

// Driven from App.vue too, where the Cmd/Ctrl E shortcut lives. Guarded on the
// same condition the aside is — `expanded` outlives a selection change, so
// without it the dialog could be armed now and spring open later.
defineExpose({
  toggleExpanded: () => {
    if (node.value && geom.value) expanded.value = !expanded.value
  },
})

/* ---------- scene ---------- */

const setting = computed({
  get: () => node.value?.setting ?? '',
  set: (v: string) => node.value && store.settingSet(node.value.id, v),
})

const castPicker = ref<InstanceType<typeof CharacterPicker> | null>(null)

function castCreate(name: string) {
  if (!node.value) return
  castPicker.value?.setError(store.castCreateAndAdd(node.value.id, name))
}

// Named rather than inline in the template: an inline arrow loses the `v-if`
// narrowing on `node`, since the closure could outlive it.
function castNote(name: string, note: string) {
  if (node.value) store.castSetNote(node.value.id, name, note)
}

/* ---------- level control ---------- */

const pushedDown = computed(() => (node.value?.levelOffset ?? 0) === 1)

function setOffset(offset: number) {
  if (node.value) store.changeLevelOffset(node.value.id, offset)
}

/**
 * A passage can only ever sit at its structural floor or one below it. Moving
 * up is not merely discouraged, it is impossible: the floor is the deepest
 * parent's level plus one, so anything higher would put an edge inside a level.
 * Saying which parent pins it is far more useful than a validation error.
 */
const upBlockedBy = computed(() => store.blockingParent.value)
</script>

<template>
  <aside v-if="node && geom" class="inspector">
    <header>
      <span class="eyebrow">Passage</span>
      <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
    </header>

    <div class="scroll">
      <section>
        <label class="label" for="passage-title">Title</label>
        <input
          id="passage-title"
          v-model="titleDraft"
          class="field"
          :class="{ 'field-error': titleError }"
          @blur="commitTitle"
          @keydown.enter.prevent="commitTitle"
          @keydown.esc="revertTitle"
        />
        <p v-if="titleError" class="hint hint-error">{{ titleError }}</p>
        <p v-else class="hint">
          Links use this title. Renaming updates every <code>[[link]]</code> pointing here.
        </p>
      </section>

      <section class="grow">
        <div class="body-head">
          <span class="label">Body <span class="muted">Harlowe</span></span>
          <button class="expand" title="Edit in a larger window" @click="expanded = true">
            &#10530; Expand
          </button>
        </div>
        <p class="hint above">
          Link with <code>[[Text|Target]]</code>, <code>[[Text-&gt;Target]]</code> or
          <code>[[Target&lt;-Text]]</code>. Linking to a passage that doesn&rsquo;t exist creates it.
        </p>
        <HarloweEditor v-model="body" />
      </section>

      <section>
        <label class="label" for="passage-code">Code</label>
        <input
          id="passage-code"
          v-model="codeDraft"
          class="field"
          :class="{ 'field-error': codeError }"
          placeholder="Short reference, e.g. A3"
          @blur="commitCode"
          @keydown.enter.prevent="commitCode"
          @keydown.esc="revertCode"
        />
        <p v-if="codeError" class="hint hint-error">{{ codeError }}</p>
        <p v-else class="hint">
          Optional short handle for this passage, unique across the story. Searching for
          it jumps straight here. Leave blank for none.
        </p>
      </section>

      <section>
        <span class="label">State</span>
        <div class="segmented">
          <button
            v-for="s in NODE_STATES"
            :key="s"
            class="seg"
            :class="[`state-${s}`, { on: node.state === s }]"
            @click="store.changeState(node.id, s as NodeState)"
          >
            <span class="dot" />
            {{ s }}
          </button>
        </div>
      </section>

      <section>
        <span class="label">Tags</span>
        <TagPicker
          :tags="node.tags"
          :all-tags="store.tags.value"
          :colors="store.tagColors.value"
          @add="store.tagAdd(node.id, $event)"
          @remove="store.tagRemove(node.id, $event)"
          @recolor="(tag: string, color: TagColor) => store.tagRecolor(tag, color)"
        />
      </section>

      <section>
        <label class="label" for="passage-setting">Setting</label>
        <input
          id="passage-setting"
          v-model="setting"
          class="field"
          list="known-settings"
          placeholder="Where does this happen?"
        />
        <datalist id="known-settings">
          <option v-for="value in store.settingSuggestions.value" :key="value" :value="value" />
        </datalist>
        <p class="hint">New passages linked from here start in this setting.</p>
      </section>

      <section>
        <span class="label">Characters</span>
        <CharacterPicker
          ref="castPicker"
          :cast="node.characters"
          :roster="store.roster.value"
          @add="store.castAdd(node.id, $event)"
          @create="castCreate"
          @remove="store.castRemove(node.id, $event)"
          @note="castNote"
        />
        <p class="hint">Notes here describe this scene only. The cast list is shared story-wide.</p>
        <button
          v-if="node.characters.length > 0"
          class="cheat-link"
          title="Every cast member's traits and relations, side by side"
          @click="emit('cheatSheet')"
        >
          Character Cheat Sheet
        </button>
      </section>

      <section>
        <span class="label">Level</span>
        <div class="level">
          <div class="level-now">
            <strong>Level {{ geom.level }}</strong>
            <span class="muted">{{ pushedDown ? 'nudged down' : 'auto' }}</span>
          </div>
          <div class="level-btns">
            <button
              class="btn btn-icon"
              :disabled="!pushedDown"
              :title="
                pushedDown
                  ? `Return to level ${geom.minLevel}`
                  : upBlockedBy
                    ? `Blocked by “${upBlockedBy.title}” at level ${upBlockedBy.level}`
                    : 'Already at the earliest possible level'
              "
              @click="setOffset(0)"
            >
              &uarr;
            </button>
            <button
              class="btn btn-icon"
              :disabled="pushedDown"
              :title="`Push down to level ${geom.minLevel + 1}`"
              @click="setOffset(1)"
            >
              &darr;
            </button>
          </div>
        </div>
        <p class="hint">
          <template v-if="pushedDown">
            Sitting one level below its natural spot ({{ geom.minLevel }}).
          </template>
          <template v-else-if="upBlockedBy">
            Can&rsquo;t move up: &ldquo;{{ upBlockedBy.title }}&rdquo; links here from level
            {{ upBlockedBy.level }}.
          </template>
          <template v-else>
            Levels come from your links, not from dragging &mdash; a passage sits one level below
            the deepest passage that links to it.
          </template>
        </p>
      </section>

      <section class="stats">
        <div class="stat">
          <span class="muted">Unique paths from here</span>
          <strong>{{ pathCount }}</strong>
        </div>
        <div class="stat">
          <span class="muted">Order on level</span>
          <strong>{{ geom.order + 1 }}</strong>
        </div>
      </section>
    </div>

    <footer>
      <button
        class="btn"
        :disabled="isStart"
        :title="isStart ? 'Path counts are measured from here' : 'Measure path counts from this passage'"
        @click="store.makeStart(node.id)"
      >
        {{ isStart ? 'This is the start' : 'Make start' }}
      </button>
      <button
        class="btn"
        title="Create a passage and link to it from this one"
        @click="store.addPassage(node.id)"
      >
        Add linked
      </button>
      <button
        class="btn danger"
        title="Delete this passage. Links to it are left in place as broken links."
        @click="store.removePassage(node.id)"
      >
        Delete
      </button>
    </footer>

    <BodyDialog v-if="expanded" v-model="body" :title="node.title" @close="expanded = false" />
  </aside>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-w);
  flex: 0 0 var(--sidebar-w);
  border-left: 1px solid var(--border);
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
  gap: 16px;
}

/* A flex column that scrolls will happily hand an item less height than its
   content needs, and the overflow then paints over the next section rather than
   pushing it down. Pinning shrink to 0 makes every section keep its own height
   and lets `.scroll` do the scrolling, which is its job. */
.scroll > section {
  flex: 0 0 auto;
}

section.grow {
  flex: 1 0 auto;
  min-height: 220px;
  display: flex;
  flex-direction: column;
}

.body-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.body-head .label {
  margin-bottom: 0;
}

.expand {
  padding: 2px 6px;
  border: 0;
  border-radius: 4px;
  background: none;
  font-size: 11px;
  color: var(--text-dim);
}

.expand:hover {
  background: var(--bg);
  color: var(--accent);
}

/* `.link` is scoped to CharacterPicker rather than global, so this repeats it
   rather than reaching for a class that does not exist here. */
.cheat-link {
  margin-top: 6px;
  padding: 0;
  border: 0;
  background: none;
  font-size: 11px;
  color: var(--accent);
}

.cheat-link:hover {
  text-decoration: underline;
}

/* Sits between the label and the editor, so it needs the spacing inverted. */
.hint.above {
  margin-top: 5px;
  margin-bottom: 6px;
}

.muted {
  color: var(--text-faint);
  font-weight: 400;
}

code {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 1px 3px;
  border-radius: 3px;
  background: var(--bg);
}

.segmented {
  display: flex;
  gap: 4px;
}

.seg {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  font-size: 12px;
}

.seg .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--state);
}

.seg.on {
  border-color: var(--state);
  background: color-mix(in srgb, var(--state) 14%, transparent);
  font-weight: 600;
}

.level {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}

.level-now {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.level-btns {
  display: flex;
  gap: 4px;
}

.stats {
  display: flex;
  gap: 8px;
}

.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  font-size: 11px;
}

.stat strong {
  font-size: 15px;
}

footer {
  display: flex;
  gap: 6px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}

footer .btn {
  flex: 1;
}

.danger:hover:not(:disabled) {
  border-color: var(--todo);
  color: var(--todo);
}
</style>
