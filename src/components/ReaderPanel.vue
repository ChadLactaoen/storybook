<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Block, Inline } from '../lib/harlowe/run'
import { linesOf } from '../lib/harlowe/run'
import {
  canPlayBack,
  playBack,
  playChoose,
  playMidStory,
  playNotice,
  playRestart,
  playRoute,
  playStep,
  playVars,
} from '../stores/play'

const emit = defineEmits<{ close: [] }>()

const consoleOpen = ref(false)

const view = computed(() => playStep.value)
/** The page number at the foot, and the title when the author wrote none. */
const heading = computed(() => {
  const node = view.value?.node
  if (!node) return ''
  return node.title.trim().length > 0 ? node.title : node.code
})

/** A line holding nothing but links is a choice list, not prose. */
function isChoiceLine(line: readonly Inline[]): boolean {
  return (
    line.length > 0 &&
    line.every(
      (inline) => inline.kind === 'link' || (inline.kind === 'text' && inline.text.trim() === ''),
    )
  )
}

/**
 * The prose, without the lines that are nothing but links.
 *
 * An author writing `[[Go down to the pier]]` on its own line means it as a
 * choice, and the rows below are already that list — rendering it here too shows
 * every choice twice. A link *inside* a sentence still renders where it was
 * written, because there it is prose as well as a choice.
 *
 * Per *line*, not per block: `toBlocks` merges consecutive non-blank lines, so
 * the commonest Twine shape of all — links written directly under the prose,
 * with no blank line between — is one block, and filtering blocks missed it
 * entirely.
 */
const prose = computed<Block[]>(() =>
  (view.value?.result.blocks ?? []).flatMap((block) => {
    const kept = linesOf(block.inlines).filter((line) => !isChoiceLine(line))
    if (kept.every((line) => line.length === 0)) return []
    const inlines: Inline[] = []
    for (const line of kept) {
      if (inlines.length > 0) {
        inlines.push({ kind: 'text', text: '\n', bold: false, italic: false, uncertain: false, inert: false })
      }
      inlines.push(...line)
    }
    return [{ kind: block.kind, inlines }]
  }),
)

/** Text for a `title` attribute: what the evaluator could not read, in full. */
function chipTitle(inline: Extract<Inline, { kind: 'unsupported' }>): string {
  return `${inline.source}\n\nThis reader could not run that, so it is showing what it wrapped rather than hiding it.`
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="veil" @click.self="emit('close')">
    <div class="sheet" role="dialog" aria-label="Read the story">
      <header>
        <button
          class="btn btn-ghost"
          :disabled="!canPlayBack"
          title="Back one choice"
          @click="playBack()"
        >
          &lsaquo; Back
        </button>
        <span class="depth" v-if="view">{{ playRoute }}</span>
        <button class="btn btn-ghost btn-icon" title="Close (Esc)" @click="emit('close')">
          &times;
        </button>
      </header>

      <div class="scroll">
        <p v-if="playNotice" class="notice">{{ playNotice }}</p>

        <article v-if="view" class="page">
          <h2>{{ heading }}</h2>

          <p v-if="playMidStory" class="note mid">
            Started mid-story, so every variable begins unset — conditions that depend on
            earlier passages will not fire.
          </p>

          <div class="prose">
            <component
              :is="block.kind === 'quote' ? 'blockquote' : 'p'"
              v-for="(block, b) in prose"
              :key="b"
            >
              <template v-for="(inline, i) in block.inlines" :key="i">
                <span
                  v-if="inline.kind === 'text'"
                  :class="{ b: inline.bold, i: inline.italic, hazy: inline.uncertain }"
                  >{{ inline.text }}</span
                >
                <span
                  v-else-if="inline.kind === 'variable'"
                  class="var"
                  :class="{ b: inline.bold, i: inline.italic, hazy: inline.uncertain, unset: inline.state !== 'set' }"
                  :title="
                    inline.state === 'set'
                      ? `${inline.name} is ${JSON.stringify(inline.value)}`
                      : inline.state === 'unset'
                        ? `${inline.name} was never set on this route`
                        : `${inline.name} was set by something this reader cannot read`
                  "
                  >{{ inline.state === 'set' ? inline.value : inline.name }}</span
                >
                <button
                  v-else-if="inline.kind === 'link'"
                  class="inline-link"
                  :class="{ b: inline.bold, i: inline.italic, hazy: inline.uncertain }"
                  :disabled="(view.choices.find((c) => c.ordinal === inline.ordinal)?.blocked ?? null) !== null"
                  @click="playChoose(inline.ordinal)"
                >
                  {{ inline.label }}
                </button>
                <span v-else class="chip" :title="chipTitle(inline)">({{ inline.name }}:)</span>
              </template>
            </component>
          </div>

          <p v-if="view.result.asks.length > 0" class="note">
            This passage asks the reader for
            <template v-for="(ask, a) in view.result.asks" :key="a"
              ><code>{{ ask.variable }}</code
              ><span v-if="a < view.result.asks.length - 1">, </span></template
            >. Nothing is typed in here, so it stays unset.
          </p>

          <ul v-if="view.choices.length > 0" class="choices">
            <li v-for="choice in view.choices" :key="choice.ordinal">
              <button
                class="choice"
                :class="{ hazy: choice.uncertain }"
                :disabled="choice.blocked !== null"
                @click="playChoose(choice.ordinal)"
              >
                <span class="what">{{ choice.label }}</span>
                <span v-if="choice.blocked === 'ending'" class="why">routes stop here</span>
                <span v-else-if="choice.blocked === 'phantom'" class="why">
                  {{ choice.target }} — no passage with this code yet
                </span>
                <span v-else class="to">{{ choice.target }}</span>
              </button>
            </li>
          </ul>

          <p v-if="view.node.isEnding" class="plate">
            <strong>The End</strong>
            <span class="route">{{ playRoute }}</span>
            <button class="btn" @click="playRestart()">Read again</button>
          </p>
          <p v-else-if="view.unwritten" class="note">
            Nothing links out of this passage yet.
          </p>

          <hr />
          <p class="folio">{{ view.node.code }}</p>
        </article>
      </div>

      <footer>
        <button
          class="disclose"
          :aria-expanded="consoleOpen"
          :title="consoleOpen ? 'Hide the console' : 'Show variables and the route'"
          @click="consoleOpen = !consoleOpen"
        >
          <span class="caret" :class="{ open: consoleOpen }">&rsaquo;</span>
          <span>Console</span>
        </button>

        <div v-if="consoleOpen" class="console">
          <p class="row">
            <span class="k">Route</span>
            <code class="v">{{ playRoute || '—' }}</code>
          </p>
          <p v-if="playVars.length === 0" class="row">
            <span class="k">Variables</span>
            <span class="v empty">none set on this route</span>
          </p>
          <p v-for="v in playVars" v-else :key="v.name" class="row">
            <code class="k">{{ v.name }}</code>
            <span class="v">
              <template v-if="v.value === null"><em>not readable</em></template>
              <template v-else>{{ v.value }}</template>
              <span class="by">set by {{ v.setBy }}</span>
            </span>
          </p>
          <p v-if="view && view.result.unsupported.length > 0" class="row">
            <span class="k">Could not read</span>
            <span class="v">{{ view.result.unsupported.join(', ') }}</span>
          </p>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Ladder: body 92, sheet 94, help 95, settings 96, recode 97, stats 98,
   reader 99, startup 100. The reader is a focus mode and covers anything the
   author left open, but never the startup dialog — there is no story to read
   without one. */
.veil {
  position: fixed;
  inset: 0;
  z-index: 99;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--text) 40%, transparent);
}

