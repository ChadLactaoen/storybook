<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

const emit = defineEmits<{ close: [] }>()

/**
 * The things tooltips cannot carry: the one concept that makes the app make
 * sense, the link syntax, and the shortcuts that are otherwise invisible.
 */

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = IS_MAC ? 'Cmd' : 'Ctrl'

const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: `${MOD} +`, what: 'Zoom in' },
  { keys: `${MOD} -`, what: 'Zoom out' },
  { keys: `${MOD} 0`, what: 'Zoom to fit the whole story' },
  { keys: `${MOD} 1`, what: 'Reset zoom to 100%' },
  { keys: `${MOD} F`, what: 'Jump to search' },
  { keys: `${MOD} Z`, what: 'Undo' },
  { keys: `${MOD} ⇧ Z`, what: 'Redo' },
  { keys: 'N', what: 'New passage, linked from the selected one' },
  { keys: 'Delete', what: 'Delete the selected passage' },
]

const LINKS: { syntax: string; what: string }[] = [
  { syntax: '[[Cave]]', what: 'Link straight to the passage named Cave' },
  { syntax: '[[Go north|Cave]]', what: 'Show “Go north”, go to Cave' },
  { syntax: '[[Go north->Cave]]', what: 'The same, written with an arrow' },
  { syntax: '[[Cave<-Go north]]', what: 'The same, arrow pointing the other way' },
]

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="veil" @click.self="emit('close')">
    <div class="sheet" role="dialog" aria-label="How Storybook works">
      <header>
        <h2>How Storybook works</h2>
        <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
      </header>

      <div class="scroll">
        <section class="lead">
          <h3>The tree draws itself</h3>
          <p>
            You don&rsquo;t place passages &mdash; you link them, and the layout follows. Write a
            link in a passage&rsquo;s body and the passage you linked to appears below it. That is
            why cards can&rsquo;t be dragged: their position <em>is</em> your structure.
          </p>
          <p>
            A passage&rsquo;s <strong>level</strong> is one below the deepest passage that links to
            it. Insert a passage in the middle of a branch and everything downstream re-levels on
            its own. You can nudge a passage one level down for looks, from the inspector &mdash;
            moving it <em>up</em> is impossible, because that would put a link inside a level.
          </p>
        </section>

        <section>
          <h3>Writing links</h3>
          <table class="syntax">
            <tbody>
              <tr v-for="row in LINKS" :key="row.syntax">
                <td><code>{{ row.syntax }}</code></td>
                <td>{{ row.what }}</td>
              </tr>
            </tbody>
          </table>
          <p class="note">
            Link to a passage that doesn&rsquo;t exist yet and it is created for you. Delete a
            passage and the links to it stay as written &mdash; they show up as a dashed card you
            can double-click to bring back.
          </p>
        </section>

        <section>
          <h3>Getting around</h3>
          <ul class="plain">
            <li>Scroll to zoom, drag the background to pan.</li>
            <li>Click a card to open it; double-click to centre on it.</li>
            <li><strong>Fit</strong> in the toolbar frames the whole story.</li>
            <li>
              <strong>Expand</strong>, above a passage&rsquo;s body, opens the same editor over the
              whole window for longer prose.
            </li>
          </ul>
        </section>

        <section>
          <h3>Keeping track</h3>
          <ul class="plain">
            <li>
              Each card carries a status dot &mdash;
              <span class="chip state-TODO"><span class="dot" />TODO</span>
              <span class="chip state-Draft"><span class="dot" />Draft</span>
              <span class="chip state-Done"><span class="dot" />Done</span>
              &mdash; counted in the toolbar.
            </li>
            <li><strong>Tags</strong> are shared story-wide and can be colour-coded.</li>
            <li>
              <strong>Cast &amp; Settings</strong> lists every character and location with a
              passage count. Click one to dim everything else.
            </li>
            <li>
              The <strong>paths</strong> count is how many distinct routes run from the start
              passage to an ending.
            </li>
          </ul>
        </section>

        <section>
          <h3>Your work is saved</h3>
          <p>
            Every change is saved to this browser automatically &mdash; the toolbar shows when.
            That is not a backup: it lives in this browser only. Use <strong>Export</strong> for a
            <code>.json</code> file you can keep or move, and <strong>Import</strong> to open one.
          </p>
        </section>

        <section>
          <h3>Shortcuts</h3>
          <table class="keys">
            <tbody>
              <tr v-for="row in SHORTCUTS" :key="row.keys">
                <td><kbd>{{ row.keys }}</kbd></td>
                <td>{{ row.what }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <footer>
        <span class="muted">Press <kbd>Esc</kbd> to close</span>
        <button class="btn btn-primary" @click="emit('close')">Got it</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.veil {
  position: fixed;
  inset: 0;
  z-index: 95;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--text) 32%, transparent);
}

.sheet {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 620px;
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
  margin: 0 0 6px;
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
  gap: 18px;
}

p {
  margin: 0 0 8px;
  line-height: 1.6;
}

p:last-child {
  margin-bottom: 0;
}

.lead p {
  font-size: 13px;
}

.note {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-dim);
}

.plain {
  margin: 0;
  padding-left: 18px;
  line-height: 1.7;
}

table {
  width: 100%;
  border-collapse: collapse;
}

td {
  padding: 3px 0;
  vertical-align: baseline;
}

.syntax td:first-child,
.keys td:first-child {
  width: 42%;
  padding-right: 12px;
  white-space: nowrap;
}

.keys td:first-child {
  width: 30%;
}

td:last-child {
  color: var(--text-dim);
}

code {
  font-family: var(--mono);
  font-size: 11.5px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg);
}

kbd {
  display: inline-block;
  min-width: 22px;
  padding: 2px 6px;
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--panel-alt);
  font-family: var(--sans);
  font-size: 11px;
  text-align: center;
  white-space: nowrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  margin: 0 1px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--state);
  background: color-mix(in srgb, var(--state) 13%, transparent);
  border: 1px solid color-mix(in srgb, var(--state) 28%, transparent);
}

.chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--state);
}

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}

.muted {
  font-size: 11px;
  color: var(--text-faint);
}
</style>
