<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import HarloweEditor from './HarloweEditor.vue'

const props = defineProps<{ modelValue: string; title: string }>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
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
  // Escape inside the textarea should close too, so this listens on the window
  // rather than on the veil.
  if (e.key === 'Escape') emit('close')
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
          <strong class="name">{{ title }}</strong>
        </div>
        <button class="btn btn-ghost btn-icon" title="Close (Esc)" @click="emit('close')">
          &times;
        </button>
      </header>

      <p class="hint">
        Link with <code>[[Text|Target]]</code>, <code>[[Text-&gt;Target]]</code> or
        <code>[[Target&lt;-Text]]</code>. Linking to a passage that doesn&rsquo;t exist creates it.
      </p>

      <HarloweEditor ref="editor" v-model="body" />

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
.veil {
  position: fixed;
  inset: 0;
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
