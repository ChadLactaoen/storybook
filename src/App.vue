<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import AppToolbar from './components/AppToolbar.vue'
import StoryStatsPanel from './components/StoryStatsPanel.vue'
import MiniMap from './components/MiniMap.vue'
import NodeInspector from './components/NodeInspector.vue'
import SearchFilterBar from './components/SearchFilterBar.vue'
import StartupDialog from './components/StartupDialog.vue'
import StoryCanvas from './components/StoryCanvas.vue'
import CharacterCheatSheet from './components/CharacterCheatSheet.vue'
import CharacterSheet from './components/CharacterSheet.vue'
import EditorSettings from './components/EditorSettings.vue'
import RecodePanel from './components/RecodePanel.vue'
import HelpPanel from './components/HelpPanel.vue'
import StoryIndexPanel from './components/StoryIndexPanel.vue'
import StoryNotes from './components/StoryNotes.vue'
import { useShortcuts } from './composables/useShortcuts'
import { useViewport } from './composables/useViewport'
import { isPhantomId } from './lib/graph/constants'
import { prefs } from './stores/prefs'
import * as store from './stores/story'
import type { NodeState } from './types/story'

const canvasEl = ref<HTMLElement | null>(null)
const searchBar = ref<InstanceType<typeof SearchFilterBar> | null>(null)
const inspector = ref<InstanceType<typeof NodeInspector> | null>(null)
const inspectorOpen = ref(true)
/**
 * The left gutter holds at most one of the index and the cheat sheet. A single
 * ref rather than a boolean each: mutual exclusion is then structural, and
 * opening the cheat sheet cannot leave the index standing behind it.
 */
const leftPanel = ref<'index' | 'cheat' | null>(null)
/**
 * Notes is deliberately not part of `leftPanel`: it is the one gutter panel
 * that may share the column, and it describes the story rather than the
 * selection, so neither the exclusion above nor the watcher below applies.
 */
const notesOpen = ref(false)
const helpOpen = ref(false)
const settingsOpen = ref(false)
const recodeOpen = ref(false)
const statsOpen = ref(false)

/**
 * A full-screen modal owns the keyboard while it is up.
 *
 * Neither panel has a text field for the shortcut layer's `isTyping` guard to
 * catch, so without this `n` would still create a passage and Delete would
 * still delete one, behind the veil and out of sight.
 */
const modalOpen = computed(
  () => helpOpen.value || settingsOpen.value || recodeOpen.value || statsOpen.value,
)

function toggleIndex() {
  leftPanel.value = leftPanel.value === 'index' ? null : 'index'
}

// No guard, unlike `toggleCheatSheet`: there is always a story, so there are
// always notes.
function toggleNotes() {
  notesOpen.value = !notesOpen.value
}

/**
 * How far the expanded editor's veil stops short of the left edge.
 *
 * The gutter is left lit only when nothing in it can change what that editor is
 * editing. The cheat sheet is read-only and the notes pad writes a story-level
 * field, so both are safe. The index is not — its rows call `select`, and the
 * open dialog is bound to the selection, so one click there would swap the
 * passage being edited mid-keystroke. While the index is up the veil covers the
 * whole column, Notes included.
 */
const veilInset = computed(() =>
  leftPanel.value !== 'index' && (leftPanel.value === 'cheat' || notesOpen.value)
    ? 'var(--left-panel-w)'
    : '0px',
)

// The cheat sheet is a companion to the passage sidebar: it has no meaning once
// that sidebar is gone, whether it was closed or the selection was cleared.
// Only `leftPanel` is touched — story notes outlive the selection.
watch(
  () => inspectorOpen.value && store.selected.value !== null,
  (showing) => {
    if (!showing && leftPanel.value === 'cheat') leftPanel.value = null
  },
)

/**
 * Shown once, under the toolbar, on a story the author has not built out yet.
 * A pointer to the help panel rather than a tour: cheap to ignore, and it stops
 * appearing the moment it is dismissed or the story grows.
 */
const HELP_SEEN_KEY = 'storybook.helpSeen.v1'
const helpSeen = ref(true)

function dismissHint() {
  helpSeen.value = true
  try {
    localStorage.setItem(HELP_SEEN_KEY, '1')
  } catch {
    // Private browsing: the hint simply returns next time.
  }
}

function openHelp() {
  helpOpen.value = true
  dismissHint()
}

const showHint = computed(
  () => !helpSeen.value && store.state.started && store.state.doc.nodes.length <= 2,
)
const showLevels = ref(true)
const showMinimap = ref(true)

