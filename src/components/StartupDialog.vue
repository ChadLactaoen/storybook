<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { readFileText } from '../lib/doc/file'
import { localMeta } from '../lib/doc/storage'
import type { SavedMeta } from '../lib/doc/storage'
import * as store from '../stores/story'

const saved = ref<SavedMeta | null>(null)
const title = ref('Untitled Story')
const error = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)

onMounted(() => {
  saved.value = localMeta()
})

function whenSaved(meta: SavedMeta): string {
  const mins = Math.round((Date.now() - meta.savedAt) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hr ago`
  return new Date(meta.savedAt).toLocaleDateString()
}

async function open(file: File) {
  error.value = null
  try {
    store.loadStory(await readFileText(file))
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not open that file.'
  }
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) void open(file)
  input.value = ''
}

function onDrop(e: DragEvent) {
  dragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) void open(file)
}
</script>

<template>
  <div class="veil">
    <div
      class="dialog"
      :class="{ dragging }"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <h1>Storybook</h1>
      <p class="sub">Map every branch of a choose-your-own-adventure story.</p>

      <section v-if="saved" class="resume">
        <div>
          <strong>{{ saved.storyTitle }}</strong>
          <span class="meta">{{ saved.nodeCount }} passages &middot; saved {{ whenSaved(saved) }}</span>
        </div>
        <button class="btn btn-primary" @click="store.resumeStory()">Continue</button>
      </section>

      <section class="choice">
        <label class="label" for="new-title">New story</label>
        <div class="row">
          <input
            id="new-title"
            v-model="title"
            class="field"
            @keydown.enter.prevent="store.newStory(title)"
          />
          <button class="btn" :class="{ 'btn-primary': !saved }" @click="store.newStory(title)">
            Create
          </button>
        </div>
      </section>

      <section class="choice">
        <span class="label">Open an existing story</span>
        <button class="drop" @click="fileInput?.click()">
          <strong>Choose a .json file</strong>
          <span class="meta">or drop one anywhere on this panel</span>
        </button>
        <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFile" />
      </section>

      <p v-if="error" class="hint hint-error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.veil {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--bg);
}

.dialog {
  width: 100%;
  max-width: 420px;
  padding: 26px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: var(--shadow-lg);
  transition: border-color 0.12s;
}

.dialog.dragging {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-lg);
}

h1 {
  margin: 0;
  font-size: 22px;
  letter-spacing: -0.02em;
  color: var(--accent);
}

.sub {
  margin: 5px 0 22px;
  color: var(--text-dim);
}

.resume {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 20px;
  padding: 12px 14px;
  border: 1px solid var(--accent);
  border-radius: 9px;
  background: var(--accent-soft);
}

.resume strong {
  display: block;
}

.meta {
  display: block;
  font-size: 11px;
  color: var(--text-dim);
}

.choice + .choice {
  margin-top: 18px;
}

.row {
  display: flex;
  gap: 7px;
}

.row .field {
  flex: 1;
}

.drop {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 16px;
  border: 1px dashed var(--border-strong);
  border-radius: 9px;
  background: var(--panel-alt);
  text-align: center;
}

.drop:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}
</style>
