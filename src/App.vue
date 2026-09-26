<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import AppToolbar from './components/AppToolbar.vue'
import StoryStatsPanel from './components/StoryStatsPanel.vue'
import TagAnalyzerPanel from './components/TagAnalyzerPanel.vue'
import CastAnalyzerPanel from './components/CastAnalyzerPanel.vue'
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
import type { CommandBinding } from './lib/ui/commands'
import { useViewport } from './composables/useViewport'
import { isPhantomId } from './lib/graph/constants'
import { prefs, setPref } from './stores/prefs'
import * as store from './stores/story'
import { NODE_STATES } from './types/story'

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
const tagsOpen = ref(false)
const castOpen = ref(false)

/**
 * A full-screen modal owns the keyboard while it is up.
 *
 * Neither panel has a text field for the shortcut layer's `isTyping` guard to
 * catch, so without this `n` would still create a passage and Delete would
 * still delete one, behind the veil and out of sight.
 */
const modalOpen = computed(
  () =>
    // The startup dialog counts. It sits above everything at z-index 101, so a
    // key that opened a panel under it would put one out of sight.
    !store.state.started ||
    helpOpen.value ||
    settingsOpen.value ||
    recodeOpen.value ||
    statsOpen.value ||
    tagsOpen.value ||
    castOpen.value ||
    // The character sheet is a veil like the rest, and its buttons put focus on
    // a `<button>` — so neither `isTyping` nor anything else catches it. Without
    // it here, `n`, Delete and `E` all reach the canvas underneath: pressing E
    // while a branch is selected would mark every passage in it as an ending,
    // behind the veil and out of sight.
    store.state.openCharacter !== null,
)

/**
 * Play the story in a new tab, from its first passage or one the author picked.
 *
 * Synchronous all the way down to `window.open`, which is what lets it through
 * a popup blocker: every caller is a click or a key press.
 */
function openReader(nodeId?: string) {
  store.playInTab(nodeId)
}

/**
 * Play from the selected passage — the inspector's Play from here, for the
 * menu row and the `p` key. `selected` is null for a phantom anchor as well as for no
 * selection, and a phantom has no passage for the player to open.
 */
function playHere() {
  const node = store.selected.value
  // A snippet is on no route, so there is nowhere to play it from.
  if (node && !node.isSnippet) openReader(node.id)
}

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

// The three fields the cards draw that layout knows nothing about. They are
// memoized in the store so they keep their identity across an edit that did not
// touch them — built here, a fresh Map per keystroke re-rendered every card,
// whatever the layout memo said. Phantoms are absent from all three by
// construction, so each card falls back.
const stateOf = store.cardStates
const tagsOf = store.cardTags
const isEndingOf = store.cardEndings

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

/**
 * A menu is open. Deliberately not part of `modalOpen` — it is not a veil, and
 * the canvas keys go on working under it — but the unmodified keys stand down,
 * or `n` would add a passage behind the open panel.
 */
const menuOpen = ref(false)

/** Held only so the Import command can reach the toolbar's hidden file input. */
const toolbar = ref<InstanceType<typeof AppToolbar> | null>(null)

/**
 * What each command in the bar actually does.
 *
 * `commands.ts` describes them; this binds them, and it lives here because
 * every flag it reads — the panel refs above, the viewport, the store — is
 * already in this component. Menu items toggle rather than open, matching what
 * the keyboard has always done: the toolbar's buttons used to only ever set a
 * flag true, so the button could open a sheet but never close it.
 */
