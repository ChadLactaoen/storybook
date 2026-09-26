<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as store from '../stores/story'
import HarloweEditor from './HarloweEditor.vue'

const props = defineProps<{
  modelValue: string
  /** How the passage is named in the header: its code and title together. */
  label: string
  /** Passages offered when linking, in canonical order. */
  targets: readonly { code: string; title: string }[]
  /** Snippets offered to `(display:)`, in canonical order. */
  displayTargets?: readonly { code: string; title: string }[]
  /** False in a snippet, which cannot link. */
  canLink?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  settle: []
  close: []
}>()

/**
 * The same editor as the inspector, given the whole window. It writes through
 * the identical v-model, so there is no draft to reconcile — closing the dialog
 * is not a commit, and everything typed here is already in the document.
 */

const editor = ref<InstanceType<typeof HarloweEditor> | null>(null)

const body = computed({
  get: () => props.modelValue,
  set: (v: string) => emit('update:modelValue', v),
})

/** Counted on the prose the author sees, not on a tokenised view of it. */
const stats = computed(() => {
  const words = props.modelValue.trim().length === 0 ? 0 : props.modelValue.trim().split(/\s+/).length
  const links = props.modelValue.match(/\[\[/g)?.length ?? 0
  return { words, links }
})

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  // The character sheet stacks above this dialog — the cheat sheet beside us
  // stays clickable, and its "Edit" link opens one. A window listener fires
  // wherever focus sits, so without this it would close us underneath the
  // sheet the author is actually looking at. Escape closes the top only.
  if (store.state.openCharacter) return
  // Escape inside the textarea should close too, so this listens on the window
  // rather than on the veil.
  emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  editor.value?.focus()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="veil" @click.self="emit('close')">
    <div class="sheet" role="dialog" aria-label="Edit passage body">
      <header>
        <div class="who">
          <span class="eyebrow">Body</span>
          <strong class="name">{{ label }}</strong>
        </div>
        <button class="btn btn-ghost btn-icon" title="Close (Esc)" @click="emit('close')">
          &times;
        </button>
      </header>

      <p class="hint">
        Link with <code>[[Text|Code]]</code>, <code>[[Text-&gt;Code]]</code> or
        <code>[[Code&lt;-Text]]</code>. A link to a code that doesn&rsquo;t exist creates the passage
        when you leave the editor.
      </p>

      <HarloweEditor
        ref="editor"
        v-model="body"
        toolbar
        :targets="targets"
        :display-targets="displayTargets ?? []"
        :can-link="canLink !== false"
        @settle="emit('settle')"
      />

      <footer>
        <span class="muted">
          {{ stats.words }} {{ stats.words === 1 ? 'word' : 'words' }} &middot;
          {{ stats.links }} {{ stats.links === 1 ? 'link' : 'links' }} &middot; saved as you type
        </span>
        <button class="btn btn-primary" @click="emit('close')">Done</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Inset from the left by whatever the left gutter is holding (App publishes
   --veil-inset): the cheat sheet is reference material for the passage being
   written here, so it stays lit and clickable rather than dimmed behind us. */
.veil {
  position: fixed;
  inset: 0;
  left: var(--veil-inset, 0px);
  z-index: 92;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--text) 32%, transparent);
}

.sheet {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 1040px;
  height: 100%;
  max-height: 880px;
  padding: 0 18px 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel-alt);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 -18px;
  padding: 10px 10px 10px 18px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

.who {
  display: flex;
  align-items: baseline;
  gap: 9px;
  min-width: 0;
}

.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.name {
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-dim);
  flex: 0 0 auto;
}

code {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 1px 3px;
  border-radius: 3px;
  background: var(--bg);
}

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 -18px;
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}

.muted {
  font-size: 11px;
  color: var(--text-faint);
}
</style>
