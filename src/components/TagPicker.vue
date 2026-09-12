<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TagColor } from '../types/story'
import { TAG_COLORS } from '../types/story'

const props = defineProps<{
  tags: string[]
  allTags: string[]
  colors: Map<string, TagColor>
}>()

const emit = defineEmits<{
  add: [tag: string]
  remove: [tag: string]
  recolor: [tag: string, color: TagColor]
}>()

const draft = ref('')
const open = ref(false)
const editing = ref<string | null>(null)

/**
 * Tags are story-global, so anything used anywhere is offered here. That is the
 * whole point of the registry: type "exposition" once, pick it from the list
 * everywhere after.
 */
const available = computed(() => {
  const mine = new Set(props.tags)
  const q = draft.value.trim().toLowerCase()
  return props.allTags.filter(
    (t) => !mine.has(t) && (q.length === 0 || t.toLowerCase().includes(q)),
  )
})

const canCreate = computed(() => {
  const t = draft.value.trim()
  return t.length > 0 && !props.tags.includes(t) && !props.allTags.includes(t)
})

function add(tag: string) {
  emit('add', tag)
  draft.value = ''
  open.value = false
}

function commitDraft() {
  const t = draft.value.trim()
  if (t.length > 0) add(t)
}
</script>

<template>
  <div class="picker">
    <div v-if="tags.length > 0" class="chips">
      <span
        v-for="tag in tags"
        :key="tag"
        class="chip"
        :style="{ '--chip': `var(--tag-${colors.get(tag) ?? 'none'})` }"
      >
        <button
          class="swatch"
          :title="`Colour of &quot;${tag}&quot;`"
          @click="editing = editing === tag ? null : tag"
        />
        <span class="name">{{ tag }}</span>
        <button class="x" :title="`Remove ${tag}`" @click="emit('remove', tag)">&times;</button>

        <span v-if="editing === tag" class="palette">
          <button
            v-for="color in TAG_COLORS"
            :key="color"
            class="dot"
            :class="{ current: (colors.get(tag) ?? 'none') === color, none: color === 'none' }"
            :style="{ background: `var(--tag-${color})` }"
            :title="color"
            @click="emit('recolor', tag, color); editing = null"
          />
        </span>
      </span>
    </div>

    <div class="entry">
      <input
        v-model="draft"
        class="field"
        placeholder="Add a tag…"
        @focus="open = true"
        @keydown.enter.prevent="commitDraft"
        @keydown.esc="open = false"
        @blur="open = false"
      />
      <div v-if="open && (available.length > 0 || canCreate)" class="menu">
        <button
          v-for="tag in available"
          :key="tag"
          class="item"
          @mousedown.prevent="add(tag)"
        >
          <span class="dot sm" :style="{ background: `var(--tag-${colors.get(tag) ?? 'none'})` }" />
          {{ tag }}
        </button>
        <button v-if="canCreate" class="item create" @mousedown.prevent="commitDraft">
          Create &ldquo;{{ draft.trim() }}&rdquo;
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 5px 2px 4px;
  border-radius: 999px;
  font-size: 11px;
  background: color-mix(in srgb, var(--chip) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--chip) 34%, transparent);
}

.swatch {
  width: 11px;
  height: 11px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--chip) 60%, transparent);
  border-radius: 50%;
  background: var(--chip);
}

.x {
  padding: 0 1px;
  border: 0;
  background: none;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1;
}

.x:hover {
  color: var(--todo);
}

.palette {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  z-index: 20;
  display: flex;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel);
  box-shadow: var(--shadow-md);
}

.dot {
  width: 15px;
  height: 15px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
}

.dot.sm {
  width: 9px;
  height: 9px;
  border-width: 1px;
}

.dot.none {
  background-image: linear-gradient(
    45deg,
    transparent 44%,
    var(--todo) 44%,
    var(--todo) 56%,
    transparent 56%
  );
}

.dot.current {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
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
  align-items: center;
  gap: 7px;
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

.create {
  color: var(--accent);
  font-weight: 600;
}
</style>
