<script setup lang="ts">
import { computed } from 'vue'
import type { NodeLayout } from '../lib/graph/types'
import { nodeLabel } from '../types/story'
import type { NodeState, SelectMode, TagColor } from '../types/story'

const props = defineProps<{
  node: NodeLayout
  state: NodeState | null
  tags: string[]
  tagColors: Map<string, TagColor>
  /** In the selection — one card of possibly many. */
  selected: boolean
  /** The one selected card the inspector is describing. */
  anchor: boolean
  /**
   * The running slug: the marks along the route here, with `*` where the routes
   * disagree. Empty when nothing on the route carries one, and when no route
   * reaches this passage at all.
   */
  run: string
  isStart: boolean
  /** The author marked this as a place a route stops. Never derived. */
  isEnding: boolean
  dimmed: boolean
  detailed: boolean
  pathCount: string | null
}>()

const emit = defineEmits<{
  select: [id: string, mode: SelectMode]
  open: [id: string]
  create: [phantomId: string]
}>()

/** Mirrors the `metaKey || ctrlKey` test in useShortcuts, so the guide can say "Cmd/Ctrl" once. */
function modeOf(e: MouseEvent): SelectMode {
  if (e.metaKey || e.ctrlKey) return 'subtree'
  if (e.shiftKey) return 'toggle'
  return 'replace'
}

/** Only coloured tags earn a stripe; `none` tags still show as a chip below. */
/** Hover text: titles repeat, so the code has to be in here to identify the card. */
const label = computed(() => nodeLabel(props.node.code, props.node.title))

/**
 * How much of a running slug the card line holds, in characters.
 *
 * 22 at 10px in this mono stack is about 141px against 161px of line, and about
 * 155px on a plain card's 11px — so the cut lands before the text does, and the
 * `text-overflow` below stays a backstop rather than the mechanism.
 */
const RUN_MAX = 22

/**
 * The tail of the running slug, not the head.
 *
 * A running slug reads backwards: the end is where this passage is, and the
 * front is the part of the route every sibling shares. CLAUDE.md records that
 * exactly this — leading characters being something to strip rather than
 * context to read — is what killed the note's original grammar, so the card
 * shows the half that is worth reading and the inspector keeps the whole of it.
 *
 * Cut by code point: a slug may hold an emoji, and half a surrogate pair is not
 * a character.
 */
const runShown = computed(() => {
  const chars = [...props.run]
  if (chars.length <= RUN_MAX) return props.run
  return '\u2026' + chars.slice(chars.length - (RUN_MAX - 1)).join('')
})

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
        ending: isEnding,
        plain: !detailed,
      },
    ]"
    :style="style"
    :title="label"
    @pointerdown.stop
    @click.stop="emit('select', node.id, modeOf($event))"
    @dblclick.stop="node.isPhantom ? emit('create', node.id) : emit('open', node.id)"
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
      <div v-if="run" class="run" :title="`${label} \u2014 ${run}`">{{ runShown }}</div>
      <div v-if="node.title" class="title">{{ node.title }}</div>
      <div v-else class="title untitled">Untitled</div>

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

    <div v-if="detailed && (isStart || isEnding || pathCount)" class="foot">
      <span v-if="isStart" class="flag">START</span>
      <span v-if="isEnding" class="flag flag-end">END</span>
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

/* The floor of a route, and drawn on the floor of the card.
   The tree runs top to bottom: routes arrive at a card's top edge and leave
   from its bottom, so "nothing leaves the bottom" is what an ending *is* —
   this draws the fact rather than a symbol standing in for it. The right edge
   was tried first, for symmetry with START, and lost on sight: a card is
   200x96, so a horizontal rule gets twice the pixels of a vertical one, and
   zoomed out the vertical version read as chrome in the gutter between cards
   while a row of underlines reads instantly as the story's floor. The lost
   symmetry costs little — START's left edge is itself arbitrary, since routes
   do not enter from the left either.
   It also leaves the card's edges fully spoken for without collisions: top is
   tag stripes, top-right is state, left is START, bottom is this.
   Background would have been louder still and is the one channel that is not
   free — `.card.selected.anchor` uses fill to say which card the inspector is
   describing, and `.card.phantom` uses it too. */
