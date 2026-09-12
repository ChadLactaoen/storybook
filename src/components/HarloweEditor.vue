<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { highlightHtml } from '../lib/harlowe/highlight'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const textarea = ref<HTMLTextAreaElement | null>(null)
const highlight = ref<HTMLPreElement | null>(null)

const html = computed(() => highlightHtml(props.modelValue))

/**
 * The classic overlay trick: a transparent textarea sits exactly on top of a
 * highlighted <pre>. Both must share every metric that affects line wrapping,
 * which is why the font, padding and wrapping rules below are duplicated
 * verbatim rather than inherited.
 */
function syncScroll() {
  if (!textarea.value || !highlight.value) return
  highlight.value.scrollTop = textarea.value.scrollTop
  highlight.value.scrollLeft = textarea.value.scrollLeft
}

watch(() => props.modelValue, () => requestAnimationFrame(syncScroll))

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
}

/** Tab indents instead of leaving the field; authors are writing prose here. */
function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey) return
  e.preventDefault()
  const el = e.target as HTMLTextAreaElement
  const { selectionStart: s, selectionEnd: end, value } = el
  emit('update:modelValue', value.slice(0, s) + '  ' + value.slice(end))
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = s + 2
  })
}

defineExpose({ focus: () => textarea.value?.focus() })
</script>

<template>
  <div class="editor">
    <pre ref="highlight" class="layer" aria-hidden="true"><code v-html="html" /></pre>
    <textarea
      ref="textarea"
      class="layer input"
      spellcheck="true"
      :value="modelValue"
      @input="onInput"
      @scroll="syncScroll"
      @keydown="onKeyDown"
    />
  </div>
</template>

<style scoped>
.editor {
  position: relative;
  flex: 1;
  min-height: 180px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  overflow: hidden;
}

.editor:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

/* Every metric here must match between the two layers or the text drifts. */
.layer {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 10px 11px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  tab-size: 2;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: normal;
  border: 0;
  overflow: auto;
}

.layer code {
  font: inherit;
}

.input {
  resize: none;
  background: transparent;
  color: transparent;
  caret-color: var(--text);
  outline: none;
}

.input::selection {
  background: color-mix(in srgb, var(--accent) 30%, transparent);
}

pre.layer {
  pointer-events: none;
  color: var(--text);
}
</style>
