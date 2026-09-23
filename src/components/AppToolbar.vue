<script setup lang="ts">
import { computed, ref } from 'vue'
import { readFileText } from '../lib/doc/file'
import { formatCount } from '../lib/graph/paths'
import * as store from '../stores/story'
import AppMenuBar from './AppMenuBar.vue'
import { commandTip, type CommandBinding } from '../lib/ui/commands'

const props = defineProps<{ zoom: number; bindings: Record<string, CommandBinding> }>()

/**
 * What stays a button rather than a menu row.
 *
 * The bar held twenty-six controls and grew one with every feature; the long
 * tail now lives in `AppMenuBar`. What is left is what a canvas tool is worth
 * keeping one click away — the zoom stepper, undo and redo, and Play — plus the
 * readouts, which are not commands at all.
 */
const emit = defineEmits<{
  zoomIn: []
  zoomOut: []
  zoomToFit: []
  resetZoom: []
  openStats: []
  openReader: []
  openSettings: []
  menuOpen: [boolean]
}>()

/**
 * A button's tooltip, read off the command table.
 *
 * These strings used to be hand-written per button, which is how they came to
 * say the literal "Cmd" to Windows and Linux. `chordLabel` asks the platform.
 */
const tip = commandTip

const undoTitle = computed(() => tip('edit.undo'))
const redoTitle = computed(() => tip('edit.redo'))
/**
 * The command's own sentence now, which it could not be while ⌘P resumed a
 * reading and this button restarted it. Both open a fresh tab from the top.
 */
const playTitle = computed(() => tip('story.play'))

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

/**
 * Route counts are BigInt-backed strings, so pluralise on the formatted text.
 *
 * "Routes", not "paths": the inspector's tiles and the stats panel both call
 * this quantity a route, and this pill renders the identical
 * `pathsFrom(start)`. Three names for one number gave the author no way to see
 * they were the same thing.
 */
const pathsLabel = computed(
  () => `${totalPaths.value} ${totalPaths.value === '1' ? 'route' : 'routes'}`,
)

const fileInput = ref<HTMLInputElement | null>(null)

/** The Import command lives in the File menu; the input it needs is here. */
function pickFile() {
  fileInput.value?.click()
}

defineExpose({ pickFile })

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

    <AppMenuBar :bindings="props.bindings" @open-change="emit('menuOpen', $event)" />

    <div class="spacer" />

    <div class="group stats">
      <span class="pill">{{ plural(store.state.doc.nodes.length, 'passage') }}</span>
      <button
        class="pill paths"
        :title="tip('story.stats')"
        @click="emit('openStats')"
      >
        {{ pathsLabel }}
      </button>
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

    <div class="group zoom-group">
      <button class="btn btn-icon" :title="tip('view.zoomOut')" @click="emit('zoomOut')">
        &minus;
      </button>
      <button class="btn zoom" :title="tip('view.zoomReset')" @click="emit('resetZoom')">
        {{ zoomLabel }}
      </button>
      <button class="btn btn-icon" :title="tip('view.zoomIn')" @click="emit('zoomIn')">+</button>
      <button class="btn" :title="tip('view.zoomFit')" @click="emit('zoomToFit')">Fit</button>
    </div>

    <div class="group">
      <button
        class="btn btn-icon"
        :title="undoTitle"
        :disabled="!store.canUndo.value"
        @click="store.undo()"
      >
        &#8630;
      </button>
      <button
        class="btn btn-icon"
        :title="redoTitle"
        :disabled="!store.canRedo.value"
        @click="store.redo()"
      >
        &#8631;
      </button>

      <!-- Primary, and here rather than in a menu: an undiscoverable
           affordance for the headline feature is no affordance. Disabled with
           its reason when there is no first passage to start from. -->
      <button
        class="btn btn-primary"
        :disabled="store.state.doc.startNodeId === null"
        :title="
          store.state.doc.startNodeId === null
            ? 'Mark a passage as the start before reading'
            : playTitle
        "
        @click="emit('openReader')"
      >
        Play
      </button>
      <button class="btn btn-icon gear" title="Editor settings" @click="emit('openSettings')">
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
  /* No `overflow-x: auto` here: it used to hide the fact that twenty-six
     controls did not fit, and it would clip the menu panels hanging below. */
}

.group {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
}

.title-group {
  gap: 9px;
  min-width: 0;
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

/* The one pill that is also a button. It is a shortcut, not the way in — a pill
   reads as a readout however it is styled, so discovery belongs to the labelled
   Stats button and this just saves a trip for anyone who finds it. */
.pill.paths {
  cursor: pointer;
  font-family: inherit;
}

.pill.paths:hover {
  border-color: var(--accent);
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
/* The bar no longer scrolls, so it has to fit — and the menu panels need
   `overflow: visible` to hang below it, which means anything that does not fit
   would spill off-screen and be unreachable rather than scrolled to.
   The readouts are what give way: they are duplicated in Story → Stats, while
   every control here has no other home at this width. */
@media (max-width: 1200px) {
  .tally {
    display: none;
  }
}

@media (max-width: 1000px) {
  .saved {
    display: none;
  }

  .story-title {
    max-width: 120px;
  }
}

/* Below this the readouts go entirely: Play is the headline affordance and
   must never be the thing that falls off the edge. */
@media (max-width: 960px) {
  .group.stats {
    display: none;
  }
}

/* Last to go, because it is the one group every item of which is also a
   shortcut, a trackpad pinch, and a row in the View menu. */
@media (max-width: 780px) {
  .zoom-group {
    display: none;
  }
}
</style>