const vp = useViewport(canvasEl)

const layout = store.layout

const stateOf = computed(
  () => new Map<string, NodeState>(store.state.doc.nodes.map((n) => [n.id, n.state])),
)
const tagsOf = computed(
  () => new Map<string, string[]>(store.state.doc.nodes.map((n) => [n.id, n.tags])),
)
/** Phantoms are absent by construction, so the card falls back to `false`. */
const isEndingOf = computed(
  () => new Map<string, boolean>(store.state.doc.nodes.map((n) => [n.id, n.isEnding])),
)

function fit() {
  vp.zoomToFit(layout.value.bounds)
}

// Fit once the canvas has a size, then again whenever a story is opened.
watch(
  () => store.state.started,
  (started) => {
    if (started) void nextTick(() => requestAnimationFrame(fit))
  },
  { immediate: true },
)

function openPassage(id: string) {
  store.select(id)
  // A phantom has a card and a place on the canvas but no passage behind it, so
  // the inspector would open on nothing. Centring still answers the question
  // the author asked by clicking a Broken links row: where is it.
  if (!isPhantomId(id)) inspectorOpen.value = true
  const n = layout.value.nodeById.get(id)
  if (n) vp.centerOn(n.x, n.y)
}

// The guard, the notice and the empty-selection case all live in the store, so
// the keyboard path and the inspector button cannot drift apart.
function deleteSelected() {
  store.removeSelected()
}

async function toggleBodyEditor() {
  // The resolved node, not the id: a phantom card is selectable, and the
  // inspector it would open is behind `v-if="node && geom"`.
  if (!store.selected.value) return
  // The sidebar may be closed behind the "Show passage" button; the shortcut
  // should still work, so mount it first and toggle on the next tick.
  if (!inspectorOpen.value) {
    inspectorOpen.value = true
    await nextTick()
  }
  inspector.value?.toggleExpanded()
}

// The cheat sheet is a companion to the passage sidebar — the watcher above
// closes it when that sidebar goes away — so opening it means opening both.
// No cast in the passage is not a reason to refuse: the panel says so itself.
function toggleCheatSheet() {
  if (!store.selected.value) return
  inspectorOpen.value = true
  leftPanel.value = leftPanel.value === 'cheat' ? null : 'cheat'
}

useShortcuts({
  zoomIn: vp.zoomIn,
  zoomOut: vp.zoomOut,
  zoomToFit: fit,
  resetZoom: vp.resetZoom,
  undo: store.undo,
  redo: store.redo,
  addPassage: () => store.addPassage(store.state.selectedId ?? undefined),
  deletePassage: deleteSelected,
  focusSearch: () => searchBar.value?.focus(),
  toggleBodyEditor: () => void toggleBodyEditor(),
  toggleCheatSheet,
  toggleNotes,
  openHelp: () => (helpOpen.value = true),
  openStats: () => (statsOpen.value = !statsOpen.value),
  statsOpen: () => statsOpen.value,
  dialogOpen: () => modalOpen.value || (inspector.value?.isExpanded() ?? false),
  modalOpen: () => modalOpen.value,
})

onMounted(() => {
  try {
    helpSeen.value = localStorage.getItem(HELP_SEEN_KEY) === '1'
  } catch {
    helpSeen.value = true
  }
})

const notices = computed(() => {
  const out = [...store.state.warnings]
  if (store.state.notice) out.push(store.state.notice)
  return out
})

function dismissNotices() {
  store.state.warnings = []
  store.state.notice = null
}
</script>

