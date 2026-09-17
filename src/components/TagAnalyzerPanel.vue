<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as store from '../stores/story'
import { formatCount } from '../lib/graph/paths'
import { combineTags, computeTagStats, MAX_COMBINED_TAGS } from '../lib/graph/tags'
import { nodeLabel } from '../types/story'

const emit = defineEmits<{ close: []; open: [id: string] }>()

/**
 * How much of the story a tag actually covers, computed when asked.
 *
 * On demand by construction, the way `StoryStatsPanel` is: the component only
 * exists while the panel is open, so none of this runs during ordinary writing,
 * and a `computed` rather than a snapshot so an edit underneath an open panel
 * is reflected rather than going stale. No memo and no store computed — nothing
 * outside this panel reads these numbers, and a key on `layoutVersion` alone
 * would be the trap `runningSlugs` documents, since `tags` is deliberately not
 * in `layoutKey`.
 */
const s = computed(() => computeTagStats(store.state.doc, store.layout.value))

const total = computed(() => formatCount(s.value.totalRoutes))

/** Which tags the combination below is about. */
const picked = ref<string[]>([])

/**
 * Recomputed only when the pick changes or the document does — but the cost is
 * exponential in the number of tags picked, which is why the analyzer refuses
 * past its own ceiling rather than trusting the checkboxes to stop first.
 */
const combo = computed(() =>
  picked.value.length === 0
    ? null
    : combineTags(store.state.doc, store.layout.value, picked.value),
)

const atCap = computed(() => picked.value.length >= MAX_COMBINED_TAGS)

function toggle(tag: string) {
  const i = picked.value.indexOf(tag)
  if (i === -1) {
    if (atCap.value) return
    picked.value.push(tag)
  } else {
    picked.value.splice(i, 1)
  }
}

/** Which tag's passage list is expanded. One at a time — this is a readout. */
const expanded = ref<string | null>(null)

function passagesOf(ids: readonly string[]) {
  const byId = store.layout.value.nodeById
  return ids.map((id) => {
    const n = byId.get(id)
    return { id, label: n ? nodeLabel(n.code, n.title) : id }
  })
}

function colorOf(tag: string) {
  return `var(--tag-${store.tagColors.value.get(tag) ?? 'none'})`
}

/**
 * Show the author the passages the number was about. The canvas filter is
 * already a tag filter, so this is the same question asked of the tree.
 */
function filterBy(tag: string) {
  store.toggleFilter('tagFilter', tag)
  emit('close')
}

/**
 * Clear a tag out of the story. Offered only on a row carrying no passages, and
 * the mutation refuses anyway if one does — the button is the affordance, not
 * the guarantee.
 *
 * Dropped from the pick as well, or the combination below would go on asking
 * about a tag the story no longer has.
 */
function remove(tag: string) {
  store.tagDelete(tag)
  const i = picked.value.indexOf(tag)
  if (i !== -1) picked.value.splice(i, 1)
  if (expanded.value === tag) expanded.value = null
}

