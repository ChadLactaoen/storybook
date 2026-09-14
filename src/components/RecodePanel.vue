<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RecodeMode, RecodeOptions } from '../lib/graph/recode'
import * as store from '../stores/story'

/**
 * Recode every passage at once, from the tree as drawn.
 *
 * Codes are minted `P<id>` in creation order, which says nothing about where a
 * passage ended up. This reads a numbering off the drawing instead, so a route
 * string can be followed on the page.
 *
 * Nothing is written until Recode is pressed, and the preview below is the whole
 * result rather than a sample: every code in the story moves at once, and the
 * links follow, so seeing it first is the difference between a bulk edit and a
 * leap.
 */

const emit = defineEmits<{ close: [] }>()

/** Rows drawn before the list is cut short. A long story is not worth 800 rows. */
const PREVIEW_LIMIT = 100

const mode = ref<RecodeMode>('levelNode')

// One draft per mode, so switching back and forth clobbers neither.
const levelPrefix = ref('')
const separator = ref('N')
const nodePrefix = ref('P')

/**
 * A refusal from the apply itself, as against one the preview already knew.
 *
 * The preview pre-checks everything the mutation can refuse, so this should stay
 * null; it is here because "should" is not "does", and a bulk edit that silently
 * did nothing would be worse than an odd message.
 */
const failure = ref<string | null>(null)

const options = computed<RecodeOptions>(() =>
  mode.value === 'node'
    ? { mode: 'node', prefix: nodePrefix.value, separator: '' }
    : { mode: 'levelNode', prefix: levelPrefix.value, separator: separator.value },
)

const plan = computed(() => store.recodePreview(options.value))

// Cleared when the numbering changes: a message about the scheme the author has
// since edited away describes nothing they can still see.
watch(options, () => {
  failure.value = null
})
const shown = computed(() => plan.value.entries.slice(0, PREVIEW_LIMIT))
const hidden = computed(() => Math.max(0, plan.value.entries.length - PREVIEW_LIMIT))
// Also off when nothing moves: the numbering already matches the tree, and a
// press that commits nothing reads as a press that failed.
const blocked = computed(
  () => plan.value.error !== null || plan.value.entries.length === 0 || plan.value.changed === 0,
)

/**
 * A code from the story itself, rather than one built here from the same rule.
 *
 * A second copy of the rule drifts: this hint used to read `3N1` while the rows
 * under it said `1N01`, because it did not know about the padding. The first row
 * that actually moves is a real answer and cannot be wrong.
 */
const example = computed(() => {
  const rows = plan.value.entries
  return (rows.find((e) => e.from !== e.to) ?? rows[0])?.to ?? null
})

