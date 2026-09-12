<script setup lang="ts">
import { computed, ref } from 'vue'
import type { LayoutResult } from '../lib/graph/types'
import type { NodeState } from '../types/story'

const WIDTH = 196
const HEIGHT = 136

const props = defineProps<{
  layout: LayoutResult
  view: { x: number; y: number; k: number }
  size: { width: number; height: number }
  stateOf: Map<string, NodeState>
  selectedId: string | null
  selectedIds: Set<string>
}>()

const emit = defineEmits<{ goto: [x: number, y: number] }>()

const scale = computed(() => {
  const b = props.layout.bounds
  if (b.width <= 0 || b.height <= 0) return 1
  return Math.min(WIDTH / b.width, HEIGHT / b.height)
})

const offset = computed(() => {
  const b = props.layout.bounds
  return {
    x: (WIDTH - b.width * scale.value) / 2 - b.minX * scale.value,
    y: (HEIGHT - b.height * scale.value) / 2 - b.minY * scale.value,
  }
})

function at(x: number, y: number) {
  return { x: x * scale.value + offset.value.x, y: y * scale.value + offset.value.y }
}

/** The slice of the story currently on screen. */
const window_ = computed(() => {
  const { view, size } = props
  const tl = at(-view.x / view.k, -view.y / view.k)
  return {
    x: tl.x,
    y: tl.y,
    width: (size.width / view.k) * scale.value,
    height: (size.height / view.k) * scale.value,
  }
})

const dragging = ref(false)
const root = ref<SVGSVGElement | null>(null)

function jump(e: PointerEvent) {
  const rect = root.value?.getBoundingClientRect()
  if (!rect) return
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  emit(
    'goto',
    (mx - offset.value.x) / scale.value,
    (my - offset.value.y) / scale.value,
  )
}

function onDown(e: PointerEvent) {
  dragging.value = true
  ;(e.currentTarget as SVGElement).setPointerCapture(e.pointerId)
  jump(e)
}

function onMove(e: PointerEvent) {
  if (dragging.value) jump(e)
}

function onUp(e: PointerEvent) {
  dragging.value = false
  ;(e.currentTarget as SVGElement).releasePointerCapture?.(e.pointerId)
}
</script>

<template>
  <div class="minimap">
    <svg
      ref="root"
      :width="WIDTH"
      :height="HEIGHT"
      @pointerdown.stop="onDown"
      @pointermove.stop="onMove"
      @pointerup.stop="onUp"
      @pointercancel.stop="onUp"
    >
      <g class="wires">
        <line
          v-for="edge in layout.edges"
          :key="edge.edgeId"
          :x1="at(layout.nodeById.get(edge.sourceId)?.x ?? 0, 0).x"
          :y1="at(0, layout.nodeById.get(edge.sourceId)?.y ?? 0).y"
          :x2="at(layout.nodeById.get(edge.targetId)?.x ?? 0, 0).x"
          :y2="at(0, layout.nodeById.get(edge.targetId)?.y ?? 0).y"
        />
      </g>
      <g>
        <rect
          v-for="node in layout.nodes"
          :key="node.id"
          :class="[`state-${stateOf.get(node.id) ?? 'TODO'}`, { sel: node.id === selectedId || selectedIds.has(node.id) }]"
          :x="at(node.x - node.width / 2, 0).x"
          :y="at(0, node.y - node.height / 2).y"
          :width="Math.max(2, node.width * scale)"
          :height="Math.max(2, node.height * scale)"
          rx="1"
        />
      </g>
      <rect
        class="viewport"
        :x="window_.x"
        :y="window_.y"
        :width="window_.width"
        :height="window_.height"
      />
    </svg>
  </div>
</template>

<style scoped>
.minimap {
  position: absolute;
  right: 14px;
  bottom: 14px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: var(--shadow-md);
}

svg {
  display: block;
  cursor: crosshair;
  touch-action: none;
}

.wires line {
  stroke: var(--edge);
  stroke-width: 0.6;
  opacity: 0.5;
}

rect {
  fill: var(--state, var(--edge));
  opacity: 0.75;
}

rect.sel {
  stroke: var(--accent);
  stroke-width: 1.2;
  opacity: 1;
}

.viewport {
  fill: color-mix(in srgb, var(--accent) 12%, transparent);
  stroke: var(--accent);
  stroke-width: 1;
  opacity: 0.95;
}
</style>