.sheet {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 640px;
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
  gap: 8px;
  padding: 8px 10px 8px 8px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

.depth {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scroll {
  overflow: auto;
  flex: 1 1 auto;
}

.page {
  /* A reader set in the UI sans reads as a settings panel, not a book. */
  font-family: var(--serif);
  font-size: 16px;
  line-height: 1.7;
  color: var(--text);
  padding: 32px 40px 24px;
}

h2 {
  margin: 0 0 20px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.prose :deep(p),
.prose blockquote,
.prose p {
  margin: 0 0 16px;
  /* A newline inside a block is a line break the author wrote; `normal` would
     collapse it to a space and run two lines together. It also keeps the
     spacing a verbatim span exists to preserve. */
  white-space: pre-wrap;
}

blockquote {
  padding-left: 16px;
  border-left: 2px solid var(--border-strong);
  color: var(--text-dim);
  font-style: italic;
}

.b {
  font-weight: 700;
}

.i {
  font-style: italic;
}

/* Everything the evaluator could not establish, at a glance: the chip says what
   it could not read, this says how far the doubt reaches. */
.hazy {
  opacity: 0.62;
  text-decoration: underline dotted var(--text-faint);
  text-underline-offset: 3px;
}

.var {
  border-bottom: 1px dotted var(--border-strong);
}

.var.unset {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text-faint);
}

.chip {
  font-family: var(--mono);
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--panel-alt);
  color: var(--text-faint);
  border: 1px solid var(--border);
  white-space: nowrap;
}

.inline-link {
  font: inherit;
  color: var(--accent);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.inline-link:disabled {
  color: var(--text-faint);
  cursor: default;
  text-decoration-style: dashed;
}

.choices {
  list-style: none;
  margin: 24px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.choice {
  width: 100%;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font: inherit;
  font-size: 15px;
  text-align: left;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-alt);
  color: var(--text);
  cursor: pointer;
}

.choice:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.choice:disabled {
  cursor: default;
  border-style: dashed;
  color: var(--text-faint);
}

.choice .what {
  overflow: hidden;
  text-overflow: ellipsis;
}

.choice .to,
.choice .why {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  flex: 0 0 auto;
}

.plate {
  margin: 28px 0 0;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-alt);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.plate strong {
  font-size: 17px;
  letter-spacing: 0.02em;
}

.plate .route {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

.note {
  font-family: var(--sans);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  margin: 16px 0;
}

.note.mid {
  margin-top: 0;
}

.notice {
  font-family: var(--sans);
  font-size: 13px;
  color: var(--text-dim);
  padding: 32px 40px;
  margin: 0;
}

hr {
  margin: 28px 0 10px;
  border: none;
  border-top: 1px solid var(--border);
}

.folio {
  margin: 0;
  text-align: right;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
}

footer {
  flex: 0 0 auto;
  border-top: 1px solid var(--border);
  padding: 6px 10px 8px;
  font-family: var(--sans);
}

/* A real button with its own caret, not a <summary>: styling one `display:
   flex` kills the native marker, which is the failure CLAUDE.md's test section
   closes on. No <details> is left in this app. */
.disclose {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: none;
  border: none;
  padding: 4px 2px;
  font: inherit;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}

.caret {
  display: inline-block;
  transition: transform 0.12s ease;
  color: var(--text-faint);
}

.caret.open {
  transform: rotate(90deg);
}

.console {
  padding: 4px 2px 2px;
  font-size: 12px;
}

.row {
  display: flex;
  gap: 10px;
  margin: 0 0 4px;
  align-items: baseline;
}

.row .k {
  flex: 0 0 96px;
  color: var(--text-faint);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row .v {
  flex: 1 1 auto;
  color: var(--text);
  overflow-wrap: anywhere;
}

.row .v.empty {
  color: var(--text-faint);
}

.row .by {
  margin-left: 8px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-faint);
}
</style>
