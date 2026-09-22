<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EdgeLayout, LayoutResult, NodeLayout } from '../lib/graph/types'
import type { NodeState, SelectMode, TagColor } from '../types/story'
import StoryNodeCard from './StoryNodeCard.vue'

/**
 * One shared empty list for every card with no tags — a phantom always, and most
 * passages in most drafts.
 *
 * A `?? []` in the template looks like it costs nothing, but it allocates a new
 * array per card per render, and a new array is a changed prop: it would hand
 * back exactly the re-render the memos upstream exist to avoid.
 */
const NO_TAGS: string[] = []

const props = defineProps<{
  layout: LayoutResult
  transform: string
  svgTransform: string
  detailed: boolean
  panning: boolean
  /** The anchor card: the one the inspector describes. May be a phantom. */
  selectedId: string | null
  /** Every selected passage, the anchor included when it is a real one. */
  selectedIds: Set<string>
  startNodeId: string | null
  matches: Set<string> | null
  stateOf: Map<string, NodeState>
  tagsOf: Map<string, string[]>
  tagColors: Map<string, TagColor>
  showLevels: boolean
  /** Draw each passage's code above its card. */
  showCodes: boolean
  /**
   * Draw the whole canvas as shape and colour: no card text, no codes above
   * them, no captions on the wires and no level tags in the gutter. The
   * Developer menu's screenshot mode.
   */
  textless: boolean
  /**
   * The running slug per passage, straight from the store's memoized map.
   * A passage that is absent has no route to it and shows nothing.
   */
  runOf: Map<string, string>
  isEndingOf: Map<string, boolean>
}>()

/**
 * Clear of the card's top edge, inside the gap between levels.
 *
 * The code is drawn in its own layer rather than inside the card because the
 * card sets `overflow: hidden` and `contain: paint` — a child could not leave
 * it, and growing the card is not an option: `NODE_H` is a layout constant.
 * The in-card line belongs to the author's note now.
 */
const CODE_GAP = 13

const codeLabels = computed(() => {
  // Both halves of the template guard: at a zoomed-out view nothing is drawn,
  // and building the list anyway would allocate per node on every relayout.
  if (!props.detailed || !props.showCodes || props.textless) return []
  return props.layout.nodes.map((node) => ({
    id: node.id,
    x: node.x - node.width / 2,
    y: node.y - node.height / 2 - CODE_GAP,
    width: node.width,
    text: node.code,
  }))
})

const emit = defineEmits<{
  select: [id: string | null, mode: SelectMode]
  open: [id: string]
  create: [phantomId: string]
  wheel: [e: WheelEvent]
  pointerdown: [e: PointerEvent]
  pointermove: [e: PointerEvent]
  pointerup: [e: PointerEvent]
}>()

const hoveredEdge = ref<string | null>(null)

const dimmed = (n: NodeLayout) => props.matches !== null && !props.matches.has(n.id)

/** Anchor or member — a phantom anchor is never in `selectedIds`. */
const inSelection = (id: string) => id === props.selectedId || props.selectedIds.has(id)

/** Edges touching the selection are drawn heavier so a branch reads at a glance. */
function edgeClass(e: EdgeLayout) {
  const active = inSelection(e.sourceId) || inSelection(e.targetId)
  return [e.kind, { active, hovered: hoveredEdge.value === e.edgeId }]
}

const edgeLabelled = (e: EdgeLayout) =>
  hoveredEdge.value === e.edgeId || inSelection(e.sourceId) || inSelection(e.targetId)

const levelLabels = computed(() =>
  props.layout.levels.map((band) => ({
    ...band,
    x: props.layout.bounds.minX + 16,
  })),
)
</script>