<template>
  <StartupDialog v-if="!store.state.started" />

  <!-- --veil-inset rides the DOM down to BodyDialog's fixed veil, which would
       otherwise dim and block the gutter the author is editing against. See
       `veilInset` for which panels earn it and why the index never does. -->
  <div v-else class="app" :style="{ '--veil-inset': veilInset }">
    <AppToolbar
      :zoom="vp.view.k"
      @zoom-in="vp.zoomIn"
      @zoom-out="vp.zoomOut"
      @zoom-to-fit="fit"
      @reset-zoom="vp.resetZoom"
      @toggle-levels="showLevels = !showLevels"
      @toggle-minimap="showMinimap = !showMinimap"
      @toggle-index="toggleIndex"
      @toggle-notes="toggleNotes"
      @open-help="openHelp"
      @open-stats="statsOpen = true"
      @open-settings="settingsOpen = true"
      @open-recode="recodeOpen = true"
    />

    <SearchFilterBar ref="searchBar" />

    <div v-if="showHint" class="first-run">
      <span>
        New here? The tree lays itself out from the links you write &mdash;
        <button class="link" @click="openHelp">see how it works</button>.
      </span>
      <button class="btn btn-ghost btn-icon" title="Dismiss" @click="dismissHint">&times;</button>
    </div>

    <div v-if="notices.length > 0" class="notices">
      <p v-for="(note, i) in notices" :key="i">{{ note }}</p>
      <button class="btn btn-ghost btn-icon" title="Dismiss" @click="dismissNotices">&times;</button>
    </div>

    <main>
      <!-- One stack, ordered by the DOM: whichever of the two upper panels is
           open, then Notes underneath it. Absent entirely when it holds
           nothing — an empty gutter is still 320px of border and background. -->
      <div v-if="leftPanel !== null || notesOpen" class="left-gutter">
        <StoryIndexPanel v-if="leftPanel === 'index'" @close="leftPanel = null" />
        <CharacterCheatSheet v-if="leftPanel === 'cheat'" @close="leftPanel = null" />
        <StoryNotes v-if="notesOpen" @close="notesOpen = false" />
      </div>

      <div ref="canvasEl" class="stage">
        <StoryCanvas
          :layout="layout"
          :transform="vp.transform.value"
          :svg-transform="vp.svgTransform.value"
          :detailed="vp.detailed.value"
          :panning="vp.panning.value"
          :selected-id="store.state.selectedId"
          :selected-ids="store.selectedIdSet.value"
          :start-node-id="store.state.doc.startNodeId"
          :matches="store.matches.value"
          :state-of="stateOf"
          :tags-of="tagsOf"
          :tag-colors="store.tagColors.value"
          :show-levels="showLevels"
          :show-codes="prefs.showCodes"
          :run-of="store.cardSlugs.value"
          :is-ending-of="isEndingOf"
          @select="store.applySelect"
          @open="openPassage"
          @create="store.createFromPhantom($event)"
          @wheel="vp.onWheel"
          @pointerdown="vp.onPointerDown"
          @pointermove="vp.onPointerMove"
          @pointerup="vp.onPointerUp"
        />

        <MiniMap
          v-if="showMinimap && layout.nodes.length > 1"
          :layout="layout"
          :view="vp.view"
          :size="vp.size"
          :state-of="stateOf"
          :selected-id="store.state.selectedId"
          :selected-ids="store.selectedIdSet.value"
          @goto="vp.centerOn"
        />

        <button
          v-if="!inspectorOpen && store.selected.value"
          class="btn reopen"
          @click="inspectorOpen = true"
        >
          Show passage
        </button>
      </div>

      <NodeInspector
        v-if="inspectorOpen"
        ref="inspector"
        @close="inspectorOpen = false"
        @cheat-sheet="leftPanel = 'cheat'"
        @open="openPassage"
      />
    </main>

    <!-- Mounted once at the shell so both the index and a passage's cast open
         the same sheet. -->
    <HelpPanel v-if="helpOpen" @close="helpOpen = false" />

    <EditorSettings v-if="settingsOpen" @close="settingsOpen = false" />

    <RecodePanel v-if="recodeOpen" @close="recodeOpen = false" />
    <StoryStatsPanel v-if="statsOpen" @close="statsOpen = false" @open="openPassage" />

    <CharacterSheet
      v-if="store.state.openCharacter"
      :key="store.state.openCharacter"
      :name="store.state.openCharacter"
      @close="store.closeCharacterSheet()"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

main {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* --left-panel-w, not --sidebar-w: the three panels that can appear here share
   one column, and swapping between them must not reflow the stage. The gutter
   owns the width so its occupants only decide how tall they are. */
.left-gutter {
  display: flex;
  flex-direction: column;
  width: var(--left-panel-w);
  flex: 0 0 var(--left-panel-w);
  min-height: 0;
  border-right: 1px solid var(--border);
}

/* The gutter is a stack, so the rule between its occupants belongs to the
   stack. On either panel it would draw when that panel stood alone. */
.left-gutter > * + * {
  border-top: 1px solid var(--border);
}

.stage {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
}

.notices {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex: 0 0 auto;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--draft) 12%, var(--panel));
  font-size: 12px;
}

.notices p {
  margin: 0;
  flex: 1;
}

.first-run {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--accent-soft);
  font-size: 12px;
}

.first-run span {
  flex: 1;
}

.first-run .link {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-weight: 600;
  color: var(--accent);
  text-decoration: underline;
}

.reopen {
  position: absolute;
  top: 12px;
  right: 12px;
  box-shadow: var(--shadow-md);
}
</style>