const commandBindings = computed<Record<string, CommandBinding>>(() => ({
  'file.import': { run: () => toolbar.value?.pickFile() },
  'file.export': { run: store.saveToFile },
  'file.publish': {
    run: () => void store.publishToFile(),
    // Same gate as Play: with no start passage there is no route into the
    // story, so there is nothing a reader could open.
    enabled: store.state.doc.startNodeId !== null && !store.publishing.value,
  },

  'edit.undo': { run: store.undo, enabled: store.canUndo.value },
  'edit.redo': { run: store.redo, enabled: store.canRedo.value },
  'edit.passageAdd': { run: () => store.addPassage(store.state.selectedId ?? undefined) },
  'edit.passageAddFree': { run: () => store.addPassage() },
  'edit.snippetAdd': { run: () => openPassage(store.addSnippet()) },
  'edit.passageDelete': {
    run: deleteSelected,
    enabled: store.state.selectedIds.length > 0 || store.state.selectedId !== null,
  },
  'edit.passageEnding': {
    run: store.endingToggleSelected,
    // The selection's story passages rather than the anchor: a phantom is
    // selectable and has no passage to mark, and a snippet is never an ending,
    // so Delete's looser test would enable a no-op here.
    enabled: store.selectedStoryNodes.value.length > 0,
    checked: store.allSelectedEndings.value,
  },
  // Derived rather than written out three times: the ids, the ticks and the
  // order all come off `NODE_STATES`, which is the same list the sidebar's
  // segmented control and the digit keys read.
  ...Object.fromEntries(
    NODE_STATES.map((s) => [
      `edit.state${s}`,
      {
        run: () => store.changeStateSelected(s),
        enabled: store.state.selectedIds.length > 0,
        checked: store.selectedState.value === s,
      },
    ]),
  ),
  // `canNudge*` rather than a selection-size test: a mixed set has no shared
  // move, so the row dims rather than doing half of one.
  'edit.levelDown': {
    run: () => store.levelNudgeSelected(1),
    enabled: store.canNudgeSelectedDown.value,
  },
  'edit.levelUp': {
    run: () => store.levelNudgeSelected(-1),
    enabled: store.canNudgeSelectedUp.value,
  },
  'edit.recode': { run: () => (recodeOpen.value = true) },

  'view.zoomIn': { run: vp.zoomIn },
  'view.zoomOut': { run: vp.zoomOut },
  'view.zoomReset': { run: vp.resetZoom },
  'view.zoomFit': { run: fit },
  'view.levels': { run: () => (showLevels.value = !showLevels.value), checked: showLevels.value },
  'view.minimap': {
    run: () => (showMinimap.value = !showMinimap.value),
    checked: showMinimap.value,
  },
  // One setting behind three rows, so the group reads as a choice rather than
  // as independent switches that could all be off. Each row sets its own mode
  // outright — none of them toggles, so clicking the ticked one is a no-op
  // rather than a way to end up with no packing chosen at all.
  'view.packBalanced': {
    run: () => store.setDrawingPref('packing', 'balanced'),
    checked: prefs.packing === 'balanced',
  },
  'view.packAligned': {
    run: () => store.setDrawingPref('packing', 'aligned'),
    checked: prefs.packing === 'aligned',
  },
  'view.packStraight': {
    run: () => store.setDrawingPref('packing', 'straight'),
    checked: prefs.packing === 'straight',
  },
  'view.compact': {
    run: () => store.setDrawingPref('compactSpacing', !prefs.compactSpacing),
    checked: prefs.compactSpacing,
  },

  'story.play': { run: () => openReader(), enabled: store.state.doc.startNodeId !== null },
  // No start-passage gate: the inspector button has none either, since a
  // passage picked by hand is a start of its own.
  'passage.play': {
    run: playHere,
    enabled: store.selected.value !== null && !store.selected.value.isSnippet,
  },
  'story.stats': { run: () => (statsOpen.value = !statsOpen.value) },
  'story.tags': { run: () => (tagsOpen.value = !tagsOpen.value) },
  'story.characters': { run: () => (castOpen.value = !castOpen.value) },
  'story.index': { run: toggleIndex, checked: leftPanel.value === 'index' },
  // `toggleCheatSheet` itself rather than a second copy of it, so the row and
  // Cmd K cannot drift: same refusal without a passage, same forced sidebar.
  // `selected` is null for a phantom anchor as well as for nothing at all,
  // which is exactly when that function returns early — so the dim states what
  // the key would do.
  'passage.cheatSheet': {
    run: toggleCheatSheet,
    enabled: store.selected.value !== null,
    checked: leftPanel.value === 'cheat',
  },
  'story.notes': { run: toggleNotes, checked: notesOpen.value },

  'help.about': { run: openHelp },
  'help.settings': { run: () => (settingsOpen.value = true) },

  // The whole Developer menu hangs off `visible`: with the mode off neither row
  // renders, and `AppMenuBar` then drops the title too. `setPref` rather than
  // `setDrawingPref` — text moves no card, so there is nothing to lay out again
  // and nothing for `configKey` to say.
  'dev.exportSkeleton': { run: store.saveSkeletonToFile, visible: prefs.devMode },
  'dev.hideText': {
    run: () => setPref('hideCardText', !prefs.hideCardText),
    checked: prefs.hideCardText,
    visible: prefs.devMode,
  },
}))

useShortcuts({
  zoomIn: vp.zoomIn,
  zoomOut: vp.zoomOut,
  zoomToFit: fit,
  resetZoom: vp.resetZoom,
  undo: store.undo,
  redo: store.redo,
  addPassage: () => store.addPassage(store.state.selectedId ?? undefined),
  deletePassage: deleteSelected,
  toggleEnding: store.endingToggleSelected,
  setState: store.changeStateSelected,
  focusSearch: () => searchBar.value?.focus(),
  toggleBodyEditor: () => void toggleBodyEditor(),
  toggleCheatSheet,
  toggleNotes,
  toggleIndex,
  openHelp: () => (helpOpen.value = true),
  openStats: () => (statsOpen.value = !statsOpen.value),
  statsOpen: () => statsOpen.value,
  openTags: () => (tagsOpen.value = !tagsOpen.value),
  tagsOpen: () => tagsOpen.value,
  dialogOpen: () => modalOpen.value || (inspector.value?.isExpanded() ?? false),
  modalOpen: () => modalOpen.value,
  // Gated like the menu row and the toolbar button: a chord is not a way round
  // a command that is switched off.
  play: () => {
    if (store.state.doc.startNodeId !== null) openReader()
  },
  playHere,
  menuOpen: () => menuOpen.value,
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
      ref="toolbar"
      :zoom="vp.view.k"
      :bindings="commandBindings"
      @zoom-in="vp.zoomIn"
      @zoom-out="vp.zoomOut"
      @zoom-to-fit="fit"
      @reset-zoom="vp.resetZoom"
      @open-stats="statsOpen = !statsOpen"
      @open-reader="openReader()"
      @open-settings="settingsOpen = true"
      @menu-open="menuOpen = $event"
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
        :textless="prefs.hideCardText"
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
        @play="openReader"
      />
    </main>

    <!-- Mounted once at the shell so both the index and a passage's cast open
         the same sheet. -->
    <HelpPanel v-if="helpOpen" @close="helpOpen = false" />

    <EditorSettings v-if="settingsOpen" @close="settingsOpen = false" />

    <RecodePanel v-if="recodeOpen" @close="recodeOpen = false" />
    <StoryStatsPanel v-if="statsOpen" @close="statsOpen = false" @open="openPassage" />
    <TagAnalyzerPanel v-if="tagsOpen" @close="tagsOpen = false" @open="openPassage" />
    <CastAnalyzerPanel v-if="castOpen" @close="castOpen = false" @open="openPassage" />

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
