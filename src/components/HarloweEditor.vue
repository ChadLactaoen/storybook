<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Selection } from '../lib/harlowe/format'
import { commandTip } from '../lib/ui/commands'
import {
  BOLD,
  ITALIC,
  insertDisplay,
  insertLink,
  toggleBlockquote,
  toggleWrap,
} from '../lib/harlowe/format'
import { highlightHtml } from '../lib/harlowe/highlight'
import LinkPicker from './LinkPicker.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    /** Show the formatting buttons. The shortcuts work either way. */
    toolbar?: boolean
    /** Passages offered when linking, in canonical order. */
    targets?: readonly { code: string; title: string }[]
    /** Snippets offered to `(display:)`, in canonical order. */
    displayTargets?: readonly { code: string; title: string }[]
    /** False in a snippet, which cannot link: the link button and chord stand down. */
    canLink?: boolean
  }>(),
  { toolbar: false, targets: () => [], displayTargets: () => [], canLink: true },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /**
   * The author has left the field. Link resolution happens here rather than on
   * every keystroke, because it rewrites the very text they would be typing into.
   */
  settle: []
}>()

const textarea = ref<HTMLTextAreaElement | null>(null)
const highlight = ref<HTMLPreElement | null>(null)

const html = computed(() => highlightHtml(props.modelValue))

/**
 * The formatting buttons name their own chord, read off the command table so
 * they agree with the help panel. They used to be built from a local `MOD`
 * whose non-Mac branch carried a trailing space to make `${MOD}B` read right.
 */
const tip = commandTip

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

/* ---------- formatting ---------- */

/** What the author has selected right now, in the shape the transforms want. */
function selection(): Selection | null {
  const el = textarea.value
  if (!el) return null
  return { text: el.value, start: el.selectionStart, end: el.selectionEnd }
}

/**
 * Write a transform back.
 *
 * The textarea is controlled, so the new string goes out as an event and the
 * caret has to be put back by hand once Vue has re-rendered — the same dance
 * the Tab handler below has always done. One call is one `editBody`, which is
 * one undo entry.
 */
function apply(next: Selection) {
  const el = textarea.value
  if (!el) return
  emit('update:modelValue', next.text)
  requestAnimationFrame(() => {
    el.focus()
    el.selectionStart = next.start
    el.selectionEnd = next.end
  })
}

function wrap(marker: string) {
  const sel = selection()
  if (sel) apply(toggleWrap(sel, marker))
}

function quote() {
  const sel = selection()
  if (sel) apply(toggleBlockquote(sel))
}

/**
 * The selection as it stood when the picker opened. The picker takes focus, and
 * a textarea that has lost focus is not a reliable place to read a selection
 * back from, so it is remembered rather than re-read.
 */
const shell = ref<HTMLElement | null>(null)

/**
 * The open picker, if any, and what it will insert. One ref for both kinds, so
 * the blur guard below cannot cover one picker and forget the other.
 */
const picking = ref<{ sel: Selection; mode: 'link' | 'display' } | null>(null)

const linkLabel = computed(() => {
  const p = picking.value
  return p && p.mode === 'link' ? p.sel.text.slice(p.sel.start, p.sel.end) : ''
})

/**
 * Losing focus settles the body. The picker and the toolbar both steal focus
 * without the author having finished, so those cases are filtered out: a
 * transform is about to put the caret straight back.
 */
function onBlur(e: FocusEvent) {
  if (picking.value !== null) return
  const to = e.relatedTarget
  if (to instanceof Node && shell.value?.contains(to)) return
  emit('settle')
}

function openPicker(mode: 'link' | 'display') {
  const sel = selection()
  picking.value = sel === null ? null : { sel, mode }
}

function openLink() {
  if (props.canLink) openPicker('link')
}

function pick(target: string) {
  const p = picking.value
  picking.value = null
  if (p) apply(p.mode === 'link' ? insertLink(p.sel, target) : insertDisplay(p.sel, target))
}

function closePicker() {
  picking.value = null
  textarea.value?.focus()
}

/**
 * Formatting keys are handled here rather than in `useShortcuts`, because they
 * need the selection and mean nothing outside a text field. Propagation stops
 * so the window-level listener never sees them — it is not scoped to the
 * canvas, and plain ⌘K there opens the character cheat sheet.
 */
function command(e: KeyboardEvent, run: () => void) {
  e.preventDefault()
  e.stopPropagation()
  run()
}

function onKeyDown(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey) {
    const key = e.key.toLowerCase()
    if (!e.shiftKey && key === 'b') return command(e, () => wrap(BOLD))
    if (!e.shiftKey && key === 'i') return command(e, () => wrap(ITALIC))
    // Shift and a full stop arrive as `>` on most layouts and `.` on the rest.
    if (e.shiftKey && (key === '>' || key === '.')) return command(e, quote)
    if (e.shiftKey && key === 'k') return command(e, openLink)
    return
  }

  /** Tab indents instead of leaving the field; authors are writing prose here. */
  if (e.key !== 'Tab') return
  e.preventDefault()
  const el = e.target as HTMLTextAreaElement
  const { selectionStart: s, selectionEnd: end, value } = el
  emit('update:modelValue', value.slice(0, s) + '  ' + value.slice(end))
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = s + 2
  })
}

defineExpose({
  focus: () => textarea.value?.focus(),
  /** For an editor shown without its toolbar: the inspector's own button. */
  openDisplay: () => openPicker('display'),
})
</script>

<template>
  <div ref="shell" class="shell">
    <div v-if="toolbar" class="tools">
      <button class="tool" type="button" :title="tip('editor.bold')" @click="wrap(BOLD)">
        <b>B</b>
      </button>
      <button class="tool" type="button" :title="tip('editor.italic')" @click="wrap(ITALIC)">
        <i>I</i>
      </button>
      <button class="tool" type="button" :title="tip('editor.quote')" @click="quote">
        &ldquo;&rdquo;
      </button>
      <button
        v-if="canLink"
        class="tool"
        type="button"
        :title="tip('editor.link')"
        @click="openLink"
      >
        [[&thinsp;]]
      </button>
      <!-- Only once there is a snippet to show: an empty picker is a dead end. -->
      <button
        v-if="displayTargets.length > 0"
        class="tool tool-wide"
        type="button"
        data-display
        title="Show a snippet here: inserts (display: &quot;Code&quot;)"
        @click="openPicker('display')"
      >
        (display:)
      </button>
    </div>

    <LinkPicker
      v-if="picking"
      :targets="picking.mode === 'link' ? targets : displayTargets"
      :label="linkLabel"
      :creatable="picking.mode === 'link'"
      :verb="picking.mode === 'link' ? 'Link' : 'Display'"
      @pick="pick"
      @close="closePicker"
    />

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
        @blur="onBlur"
      />
    </div>
  </div>
</template>

<style scoped>
/* The shell carries the flex growth the editor used to, so the toolbar and the
   link picker can sit above it without touching the two stacked layers. */
.shell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-height: 0;
}

.tools {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* Matches the dense, borderless buttons used elsewhere (`.expand`, `.mini`)
   rather than `.btn`, which is far too heavy for a row of four. */
.tool {
  min-width: 26px;
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: 4px;
  background: none;
  font-size: 12px;
  color: var(--text-dim);
}

.tool:hover {
  background: var(--bg);
  color: var(--accent);
}

/* Written as the macro it inserts, so it reads as Harlowe rather than an icon. */
.tool-wide {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

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
