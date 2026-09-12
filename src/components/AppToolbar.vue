<script setup lang="ts">
import { computed, ref } from 'vue'
import { readFileText } from '../lib/doc/file'
import { formatCount } from '../lib/graph/paths'
import * as store from '../stores/story'

const props = defineProps<{ zoom: number }>()

const emit = defineEmits<{
  zoomIn: []
  zoomOut: []
  zoomToFit: []
  resetZoom: []
  toggleLevels: []
  toggleMinimap: []
  toggleIndex: []
  openHelp: []
  openSettings: []
}>()

const editingTitle = ref(false)
const titleDraft = ref('')

function startEdit() {
  titleDraft.value = store.state.doc.storyTitle
  editingTitle.value = true
}

function commitTitle() {
  store.renameStory(titleDraft.value)
  editingTitle.value = false
}

const totalPaths = computed(() => {
  const start = store.state.doc.startNodeId
  return start ? formatCount(store.pathsFrom(start)) : '0'
})

const counts = computed(() => {
  const out = { TODO: 0, Draft: 0, Done: 0 }
  for (const n of store.state.doc.nodes) out[n.state]++
  return out
})

const savedLabel = computed(() => {
  if (store.state.savedAt === null) return 'Not saved'
  const d = new Date(store.state.savedAt)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `Saved ${hh}:${mm}`
})

const zoomLabel = computed(() => `${Math.round(props.zoom * 100)}%`)

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Path counts are BigInt-backed strings, so pluralise on the formatted text. */
const pathsLabel = computed(() => `${totalPaths.value} ${totalPaths.value === '1' ? 'path' : 'paths'}`)

const fileInput = ref<HTMLInputElement | null>(null)

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    store.loadStory(await readFileText(file))
  } catch (err) {
    store.state.notice = err instanceof Error ? err.message : 'Could not open that file.'
  }
  input.value = ''
}
</script>

<template>
  <header class="toolbar">
    <div class="group title-group">
      <span class="logo">Storybook</span>
      <input
        v-if="editingTitle"
        v-model="titleDraft"
        class="field title-field"
        autofocus
        @blur="commitTitle"
        @keydown.enter.prevent="commitTitle"
        @keydown.esc="editingTitle = false"
      />
      <button v-else class="story-title" title="Rename story" @click="startEdit">
        {{ store.state.doc.storyTitle }}
      </button>
      <span class="saved">{{ savedLabel }}</span>
    </div>

    <div class="group">
      <button class="btn" title="Every character and setting, with passage counts" @click="emit('toggleIndex')">
        Cast &amp; Settings
      </button>
      <button class="btn" title="Add a passage with no links to it yet" @click="store.addPassage()">
        + Passage
      </button>
      <button class="btn btn-icon" title="Undo (Cmd Z)" :disabled="!store.canUndo.value" @click="store.undo()">
        &#8630;
      </button>
      <button class="btn btn-icon" title="Redo (Cmd Shift Z)" :disabled="!store.canRedo.value" @click="store.redo()">
        &#8631;
      </button>
    </div>

    <div class="spacer" />

    <div class="group stats">
      <span class="pill">{{ plural(store.state.doc.nodes.length, 'passage') }}</span>
      <span class="pill paths" title="Distinct routes from the start passage to an ending">
        {{ pathsLabel }}
      </span>
      <!-- Named, not just coloured: these are the only legend for the status
           dot on each card, so bare digits left it unexplained. -->
      <span class="tally">
        <span class="tick state-TODO" title="Passages still to write">
          <span class="dot" />{{ counts.TODO }} TODO
        </span>
        <span class="tick state-Draft" title="Passages in draft">
          <span class="dot" />{{ counts.Draft }} Draft
        </span>
        <span class="tick state-Done" title="Finished passages">
          <span class="dot" />{{ counts.Done }} Done
        </span>
      </span>
    </div>

    <div class="group">
      <button class="btn btn-icon" title="Zoom out (Cmd -)" @click="emit('zoomOut')">&minus;</button>
      <button class="btn zoom" title="Reset to 100% (Cmd 1)" @click="emit('resetZoom')">
        {{ zoomLabel }}
      </button>
      <button class="btn btn-icon" title="Zoom in (Cmd +)" @click="emit('zoomIn')">+</button>
      <button class="btn" title="Zoom to fit (Cmd 0)" @click="emit('zoomToFit')">Fit</button>
    </div>

    <div class="group">
      <button class="btn" title="Show or hide the level guide lines" @click="emit('toggleLevels')">
        Levels
      </button>
      <button class="btn" title="Show or hide the minimap" @click="emit('toggleMinimap')">
        Map
      </button>
      <button class="btn" title="Download the story as JSON" @click="store.saveToFile()">Export</button>
      <button class="btn" title="Open a story JSON file" @click="fileInput?.click()">Import</button>
      <button class="btn btn-icon help" title="How Storybook works (?)" @click="emit('openHelp')">
        ?
      </button>
      <button class="btn btn-icon gear" title="Settings" @click="emit('openSettings')">
        &#9881;
      </button>
      <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFile" />
    </div>
  </header>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  height: var(--toolbar-h);
  flex: 0 0 auto;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  overflow-x: auto;
}

.group {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
}

.title-group {
  gap: 9px;
}

.spacer {
  flex: 1;
}

.logo {
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--accent);
}

.story-title {
  padding: 3px 7px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: none;
  font-weight: 600;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-title:hover {
  border-color: var(--border);
}

.title-field {
  width: 200px;
  height: 26px;
}

.saved {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
}

.help {
  font-weight: 700;
  color: var(--accent);
}

/* The button box is fixed by .btn/.btn-icon at 28px square, so the glyph can be
   sized freely. line-height is pinned because the inherited 1.45 would other-
   wise scale with it and nudge the icon off centre. */
.gear {
  font-size: 18px;
  line-height: 1;
  color: var(--text-dim);
}

.zoom {
  min-width: 54px;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}

.pill {
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  font-size: 11px;
  white-space: nowrap;
}

.pill.paths {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  background: var(--accent-soft);
  font-weight: 600;
}

.tally {
  display: flex;
  gap: 3px;
}

.tick .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--state);
}

.tick {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 5px;
  text-align: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--state);
  background: color-mix(in srgb, var(--state) 13%, transparent);
  border: 1px solid color-mix(in srgb, var(--state) 28%, transparent);
}
</style>
