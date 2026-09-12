<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

/**
 * Chooses the target for a link before a single character of it is written.
 *
 * That ordering is the point. `setBody` creates a passage for every link target
 * it has not seen before, so typing a target inside `[[...]]` would leave a
 * trail of passages named after each prefix. Picking first means the document
 * only ever sees the finished link.
 */

const props = defineProps<{
  /** Every passage in the story, in the order they should be offered. */
  targets: readonly { code: string; title: string }[]
  /** The prose the link will be shown as, empty when nothing was selected. */
  label: string
}>()

const emit = defineEmits<{ pick: [target: string]; close: [] }>()

const input = ref<HTMLInputElement | null>(null)
const draft = ref('')
const active = ref(0)

/** Matches on either half: authors recall a passage by name or by code. */
const matches = computed(() => {
  const q = draft.value.trim().toLowerCase()
  if (q.length === 0) return props.targets
  return props.targets.filter(
    (t) => t.code.toLowerCase().includes(q) || t.title.toLowerCase().includes(q),
  )
})

/** Offering to create a name that is already on the list would be a duplicate row. */
const canCreate = computed(() => {
  const name = draft.value.trim()
  return name.length > 0 && !props.targets.some((t) => t.title === name)
})

/**
 * One list for the keyboard to walk, so Enter and the arrows agree on the rows.
 *
 * The create row carries no code: it inserts a bare `[[name]]`, and the code is
 * minted when the body settles. Picking an existing row inserts its code, which
 * is what the link actually resolves against.
 */
const options = computed(() => {
  const rows = matches.value.map((t) => ({ code: t.code, title: t.title, create: false }))
  if (canCreate.value) rows.push({ code: '', title: draft.value.trim(), create: true })
  return rows
})

function move(delta: number) {
  const count = options.value.length
  if (count === 0) return
  active.value = (active.value + delta + count) % count
}

function choose(target: string) {
  if (target.length === 0) return
  emit('pick', target)
}

function commit() {
  const row = options.value[Math.min(active.value, options.value.length - 1)]
  // A create row has no code yet, so the bare title goes in and `resolveLinks`
  // mints one on blur.
  if (row) choose(row.create ? row.title : row.code)
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div class="link-picker" role="dialog" aria-label="Link to a passage">
    <input
      ref="input"
      v-model="draft"
      class="field"
      :placeholder="label.length > 0 ? `Link “${label}” to…` : 'Link to…'"
      @input="active = 0"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent.stop="emit('close')"
      @blur="emit('close')"
    />

    <div v-if="options.length > 0" class="menu">
      <button
        v-for="(row, i) in options"
        :key="row.create ? `+${row.title}` : row.code"
        class="item"
        :class="{ active: i === active, create: row.create }"
        @mousedown.prevent="choose(row.create ? row.title : row.code)"
        @mousemove="active = i"
      >
        <template v-if="row.create">Create &ldquo;{{ row.title }}&rdquo;</template>
        <template v-else>
          <span class="row-code">{{ row.code }}</span>
          <span class="row-title">{{ row.title || 'Untitled' }}</span>
        </template>
      </button>
    </div>
  </div>
</template>

<style scoped>
.link-picker {
  position: relative;
}

/* Code first and monospaced: it is what the link will actually contain, and a
   fixed column keeps the titles beside it aligned. */
.row-code {
  display: inline-block;
  min-width: 3.5em;
  margin-right: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  opacity: 0.7;
}

.row-title {
  opacity: 0.95;
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
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 7px;
  border: 0;
  border-radius: 5px;
  background: none;
  text-align: left;
}

.item.active {
  background: var(--panel-alt);
}

.create {
  color: var(--accent);
  font-weight: 600;
}
</style>
