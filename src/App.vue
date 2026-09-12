<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import AppToolbar from './components/AppToolbar.vue'
import MiniMap from './components/MiniMap.vue'
import NodeInspector from './components/NodeInspector.vue'
import SearchFilterBar from './components/SearchFilterBar.vue'
import StartupDialog from './components/StartupDialog.vue'
import StoryCanvas from './components/StoryCanvas.vue'
import CharacterCheatSheet from './components/CharacterCheatSheet.vue'
import CharacterSheet from './components/CharacterSheet.vue'
import HelpPanel from './components/HelpPanel.vue'
import StoryIndexPanel from './components/StoryIndexPanel.vue'
import { useShortcuts } from './composables/useShortcuts'
import { useViewport } from './composables/useViewport'
import * as store from './stores/story'
import type { NodeState } from './types/story'

const canvasEl = ref<HTMLElement | null>(null)
const searchBar = ref<InstanceType<typeof SearchFilterBar> | null>(null)
const inspector = ref<InstanceType<typeof NodeInspector> | null>(null)
const inspectorOpen = ref(true)
/**
 * The left gutter holds one panel at a time. A single ref rather than a boolean
 * each: mutual exclusion is then structural, and opening the cheat sheet cannot
 * leave the index standing behind it.
 */
const leftPanel = ref<'index' | 'cheat' | null>(null)
const helpOpen = ref(false)

function toggleIndex() {
  leftPanel.value = leftPanel.value === 'index' ? null : 'index'
}

// The cheat sheet is a companion to the passage sidebar: it has no meaning once
// that sidebar is gone, whether it was closed or the selection was cleared.
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
const codeOf = computed(
  () => new Map<string, string>(store.state.doc.nodes.map((n) => [n.id, n.code])),
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
  inspectorOpen.value = true
  const n = layout.value.nodeById.get(id)
  if (n) vp.centerOn(n.x, n.y)
}

function deleteSelected() {
  if (store.state.selectedId) store.removePassage(store.state.selectedId)
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
  openHelp: () => (helpOpen.value = true),
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
       otherwise dim and block the cheat sheet the author is editing against.
       Only the cheat sheet earns it: selecting a passage in the index would
       swap the node that open dialog is editing, mid-keystroke. -->
  <div
    v-else
    class="app"
    :style="{ '--veil-inset': leftPanel === 'cheat' ? 'var(--left-panel-w)' : '0px' }"
  >
    <AppToolbar
      :zoom="vp.view.k"
      @zoom-in="vp.zoomIn"
      @zoom-out="vp.zoomOut"
      @zoom-to-fit="fit"
      @reset-zoom="vp.resetZoom"
      @toggle-levels="showLevels = !showLevels"
      @toggle-minimap="showMinimap = !showMinimap"
      @toggle-index="toggleIndex"
      @open-help="openHelp"
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
      <StoryIndexPanel v-if="leftPanel === 'index'" @close="leftPanel = null" />
      <CharacterCheatSheet v-if="leftPanel === 'cheat'" @close="leftPanel = null" />

      <div ref="canvasEl" class="stage">
        <StoryCanvas
          :layout="layout"
          :transform="vp.transform.value"
          :svg-transform="vp.svgTransform.value"
          :detailed="vp.detailed.value"
          :panning="vp.panning.value"
          :selected-id="store.state.selectedId"
          :start-node-id="store.state.doc.startNodeId"
          :matches="store.matches.value"
          :state-of="stateOf"
          :tags-of="tagsOf"
          :code-of="codeOf"
          :tag-colors="store.tagColors.value"
          :show-levels="showLevels"
          @select="store.select($event)"
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
      />
    </main>

    <!-- Mounted once at the shell so both the index and a passage's cast open
         the same sheet. -->
    <HelpPanel v-if="helpOpen" @close="helpOpen = false" />

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
