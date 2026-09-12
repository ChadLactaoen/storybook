<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  points: string[]
  placeholder?: string
}>()

const emit = defineEmits<{ change: [points: string[]] }>()

/**
 * A local working copy, so a half-typed point isn't committed on every
 * keystroke. Edits are pushed up on blur, matching how the per-scene note field
 * already behaves — one undo step per edit, not one per character typed.
 */
const draft = ref<string[]>([...props.points])
const rows = ref<HTMLInputElement[]>([])

/**
 * True while the draft holds anything not yet committed — a blank row waiting
 * to be typed into, or edited text.
 *
 * Incoming props are ignored while it is set. Every commit anywhere in the
 * document hands this component a fresh `points` array (the document is cloned
 * on each mutation), so without this guard an unrelated edit would wipe the row
 * the author is in the middle of writing.
 */
const dirty = ref(false)

watch(
  () => props.points,
  (next) => {
    if (dirty.value) return
    draft.value = [...next]
  },
  { deep: true },
)

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function commit() {
  const cleaned = draft.value.map((p) => p.trim()).filter((p) => p.length > 0)
  if (!sameList(cleaned, props.points)) emit('change', cleaned)

  // Stay dirty while the draft holds something the document does not — a blank
  // row waiting to be typed into, or untrimmed whitespace.
  //
  // Load-bearing on Enter: browsers fire `change` on an input when Enter is
  // pressed, so commit() runs a second time right after onEnter has already
  // committed and appended a fresh row. Clearing the flag unconditionally there
  // would let the watcher replace the draft with the stored list and swallow
  // that row.
  dirty.value = !sameList(draft.value, cleaned)
}

async function addPoint() {
  draft.value.push('')
  // Set before awaiting: the watcher flushes on the microtask queue, ahead of
  // the next frame, and would otherwise drop the row we just added.
  dirty.value = true
  // Focus the row we just created so typing can continue uninterrupted.
  await new Promise((r) => requestAnimationFrame(r))
  rows.value[draft.value.length - 1]?.focus()
}

function removePoint(index: number) {
  draft.value.splice(index, 1)
  commit()
}

/** Reorder with buttons rather than drag: keyboard-reachable and deterministic. */
function move(index: number, delta: number) {
  const to = index + delta
  if (to < 0 || to >= draft.value.length) return
  const [item] = draft.value.splice(index, 1)
  draft.value.splice(to, 0, item!)
  commit()
}

async function onEnter(index: number) {
  if (index === draft.value.length - 1) {
    commit()
    await addPoint()
  } else {
    rows.value[index + 1]?.focus()
  }
}
</script>

<template>
  <div class="traits">
    <ul v-if="draft.length > 0" class="points">
      <li v-for="(_, i) in draft" :key="i" class="point">
        <input
          ref="rows"
          v-model="draft[i]"
          class="field"
          :placeholder="placeholder"
          @input="dirty = true"
          @change="commit"
          @blur="commit"
          @keydown.enter.prevent="onEnter(i)"
        />
        <div class="ops">
          <button
            class="op"
            title="Move up"
            :disabled="i === 0"
            @click="move(i, -1)"
          >
            &uarr;
          </button>
          <button
            class="op"
            title="Move down"
            :disabled="i === draft.length - 1"
            @click="move(i, 1)"
          >
            &darr;
          </button>
          <button class="op remove" title="Remove this point" @click="removePoint(i)">
            &times;
          </button>
        </div>
      </li>
    </ul>

    <button class="add" @click="addPoint">+ Add point</button>
  </div>
</template>

<style scoped>
.traits {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.points {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.point {
  display: flex;
  align-items: center;
  gap: 4px;
}

.point .field {
  flex: 1;
  min-width: 0;
  height: 26px;
  font-size: 12px;
}

.ops {
  display: flex;
  gap: 1px;
  flex: 0 0 auto;
}

.op {
  width: 20px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1;
}

.op:hover:not(:disabled) {
  background: var(--bg);
  color: var(--text);
}

.op:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.op.remove:hover {
  color: var(--todo);
}

.add {
  align-self: flex-start;
  padding: 2px 5px;
  border: 0;
  border-radius: 4px;
  background: none;
  font-size: 11px;
  color: var(--text-dim);
}

.add:hover {
  background: var(--bg);
  color: var(--accent);
}
</style>