.card.ending {
  border-bottom: 3px solid var(--ending);
}

/* The marker grows as the detail shrinks. Below DETAIL_ZOOM the footer is not
   rendered at all, so the END flag is gone and this edge is the only thing
   left saying so — exactly when "where are my endings" is the question being
   asked. 3px cannot carry that alone; the tag stripes are 5px and are the
   evidence that an edge at this scale can. Border-box means the extra width
   eats content, never geometry. */
.card.plain.ending {
  border-bottom-width: 9px;
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

/* A detailed card stacks up to five things inside 96 fixed pixels — stripe,
   note, title, chips, footer — and the footer only appears on a passage that is
   a start, an ending or carries a path count, which is why the squeeze shows up
   there and nowhere else. Every height in that stack is a constant (the run's
   line-height is 1, the title's 1.3, a chip's 1.5, the footer's 1.2 below), so
   the padding and the gaps are the only slack there is; they are tuned to leave
   the fullest legal card a few pixels spare rather than to look generous. Do not
   restore the roomier 9/6/5 they were before — the line above, a title, one coloured tag
   and an END flag together overran the body by 5px, and flex paid for it by
   shaving the bottom border off the chip. */
.body {
  flex: 1;
  min-height: 0;
  padding: 8px 26px 4px 11px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.run {
  /* Tight by design: the detailed card has almost no spare height, so this line
     borrows as little of it as possible. */
  font-size: 10px;
  line-height: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  /* A backstop, not the mechanism: `runShown` has already cut the string to
     something this line fits, and it cut the *front*, which is the end CSS
     cannot ellipsise without reordering the text. */
  text-overflow: ellipsis;
}

/* The marquee that used to live here is gone with the note it was built for. It
   scrolled up to 193px of text through a 161px line; a running slug on a deep
   story is an order of magnitude longer than that, which at its speed is motion
   rather than reading — and the whole string is a hover away on the card and
   always present in the inspector. */

.card.plain .run {
  font-size: 11px;
}

/* Only when the line is actually there: a card with no running slug has it
   collapsed, and the title should take the space rather than clamp for nothing.
   Note this now fires on most cards rather than a few — the height budget above
   is what requires it, and the title losing its second line is the price of the
   line above it. */
.card:not(.plain) .run + .title {
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

.title.untitled {
  opacity: 0.45;
  font-style: italic;
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

/* One row of chips; any that wrap past it are clipped, because a card's height
   is a layout constant and extra tags must never grow it.
   The cap has to clear a whole chip — 15px of text box (10px at line-height
   1.5), plus 1px of padding and 1px of border top and bottom — or it shaves the
   bottom border off and the chip reads as cut in half. The extra pixel is slack
   against sub-pixel rounding; a second row would need 22px, so it stays hidden. */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  overflow: hidden;
  max-height: 20px;
  /* A chip is a drawn box, so a fractional one reads as damage rather than as
     "more below" — it must never be what yields when the body is over-full.
     The title is the one item left free to shrink, and clipping is already what
     a long title does here. */
  flex: 0 0 auto;
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

/* `normal` line-height was the one height on the card that a font could move,
   which is exactly the wrong property for the row that decides whether the body
   above it still fits. Pinned, so the whole stack is arithmetic. */
.foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 11px 5px;
  font-size: 10px;
  line-height: 1.2;
  color: var(--text-faint);
}

/* The ending's 3px border is inside the card's box, so it takes its two extra
   pixels out of the content — and it already draws the air the footer was
   padding for. Handing them back keeps the gap under the flag looking the same
   as on a start card while the body keeps the room. */
.card.ending .foot {
  padding-bottom: 3px;
}

.flag {
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
}

.flag-end {
  color: var(--ending);
}
</style>