function apply() {
  // The preview is already the settled answer; applying reuses it.
  const error = store.codesRecode(options.value, plan.value)
  if (error !== null) {
    failure.value = error
    return
  }
  emit('close')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="veil" @click.self="emit('close')">
    <div class="sheet" role="dialog" aria-label="Recode passages">
      <header>
        <h2>Recode passages</h2>
        <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
      </header>

      <div class="scroll">
        <section>
          <span class="label">Numbering</span>
          <div class="segmented">
            <button
              class="seg"
              :class="{ on: mode === 'levelNode' }"
              @click="mode = 'levelNode'"
            >
              Level and node
            </button>
            <button class="seg" :class="{ on: mode === 'node' }" @click="mode = 'node'">
              Node
            </button>
          </div>
        </section>

        <section v-if="mode === 'levelNode'" class="fields">
          <label>
            <span class="label">Prefix</span>
            <input v-model="levelPrefix" class="field" placeholder="none" />
          </label>
          <label>
            <span class="label">Separator</span>
            <input v-model="separator" class="field" placeholder="N" />
          </label>
        </section>
        <p v-if="mode === 'levelNode'" class="hint">
          <template v-if="example">Codes look like <code>{{ example }}</code>. </template>
          The level comes first, then the passage&rsquo;s place within it, left to right.
          Numbers are padded so codes sort the way the tree is drawn.
        </p>

        <section v-else class="fields">
          <label>
            <span class="label">Prefix</span>
            <input v-model="nodePrefix" class="field" placeholder="P" />
          </label>
        </section>
        <p v-if="mode === 'node'" class="hint">
          <template v-if="example">Codes look like <code>{{ example }}</code>. </template>
          Order runs top to bottom, then left to right within each level. Numbers are
          padded so codes sort the way the tree is drawn.
        </p>

        <p v-if="plan.error" class="hint hint-error">{{ plan.error }}</p>
        <p v-else-if="failure" class="hint hint-error">{{ failure }}</p>

        <!-- A warning rather than a refusal: the recode is sound and the link
             resolves. What changes is the drawing, and only the author can say
             whether that old typo was meant to point here. -->
        <p v-if="plan.captures.length > 0" class="hint hint-warn">
          <template v-for="(code, i) in plan.captures" :key="code">
            <span v-if="i > 0">, </span><code>{{ code }}</code>
          </template>
          {{ plan.captures.length === 1 ? 'is' : 'are' }} already the target of a link with no
          passage behind it. Recoding will point
          {{ plan.captures.length === 1 ? 'that link' : 'those links' }} at a real passage, and
          the tree will change shape.
        </p>

        <section>
          <span class="label">Preview</span>
          <p v-if="plan.entries.length === 0" class="hint">There is nothing to recode.</p>
          <ul v-else class="preview">
            <li v-for="entry in shown" :key="entry.id" class="row">
              <code class="from">{{ entry.from }}</code>
              <span class="arrow">&rarr;</span>
              <code class="to" :class="{ same: entry.from === entry.to }">{{ entry.to }}</code>
              <span class="who">{{ entry.title }}</span>
            </li>
          </ul>
          <p v-if="hidden > 0" class="hint">&hellip;and {{ hidden }} more.</p>
        </section>
      </div>

      <footer>
        <span class="muted">
          {{ plan.changed }} of {{ plan.entries.length }}
          {{ plan.entries.length === 1 ? 'passage changes' : 'passages change' }}. One undo
          step.
        </span>
        <div class="actions">
          <button class="btn" @click="emit('close')">Cancel</button>
          <button class="btn btn-primary" :disabled="blocked" @click="apply">Recode</button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* One above Editor settings: the two never open together, but this is the one
   the author acted on last. Ladder: body 92, sheet 94, help 95, settings 96,
   recode 97, startup 100. */
.veil {
  position: fixed;
  inset: 0;
  z-index: 97;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--text) 32%, transparent);
}

.sheet {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 520px;
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
  padding: 12px 10px 12px 18px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

h2 {
  margin: 0;
  font-size: 17px;
  letter-spacing: -0.01em;
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px;
}

section + section,
.hint + section {
  margin-top: 16px;
}

/* `.seg.on` keys off `--state`, which only the state-* classes otherwise set. */
.segmented {
  --state: var(--accent);
  display: flex;
  gap: 4px;
}

.seg {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  font-size: 12px;
}

.seg.on {
  border-color: var(--state);
  background: color-mix(in srgb, var(--state) 14%, transparent);
  font-weight: 600;
}

.fields {
  display: flex;
  gap: 10px;
}

.fields label {
  flex: 1;
  min-width: 0;
}

.preview {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}

.row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 10px;
  font-size: 12px;
}

.row + .row {
  border-top: 1px solid var(--border);
}

.from,
.to {
  font-family: var(--mono);
  font-size: 11px;
}

.from {
  min-width: 64px;
  color: var(--text-dim);
}

.to {
  min-width: 64px;
  font-weight: 600;
}

/* A code that does not move should not read as a change. */
.to.same {
  font-weight: 400;
  color: var(--text-faint);
}

.arrow {
  color: var(--text-faint);
}

.who {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
}

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}

.actions {
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
}

.muted {
  font-size: 11px;
  color: var(--text-faint);
}
</style>
