<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as store from '../stores/story'
import { computeStoryStats } from '../lib/graph/stats'
import type { LintEntry } from '../lib/graph/stats'
import { formatCount } from '../lib/graph/paths'
import { nodeLabel } from '../types/story'

const emit = defineEmits<{ close: []; open: [id: string] }>()

/**
 * What the story adds up to, computed when asked rather than as you type.
 *
 * On demand by construction: the component only exists while the panel is open,
 * so nothing here runs during ordinary writing. It is still a `computed`, so a
 * change made underneath an open panel is reflected rather than going stale.
 */
const s = computed(() => computeStoryStats(store.state.doc, store.layout.value))

const total = computed(() => formatCount(s.value.totalRoutes))

/** Which lint group is expanded. One at a time — the panel is a readout, not a workspace. */
const open = ref<string | null>(null)

const LINTS: { key: string; label: string; hint: string; rows: () => LintEntry[] }[] = [
  {
    key: 'broken',
    label: 'Broken links',
    hint: 'Links pointing at a code no passage has.',
    rows: () => s.value.lint.brokenLinks,
  },
  {
    key: 'unreachable',
    label: 'Unreachable passages',
    hint: 'No route from the start passage leads here.',
    rows: () => s.value.lint.unreachable,
  },
  {
    key: 'stranded',
    label: 'Stranded behind an Ending',
    hint: 'Reachable by links, but every route stops at an Ending first.',
    rows: () => s.value.lint.strandedBehindEnding,
  },
  {
    key: 'deadends',
    label: 'Dead ends not marked as an Ending',
    hint: 'Routes stop here, but you never said they should. Usually an unwritten branch.',
    rows: () => s.value.lint.unmarkedDeadEnds,
  },
  {
    key: 'endinglinks',
    label: 'Endings with links leaving them',
    hint: 'Routes stop at these, so whatever they link to is unreachable.',
    rows: () => s.value.lint.endingsWithLinks,
  },
]

const lints = computed(() => LINTS.map((l) => ({ ...l, entries: l.rows() })))
const clean = computed(() => lints.value.every((l) => l.entries.length === 0))

