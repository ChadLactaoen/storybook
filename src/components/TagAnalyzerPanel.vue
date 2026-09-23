<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as store from '../stores/story'
import { formatCount } from '../lib/graph/paths'
import {
  combineTags,
  computeTagStats,
  tagHits,
  MAX_COMBINED_TAGS,
  TAG_HIT_LABELS,
} from '../lib/graph/tags'
import type { CoverageRow } from '../lib/graph/coverage'
import { nodeLabel, tagsInPaletteOrder } from '../types/story'

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

/**
 * The ticked tags, named back in palette order like every other chip row.
 *
 * Display only. `combineTags` canonicalises its own `keys` with `compareStr`
 * so the subset walk is reproducible, and the table below is sorted by routes
 * because that ranking is the analysis — neither is what this reorders.
 */
const comboKeys = computed(() =>
  combo.value ? tagsInPaletteOrder(combo.value.keys, store.tagColors.value) : [],
)

/**
 * How often one tag is collected, alongside the combination above.
 *
 * Only for a single pick: with two tags ticked "twice" has no one meaning —
 * twice each, or twice between them — and a question the panel cannot phrase
 * is one it should not answer. One extra walk, on the same terms as `combo`.
 */
const hits = computed(() =>
  picked.value.length === 1 ? tagHits(store.state.doc, store.layout.value, picked.value[0]!) : null,
)

/**
 * The collected-how-often rows: bucket 1 upwards, which is exactly the routes
 * the row above them already counts, split three ways. They are indented for
 * that reason — the share column would otherwise read as five rows summing to
 * two hundred per cent. Bucket 0 is not among them; it is the "none of these"
 * row, and printing it twice under two names would invite the same addition.
 *
 * The labels come from `tags.ts` beside the cap that decides how many buckets
 * there are, so a cap raised on its own cannot leave one unprinted.
 */
