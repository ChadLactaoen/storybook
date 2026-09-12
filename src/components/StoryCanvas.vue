<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EdgeLayout, LayoutResult, NodeLayout } from '../lib/graph/types'
import type { NodeState, SelectMode, TagColor } from '../types/story'
import StoryNodeCard from './StoryNodeCard.vue'

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
}>()

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

        <g v-if="detailed" class="labels">
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

    <div class="nodes" :style="{ transform }">
      <StoryNodeCard
        v-for="node in layout.nodes"
        :key="node.id"
        :node="node"
        :state="stateOf.get(node.id) ?? null"
        :tags="tagsOf.get(node.id) ?? []"
        :tag-colors="tagColors"
        :selected="inSelection(node.id)"
        :anchor="node.id === selectedId"
        :is-start="node.id === startNodeId"
        :dimmed="dimmed(node)"
        :detailed="detailed"
        :path-count="null"
        @select="(id, mode) => emit('select', id, mode)"
        @open="emit('open', $event)"
        @create="emit('create', $event)"
      />
    </div>

    <div v-if="showLevels && detailed" class="gutter" :style="{ transform }">
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
.gutter {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.nodes :deep(.card),
.edges .hit {
  pointer-events: auto;
}

.nodes,
.gutter {
  transform-origin: 0 0;
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