/** Revealing a passage is `App`'s job — selecting alone never moves the canvas. */
function go(id: string) {
  emit('open', id)
  emit('close')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="veil" @click.self="emit('close')">
    <div class="sheet" role="dialog" aria-label="Tag analyzer">
      <header>
        <h2>Tags</h2>
        <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
      </header>

      <div class="scroll">
        <section class="tiles">
          <div class="tile">
            <span class="n">{{ total }}</span>
            <span class="k">routes</span>
          </div>
          <div class="tile">
            <span class="n">{{ s.rows.length }}</span>
            <span class="k">tags</span>
          </div>
          <div class="tile">
            <span class="n">{{ s.taggedPassages }}</span>
            <span class="k">tagged passages</span>
          </div>
        </section>

        <section>
          <h3>Coverage</h3>
          <p v-if="s.rows.length === 0" class="hint">
            No tags yet. Add one to a passage from the sidebar and it will show up here with
            the share of routes that run through it.
          </p>
          <p v-else-if="store.state.doc.startNodeId === null" class="hint">
            No start passage is set, so the story has no routes to measure against. Passage
            counts below are still real.
          </p>
          <table v-if="s.rows.length > 0" class="rows">
            <thead>
              <tr>
                <th class="pick-col" />
                <th>Tag</th>
                <th class="num">Passages</th>
                <th class="num">Routes</th>
                <th class="bar-col" />
                <th class="num">Share</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <template v-for="row in s.rows" :key="row.tag">
                <tr :class="{ zero: row.routes === 0n }">
                  <td class="pick-col">
                    <input
                      type="checkbox"
                      :checked="picked.includes(row.tag)"
                      :disabled="atCap && !picked.includes(row.tag)"
                      :aria-label="`Combine ${row.tag}`"
                      @change="toggle(row.tag)"
                    />
                  </td>
                  <td>
                    <span class="swatch" :style="{ background: colorOf(row.tag) }" />
                    {{ row.tag }}
                    <span v-if="row.passages === 0" class="tag">unused</span>
                    <span v-else-if="row.offRoute > 0" class="tag">
                      {{ row.offRoute }} on no route
                    </span>
                  </td>
                  <td class="num">
                    <button
                      v-if="row.passages > 0"
                      class="link"
                      @click="expanded = expanded === row.tag ? null : row.tag"
                    >
                      {{ row.passages }}
                    </button>
                    <span v-else>0</span>
                  </td>
                  <td class="num">{{ formatCount(row.routes) }}</td>
                  <td class="bar-col">
                    <span v-if="row.percent > 0" class="bar" :style="{ width: `${row.percent}%` }" />
                  </td>
                  <td class="num">{{ row.percent }}%</td>
                  <td class="num">
                    <button
                      v-if="row.passages > 0"
                      class="link"
                      title="Filter the tree to this tag"
                      @click="filterBy(row.tag)"
                    >
                      Filter
                    </button>
                    <button
                      v-else
                      class="link danger"
                      title="Remove this tag from the story"
                      @click="remove(row.tag)"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
                <tr v-if="expanded === row.tag" class="entries-row">
                  <td />
                  <td colspan="6">
                    <ul class="entries">
                      <li v-for="p in passagesOf(row.nodeIds)" :key="p.id">
                        <button class="link" @click="go(p.id)">{{ p.label }}</button>
                      </li>
                    </ul>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </section>

        <section v-if="combo">
          <h3>Combination</h3>
          <p v-if="combo.overCap" class="hint hint-warn">
            {{ combo.tags.length }} tags is more than the {{ MAX_COMBINED_TAGS }} this can
            count &mdash; each one added doubles the work. Untick a few.
          </p>
          <template v-else>
            <div class="chips">
              <span v-for="t in combo.tags" :key="t" class="chip">
                <span class="swatch" :style="{ background: colorOf(t) }" />
                {{ t }}
              </span>
            </div>
            <table class="rows">
              <tbody>
                <tr>
                  <td>Routes collecting <strong>all</strong> of these</td>
                  <td class="num">{{ formatCount(combo.all) }}</td>
                  <td class="bar-col">
                    <span
                      v-if="combo.allPercent > 0"
                      class="bar"
                      :style="{ width: `${combo.allPercent}%` }"
                    />
                  </td>
                  <td class="num">{{ combo.allPercent }}%</td>
                </tr>
                <tr>
                  <td>Routes collecting <strong>none</strong> of these</td>
                  <td class="num">{{ formatCount(combo.none) }}</td>
                  <td class="bar-col">
                    <span
                      v-if="combo.nonePercent > 0"
                      class="bar"
                      :style="{ width: `${combo.nonePercent}%` }"
                    />
                  </td>
                  <td class="num">{{ combo.nonePercent }}%</td>
                </tr>
                <tr class="reconcile">
                  <td>Passages carrying all of them at once</td>
                  <td class="num">{{ combo.passagesAll }}</td>
                  <td class="bar-col" />
                  <td class="num" />
                </tr>
              </tbody>
            </table>
            <p v-if="combo.missing.length > 0" class="hint hint-warn">
              No passage carries {{ combo.missing.join(', ') }}, so no route can collect it.
            </p>
            <p class="hint">
              In any order, on any passages &mdash; they need not be the same one, and a
              passage carrying two of these satisfies both.
            </p>
          </template>
        </section>
        <p v-else-if="s.rows.length > 0" class="hint">
          Tick two or more tags above to ask how many routes collect all of them.
        </p>
      </div>

      <footer>
        <span class="muted">
          Routes stop at an Ending and never take a back edge, so a tag collected only by
          looping back is not counted.
        </span>
        <button class="btn btn-primary" @click="emit('close')">Done</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Ladder: body 92, sheet 94, help 95, settings 96, recode 97, stats 98,
   tags 99, reader 100, startup 101. */
/* Anchored to the top rather than centred, which is the one place this parts
   company with the stats sheet. Stats is a readout and never changes height;
   ticking a tag here grows the sheet by a whole section, and a centred sheet
   grows in both directions — so the row under the cursor slid up and the next
   tick landed on the tag below the one aimed at. */
.veil {
  position: fixed;
  inset: 0;
  z-index: 99;
  display: grid;
  place-items: start center;
  padding: 24px;
  background: color-mix(in srgb, var(--text) 32%, transparent);
}

.sheet {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 720px;
  max-height: 100%;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 10px 12px 18px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

h2 {
  margin: 0;
  font-size: 17px;
  letter-spacing: -0.01em;
}

h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}

.muted {
  font-size: 11px;
  color: var(--text-faint);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}

.tile .n {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.tile .k {
  font-size: 11px;
  color: var(--text-faint);
}

table.rows {
  width: 100%;
  border-collapse: collapse;
}

table.rows th {
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-faint);
  padding: 0 0 5px;
  border-bottom: 1px solid var(--border);
}

/* Must out-specify `table.rows th` (0,1,2), which a bare `.num` (0,1,0) loses to. */
table.rows th.num {
  text-align: right;
}

table.rows td {
  padding: 5px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: baseline;
}

table.rows tbody tr:last-child td {
  border-bottom: none;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Fixed track, so every bar starts in the same place and the column can be
   read down without the digits beside it shifting the left edge. */
.bar-col {
  width: 84px;
  padding-left: 10px;
}

.bar {
  display: block;
  min-width: 2px;
  height: 4px;
  border-radius: 2px;
  background: var(--accent);
}

.pick-col {
  width: 26px;
}

tr.zero td {
  color: var(--text-faint);
}

tr.reconcile td {
  color: var(--text-faint);
  font-style: italic;
}

tr.entries-row td {
  padding-top: 0;
}

.tag {
  margin-left: 6px;
  font-size: 10px;
  color: var(--text-faint);
}

.swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 7px;
  border-radius: 2px;
  vertical-align: baseline;
}

.link {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
  text-align: left;
}

.link:hover {
  text-decoration: underline;
}

/* Destructive, so it does not wear the accent every other row action wears.
   `--todo` is the red the lint counts already use; there is no `--danger`. */
.link.danger {
  color: var(--todo);
}

.entries {
  list-style: none;
  margin: 0;
  padding: 2px 0 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-alt);
  font-size: 11px;
}
</style>