<template>
  <div
    ref="root"
    class="canvas"
    :class="{ panning }"
    @wheel.prevent="emit('wheel', $event)"
    @pointerdown="emit('pointerdown', $event)"
    @pointermove="emit('pointermove', $event)"
    @pointerup="emit('pointerup', $event)"
    @pointercancel="emit('pointerup', $event)"
  >
    <div class="backdrop" data-canvas-background @click="emit('select', null, 'replace')" />

    <!-- Edges sit beneath the card layer so cards always occlude lines. Both
         layers consume the same transform, so they stay glued together. -->
    <svg class="edges" :class="{ plain: !detailed }">
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="9"
          markerHeight="9"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
        <marker
          id="arrow-active"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" class="active-head" />
        </marker>
      </defs>

      <g :transform="svgTransform">
        <g v-if="showLevels" class="bands">
          <line
            v-for="band in layout.levels"
            :key="band.level"
            :x1="layout.bounds.minX"
            :x2="layout.bounds.maxX"
            :y1="band.y + band.height / 2"
            :y2="band.y + band.height / 2"
          />
        </g>

        <g class="wires">
          <g v-for="edge in layout.edges" :key="edge.edgeId" :class="edgeClass(edge)">
            <!-- An invisible fat stroke makes a 2px line actually clickable. -->
            <path
              v-if="detailed"
              class="hit"
              :d="edge.d"
              @pointerenter="hoveredEdge = edge.edgeId"
              @pointerleave="hoveredEdge = null"
              @click.stop="emit('select', edge.sourceId, 'replace')"
            />
            <path class="wire" :d="edge.d" marker-end="url(#arrow)" />
          </g>
        </g>

        <!-- A wire's caption is a glyph on the drawing like any other, so it
             goes with the rest under `textless`. -->
        <g v-if="detailed && !textless" class="labels">
          <template v-for="edge in layout.edges" :key="edge.edgeId">
            <g
              v-if="edge.label && edge.labelPoint && edgeLabelled(edge)"
              :transform="`translate(${edge.labelPoint.x}, ${edge.labelPoint.y})`"
            >
              <text class="edge-label">{{ edge.label }}</text>
            </g>
          </template>
        </g>
      </g>
    </svg>

    <div v-if="codeLabels.length > 0" class="codes" :style="{ transform }">
      <div
        v-for="label in codeLabels"
        :key="label.id"
        class="code-tag"
        :style="{ left: `${label.x}px`, top: `${label.y}px`, width: `${label.width}px` }"
      >
        {{ label.text }}
      </div>
    </div>

    <div class="nodes" :style="{ transform }">
      <StoryNodeCard
        v-for="node in layout.nodes"
        :key="node.id"
        :node="node"
        :state="stateOf.get(node.id) ?? null"
        :tags="tagsOf.get(node.id) ?? NO_TAGS"
        :run="runOf.get(node.id) ?? ''"
        :tag-colors="tagColors"
        :selected="inSelection(node.id)"
        :anchor="node.id === selectedId"
        :is-start="node.id === startNodeId"
        :is-ending="isEndingOf.get(node.id) ?? false"
        :dimmed="dimmed(node)"
        :detailed="detailed"
        :path-count="null"
        :textless="textless"
        @select="(id, mode) => emit('select', id, mode)"
        @open="emit('open', $event)"
        @create="emit('create', $event)"
      />
    </div>

    <!-- The gutter's "Level 3" is a glyph on the drawing like any other, and it
         was the last one left in a screenshot taken with the bands on. -->
    <div v-if="showLevels && detailed && !textless" class="gutter" :style="{ transform }">
      <div
        v-for="band in levelLabels"
        :key="band.level"
        class="level-tag"
        :style="{ left: `${band.x}px`, top: `${band.y + band.height / 2 - 9}px` }"
      >
        Level {{ band.level }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.canvas {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  background: var(--canvas);
  background-image: radial-gradient(var(--grid) 1px, transparent 1px);
  background-size: 22px 22px;
  cursor: grab;
  touch-action: none;
}

.canvas.panning {
  cursor: grabbing;
}

.backdrop {
  position: absolute;
  inset: 0;
}

.edges,
.nodes,
.gutter,
.codes {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.nodes :deep(.card),
.edges .hit {
  pointer-events: auto;
}

.nodes,
.gutter,
.codes {
  transform-origin: 0 0;
}

.code-tag {
  position: absolute;
  /* Deliberately *not* the card's `.run` line any more. Both are now
     identifiers — a code above, the route that reaches it inside — and in the
     same 10px faint mono, stacked two lines apart, they read as one string in
     two halves. The code is the fixed one, so it keeps the weight and the run
     line gives up the letter-spacing. */
  font-size: 10px;
  line-height: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  font-weight: 600;
  color: var(--text-faint);
  /* Truncated rather than wrapped: a second line would reach into the level
     above. The card's own hover title carries the code in full. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.edges {
  width: 100%;
  height: 100%;
  overflow: visible;
}

.bands line {
  stroke: var(--border);
  stroke-width: 1;
  stroke-dasharray: 2 8;
  opacity: 0.7;
}

.wire {
  fill: none;
  stroke: var(--edge);
  stroke-width: 1.75;
  stroke-linecap: round;
}

.hit {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  cursor: pointer;
}

#arrow path {
  fill: var(--edge);
}

.active-head {
  fill: var(--accent);
}

g.active .wire,
g.hovered .wire {
  stroke: var(--accent);
  stroke-width: 2.4;
}

g.active .wire,
g.hovered .wire {
  marker-end: url(#arrow-active);
}

/* Cycle edges are legitimate in CYOA writing, so they read as a variation
   rather than an error: dashed and lighter, arrowhead still at the true target. */
g.back .wire,
g.flat .wire,
g.self .wire {
  stroke-dasharray: 5 4;
  opacity: 0.75;
}

g.dangling .wire {
  stroke-dasharray: 2 4;
}

.edge-label {
  font-size: 11px;
  fill: var(--text-dim);
  text-anchor: middle;
  dominant-baseline: middle;
  paint-order: stroke;
  stroke: var(--canvas);
  stroke-width: 4px;
  stroke-linejoin: round;
}

.level-tag {
  position: absolute;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
  white-space: nowrap;
}
</style>