/**
 * Hand the passage to `App`, which is the only place that knows how to reveal
 * one — select it, open the inspector, and centre the canvas on it. Selecting
 * alone left the author looking at wherever they already were, with the card
 * they clicked still off-screen.
 */
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
    <div class="sheet" role="dialog" aria-label="Story statistics">
      <header>
        <h2>Story stats</h2>
        <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
      </header>

      <div class="scroll">
        <section class="tiles">
          <div class="tile">
            <span class="n">{{ s.words.total.toLocaleString('en-US') }}</span>
            <span class="k">words</span>
          </div>
          <div class="tile">
            <span class="n">{{ s.shape.passages }}</span>
            <span class="k">passages</span>
          </div>
          <div class="tile">
            <span class="n">{{ total }}</span>
            <span class="k">routes</span>
          </div>
          <div class="tile">
            <span class="n">{{ s.endings.rows.length }}</span>
            <span class="k">endings</span>
          </div>
        </section>

        <section>
          <h3>Endings</h3>
          <p v-if="s.endings.rows.length === 0" class="hint">
            Nothing is marked as an Ending yet. Tick &ldquo;Mark as Ending&rdquo; on a passage and
            it will show up here with the share of routes that reach it.
          </p>
          <table v-else class="rows">
            <thead>
              <tr>
                <th>Ending</th>
                <th class="num">Routes</th>
                <th class="bar-col" />
                <th class="num">Share</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in s.endings.rows" :key="row.id" :class="{ zero: row.routes === 0n }">
                <td>
                  <button class="link" @click="go(row.id)">
                    {{ nodeLabel(row.code, row.title) }}
                  </button>
                  <span v-if="row.routes === 0n" class="tag">unreachable</span>
                </td>
                <td class="num">{{ formatCount(row.routes) }}</td>
                <td class="bar-col">
                  <!-- No track at all for an unreachable ending: `min-width` keeps a
                       tiny share visible, but at zero it paints a stub that reads
                       as a share rather than the absence of one. -->
                  <span v-if="row.percent > 0" class="bar" :style="{ width: `${row.percent}%` }" />
                </td>
                <td class="num">{{ row.percent }}%</td>
              </tr>
              <tr v-if="s.endings.unmarkedRoutes > 0n" class="reconcile">
                <td>Stopping at an unmarked dead end</td>
                <td class="num">{{ formatCount(s.endings.unmarkedRoutes) }}</td>
                <td class="bar-col" />
                <td class="num">{{ s.endings.unmarkedPercent }}%</td>
              </tr>
            </tbody>
          </table>
          <p v-if="s.endings.unmarkedRoutes > 0n" class="hint">
            Shares add up to 100% once every dead end is marked as an Ending.
          </p>
        </section>

        <section>
          <h3>Draft health</h3>
          <p v-if="clean" class="hint hint-ok">Nothing to flag &mdash; no broken links, no
            orphans, every dead end accounted for.</p>
          <ul v-else class="lints">
            <li v-for="l in lints" :key="l.key" :class="{ none: l.entries.length === 0 }">
              <button
                class="lint-head"
                :disabled="l.entries.length === 0"
                @click="open = open === l.key ? null : l.key"
              >
                <span class="count">{{ l.entries.length }}</span>
                <span class="what">
                  {{ l.label }}
                  <span class="hint">{{ l.hint }}</span>
                </span>
                <span v-if="l.entries.length > 0" class="chev">{{ open === l.key ? '−' : '+' }}</span>
              </button>
              <ul v-if="open === l.key" class="entries">
                <li v-for="e in l.entries" :key="e.id">
                  <button class="link" @click="go(e.id)">{{ nodeLabel(e.code, e.title) }}</button>
                  <span v-if="e.detail" class="tag">{{ e.detail }}</span>
                </li>
              </ul>
            </li>
          </ul>
        </section>

        <section>
          <h3>Progress</h3>
          <table class="rows">
            <thead>
              <tr>
                <th>State</th>
                <th class="num">Passages</th>
                <th class="num">Words</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in s.completion.byState" :key="b.state">
                <td><span class="dot" :class="`state-${b.state}`" />{{ b.state }}</td>
                <td class="num">{{ b.passages }}</td>
                <td class="num">{{ b.words.toLocaleString('en-US') }}</td>
              </tr>
            </tbody>
          </table>
          <p class="hint">
            {{ s.completion.passagePercentDone }}% of passages done,
            {{ s.completion.wordPercentDone }}% of the prose.
          </p>
        </section>

        <section class="two">
          <div>
            <h3>Shape</h3>
            <table class="rows plain">
              <tbody>
                <tr><td>Levels deep</td><td class="num">{{ s.shape.depth }}</td></tr>
                <tr><td>Choice points</td><td class="num">{{ s.shape.choicePoints }}</td></tr>
                <tr>
                  <td>Links per passage</td>
                  <td class="num">{{ s.shape.meanBranching }}</td>
                </tr>
                <tr>
                  <td>Route length</td>
                  <td class="num">
                    {{ s.shape.shortestRoutePassages }}&ndash;{{ s.shape.longestRoutePassages }}
                  </td>
                </tr>
                <tr v-if="s.shape.phantoms > 0">
                  <td>Phantom targets</td>
                  <td class="num">{{ s.shape.phantoms }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <h3>One playthrough</h3>
            <table class="rows plain">
              <tbody>
                <tr>
                  <td>Words, typical</td>
                  <td class="num">{{ s.playthrough.meanWords.toLocaleString('en-US') }}</td>
                </tr>
                <tr>
                  <td>Words, shortest</td>
                  <td class="num">{{ s.playthrough.shortestWords.toLocaleString('en-US') }}</td>
                </tr>
                <tr>
                  <td>Words, longest</td>
                  <td class="num">{{ s.playthrough.longestWords.toLocaleString('en-US') }}</td>
                </tr>
                <tr>
                  <td>Reading time</td>
                  <td class="num">~{{ s.playthrough.meanMinutes }} min</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <footer>
        <span class="muted">
          Words are counted from the raw body, so link and macro syntax counts too.
        </span>
        <button class="btn btn-primary" @click="emit('close')">Done</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Ladder: body 92, sheet 94, help 95, settings 96, recode 97, stats 98, startup 100. */
.veil {
  position: fixed;
  inset: 0;
  z-index: 98;
  display: grid;
  place-items: center;
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

/* The four numbers worth seeing before reading anything. */
.tiles {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
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

.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
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

/* Must out-specify `table.rows th` (0,1,2), which a bare `.num` (0,1,0) loses
   to — so a numeric header sat left while its column sat right. */
table.rows th.num {
  text-align: right;
}

table.rows td {
  padding: 5px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: baseline;
}

table.rows.plain td {
  color: var(--text-dim);
}

table.rows tbody tr:last-child td {
  border-bottom: none;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* The bar gets a column of its own rather than sharing the number's cell: in a
   ranked table the shape is read before the digits, and a bar whose left edge
   drifts with the width of the number beside it cannot be compared down the
   column. Fixed track, so every bar starts in the same place. */
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

tr.zero td {
  color: var(--text-faint);
}

tr.reconcile td {
  color: var(--text-faint);
  font-style: italic;
}

.tag {
  margin-left: 6px;
  font-size: 10px;
  color: var(--text-faint);
}

/* A row is a way back to the passage, not just a label: every list in here
   names something the author may want to go and fix. */
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

.lints {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.lints > li + li {
  border-top: 1px solid var(--border);
}

.lint-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.lint-head:disabled {
  cursor: default;
  opacity: 0.5;
}

.lint-head .count {
  flex: 0 0 auto;
  min-width: 22px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.lints > li:not(.none) .count {
  color: var(--todo);
  border-color: color-mix(in srgb, var(--todo) 35%, transparent);
  background: color-mix(in srgb, var(--todo) 12%, transparent);
}

.lint-head .what {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  flex: 1;
}

.lint-head .chev {
  flex: 0 0 auto;
  color: var(--text-faint);
  font-size: 13px;
}

.entries {
  list-style: none;
  margin: 0;
  padding: 2px 12px 10px 44px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 7px;
  border-radius: 50%;
  background: var(--state);
}

.hint-ok {
  color: var(--ending);
}
</style>