const hitRows = computed(() =>
  hits.value === null
    ? []
    : TAG_HIT_LABELS.map((label, i) => ({
        label,
        count: hits.value!.buckets[i + 1]!,
        percent: hits.value!.percents[i + 1]!,
      })),
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

/**
 * Which list is open, and how far it is narrowed. One at a time — this is a
 * readout. `level: null` is the whole tag; a number narrows the list below the
 * breakdown to that level.
 *
 * One ref rather than two, so "one open at a time" is a fact about the value
 * instead of a rule two refs have to be kept consistent with.
 */
const expanded = ref<{ tag: string; level: number | null } | null>(null)

function openTag(tag: string) {
  expanded.value = expanded.value?.tag === tag ? null : { tag, level: null }
}

/** Clicking the level that is already open widens back out to the whole tag. */
function pickLevel(tag: string, level: number) {
  const e = expanded.value
  expanded.value = { tag, level: e?.tag === tag && e.level === level ? null : level }
}

/** The passages the open row is listing: the whole tag, or one level of it. */
function entryIds(row: CoverageRow): readonly string[] {
  const e = expanded.value
  if (!e || e.tag !== row.key) return []
  if (e.level === null) return row.nodeIds
  return row.levels.find((l) => l.level === e.level)?.nodeIds ?? []
}

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
  if (expanded.value?.tag === tag) expanded.value = null
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
            <span class="n">{{ s.coveredPassages }}</span>
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
              <template v-for="row in s.rows" :key="row.key">
                <tr :class="{ zero: row.routes === 0n }">
                  <td class="pick-col">
                    <input
                      type="checkbox"
                      :checked="picked.includes(row.key)"
                      :disabled="atCap && !picked.includes(row.key)"
                      :aria-label="`Combine ${row.key}`"
                      @change="toggle(row.key)"
                    />
                  </td>
                  <td>
                    <span class="swatch" :style="{ background: colorOf(row.key) }" />
                    {{ row.key }}
                    <span v-if="row.passages === 0" class="tag">unused</span>
                    <span v-else-if="row.offRoute > 0" class="tag">
                      {{ row.offRoute }} on no route
                    </span>
                  </td>
                  <td class="num">
                    <button
                      v-if="row.passages > 0"
                      class="link"
                      :aria-expanded="expanded?.tag === row.key"
                      title="Break this tag down by level"
                      @click="openTag(row.key)"
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
                      @click="filterBy(row.key)"
                    >
                      Filter
                    </button>
                    <button
                      v-else
                      class="link danger"
                      title="Remove this tag from the story"
                      @click="remove(row.key)"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
                <tr v-if="expanded?.tag === row.key" class="entries-row">
                  <td />
                  <td colspan="6">
                    <table class="levels">
                      <thead>
                        <tr>
                          <th>Level</th>
                          <th class="num">Passages</th>
                          <th class="num">Share of level</th>
                        </tr>
                      </thead>
                      <tbody>
                        <!-- Only the levels the tag reaches. Every row names its
                             own level, so a skipped one reads as a gap rather
                             than as a miscount. -->
                        <tr
                          v-for="lv in row.levels"
                          :key="lv.level"
                          :class="{ on: expanded.level === lv.level }"
                        >
                          <td>
                            <button
                              class="link"
                              :aria-pressed="expanded.level === lv.level"
                              :title="`List the ${row.key} passages on level ${lv.level}`"
                              @click="pickLevel(row.key, lv.level)"
                            >
                              L{{ lv.level }}
                            </button>
                          </td>
                          <!-- The count beside the share, the way `routes` sits
                               beside `percent` above: a percentage alone hides
                               whether it came from two passages or two hundred. -->
                          <td class="num">{{ lv.passages }} of {{ lv.levelPassages }}</td>
                          <td class="num">{{ lv.percent }}%</td>
                        </tr>
                      </tbody>
                    </table>

                    <p class="entries-head">
                      <template v-if="expanded.level === null">
                        All {{ row.passages }} passages tagged <strong>{{ row.key }}</strong>
                      </template>
                      <template v-else>
                        <strong>{{ row.key }}</strong> on level {{ expanded.level }}
                      </template>
                    </p>
                    <ul class="entries">
                      <li v-for="p in passagesOf(entryIds(row))" :key="p.id">
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
            {{ combo.keys.length }} tags is more than the {{ MAX_COMBINED_TAGS }} this can
            count &mdash; each one added doubles the work. Untick a few.
          </p>
          <template v-else>
            <div class="chips">
              <span v-for="t in comboKeys" :key="t" class="chip">
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
                <tr v-for="row in hitRows" :key="row.label" class="sub">
                  <td>&mdash; of those, <strong>{{ row.label }}</strong></td>
                  <td class="num">{{ formatCount(row.count) }}</td>
                  <td class="bar-col">
                    <span
                      v-if="row.percent > 0"
                      class="bar"
                      :style="{ width: `${row.percent}%` }"
                    />
                  </td>
                  <td class="num">{{ row.percent }}%</td>
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
            <p v-if="hits" class="hint">
              The indented rows split the one above them, counted in passages: a
              route&rsquo;s tally is how many tagged passages it goes through. A reader
              who loops back would collect it again, which no route here does.
            </p>
            <p v-else class="hint">
              In any order, on any passages &mdash; they need not be the same one, and a
              passage carrying two of these satisfies both.
            </p>
          </template>
        </section>
        <p v-else-if="s.rows.length > 0" class="hint">
          Tick a tag above to ask how often a route collects it, or two or more to ask
          how many routes collect all of them.
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
   tags / characters 99, startup 101. The two analyzers share a rung
   because they are mutually unreachable: each one's veil covers the menu bar
   that is the only way to open the other. */
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

/* A breakdown of the row above, and it has to look like one: read flat, the
   share column would sum past a hundred per cent, because these routes are
   already counted there. The indent is on the label only, so the numbers stay
   in their columns and remain readable down the table. */
tr.sub td:first-child {
  padding-left: 14px;
  color: var(--text-dim);
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
  /* Indented to the breakdown above it, so the head and its list read as one. */
  padding: 2px 0 6px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
}

/* A readout inside a readout: quieter than the table it sits in, and indented
   so the two do not read as one set of columns. */
table.levels {
  margin: 2px 0 0 14px;
  border-collapse: collapse;
  font-size: 11px;
  color: var(--text-faint);
}

table.levels th {
  text-align: left;
  font-weight: 600;
  padding: 0 14px 2px 0;
}

/* Out-specifies the bare `.num` the same way `table.rows th.num` has to. */
table.levels th.num,
table.levels td.num {
  text-align: right;
}

table.levels td {
  padding: 1px 14px 1px 0;
  vertical-align: baseline;
}

table.levels tr.on td {
  color: var(--text);
}

.entries-head {
  margin: 6px 0 0 14px;
  font-size: 11px;
  color: var(--text-faint);
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
