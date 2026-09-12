<script setup lang="ts">
import { computed } from 'vue'
import type { NodeLayout } from '../lib/graph/types'
import type { NodeState, SelectMode, TagColor } from '../types/story'

const props = defineProps<{
  node: NodeLayout
  state: NodeState | null
  tags: string[]
  code: string
  tagColors: Map<string, TagColor>
  /** In the selection — one card of possibly many. */
  selected: boolean
  /** The one selected card the inspector is describing. */
  anchor: boolean
  isStart: boolean
  dimmed: boolean
  detailed: boolean
  pathCount: string | null
}>()

const emit = defineEmits<{
  select: [id: string, mode: SelectMode]
  open: [id: string]
  create: [title: string]
}>()

/** Mirrors the `metaKey || ctrlKey` test in useShortcuts, so the guide can say "Cmd/Ctrl" once. */
function modeOf(e: MouseEvent): SelectMode {
  if (e.metaKey || e.ctrlKey) return 'subtree'
  if (e.shiftKey) return 'toggle'
  return 'replace'
}

/** Only coloured tags earn a stripe; `none` tags still show as a chip below. */
const stripes = computed(() =>
  props.tags
    .map((t) => props.tagColors.get(t) ?? 'none')
    .filter((c): c is Exclude<TagColor, 'none'> => c !== 'none'),
)

const style = computed(() => ({
  left: `${props.node.x - props.node.width / 2}px`,
  top: `${props.node.y - props.node.height / 2}px`,
  width: `${props.node.width}px`,
  height: `${props.node.height}px`,
}))
</script>

<template>
  <div
    class="card"
    :class="[
      `state-${state ?? 'TODO'}`,
      {
        selected,
        anchor,
        phantom: node.isPhantom,
        dimmed,
        start: isStart,
        plain: !detailed,
      },
    ]"
    :style="style"
    :title="node.title"
    @pointerdown.stop
    @click.stop="emit('select', node.id, modeOf($event))"
    @dblclick.stop="node.isPhantom ? emit('create', node.title) : emit('open', node.id)"
  >
    <div v-if="stripes.length > 0" class="stripes">
      <span
        v-for="(color, i) in stripes"
        :key="i"
        class="stripe"
        :style="{ background: `var(--tag-${color})` }"
      />
    </div>

    <span v-if="!node.isPhantom" class="badge" :title="state ?? 'TODO'" />

    <div class="body">
      <div v-if="code" class="code">{{ code }}</div>
      <div class="title">{{ node.title }}</div>

      <template v-if="detailed">
        <div v-if="node.isPhantom" class="missing">No such passage &mdash; double-click to create</div>
        <div v-else-if="tags.length > 0" class="chips">
          <span
            v-for="tag in tags"
            :key="tag"
            class="chip"
            :style="{
              '--chip': `var(--tag-${tagColors.get(tag) ?? 'none'})`,
            }"
          >
            {{ tag }}
          </span>
        </div>
      </template>
    </div>

    <div v-if="detailed && (isStart || pathCount)" class="foot">
      <span v-if="isStart" class="flag">START</span>
      <span v-if="pathCount" class="paths">{{ pathCount }} paths</span>
    </div>
  </div>
</template>

<style scoped>
.card {
  position: absolute;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  cursor: pointer;
  transition: box-shadow 0.12s, border-color 0.12s, opacity 0.12s;
  contain: layout paint;
}

.card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-md);
}

.card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent), var(--shadow-md);
}

/* Every member of a multi-selection is ringed; the anchor is also filled, so
   "which one is the inspector showing" survives. Deliberately not opacity —
   that channel belongs to `.dimmed`, the search filter. */
.card.selected.anchor {
  background: var(--accent-soft);
}

.card.start {
  border-left: 3px solid var(--accent);
}

.card.phantom {
  border-style: dashed;
  background: var(--panel-alt);
  box-shadow: none;
}

.card.dimmed {
  opacity: 0.22;
}

.stripes {
  display: flex;
  height: 5px;
  flex: 0 0 auto;
}

.stripe {
  flex: 1;
}

.badge {
  position: absolute;
  top: 9px;
  right: 9px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--state);
  box-shadow: 0 0 0 2px var(--panel);
}

.body {
  flex: 1;
  min-height: 0;
  padding: 9px 26px 6px 11px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.code {
  /* Tight by design: the detailed card has almost no spare height, so this line
     borrows as little of it as possible. */
  font-size: 10px;
  line-height: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card.plain .code {
  font-size: 11px;
}

/* A coded passage is identified by its code, so the title can give up a line
   rather than let the two together overflow the fixed card height. */
.card:not(.plain) .code + .title {
  -webkit-line-clamp: 1;
  line-clamp: 1;
}

.title {
  font-weight: 600;
  font-size: 13px;
  line-height: 1.3;
  /* Long titles ellipsise rather than resizing the card: node dimensions are
     layout constants, so text must never influence geometry. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.card.plain .title {
  -webkit-line-clamp: 3;
  line-clamp: 3;
  font-size: 15px;
}

.missing {
  font-size: 10px;
  color: var(--text-faint);
  font-style: italic;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  overflow: hidden;
  max-height: 18px;
}

.chip {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.5;
  white-space: nowrap;
  background: color-mix(in srgb, var(--chip) 18%, transparent);
  color: color-mix(in srgb, var(--chip) 78%, var(--text));
  border: 1px solid color-mix(in srgb, var(--chip) 34%, transparent);
}

.foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 11px 7px;
  font-size: 10px;
  color: var(--text-faint);
}

.flag {
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
}
</style>
