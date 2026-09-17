<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { SLUG_MAX } from '../lib/doc/mutations'
import { authoredIn, authoredOut, forwardTargets, formatCount, share } from '../lib/graph/paths'
import { prefs } from '../stores/prefs'
import * as store from '../stores/story'
import type { NodeState, TagColor } from '../types/story'
import { NODE_STATES, compareNodes, nodeLabel } from '../types/story'
import BodyDialog from './BodyDialog.vue'
import CharacterPicker from './CharacterPicker.vue'
import HarloweEditor from './HarloweEditor.vue'
import TagPicker from './TagPicker.vue'

const emit = defineEmits<{ close: []; cheatSheet: []; open: [id: string]; play: [id: string] }>()

const node = store.selected
const geom = store.selectedLayout

/**
 * With more than one passage selected the sidebar switches to a summary: the
 * per-passage editor has no meaning for a set, and the delete that the set is
 * for needs somewhere to explain itself.
 */
const picked = store.selectedNodes
const impact = store.deleteImpact
const multi = computed(() => store.state.selectedIds.length > 1)
const refused = computed(() => (impact.value?.stranded.length ?? 0) > 0)

const pendingDelete = ref(false)
watch(multi, () => (pendingDelete.value = false))

function confirmDeleteSelection() {
  pendingDelete.value = false
  // A refusal surfaces in the notice banner, the same as the keyboard path.
  store.removeSelected()
}

const titleDraft = ref('')
const codeDraft = ref('')
const codeError = ref<string | null>(null)

/**
 * A draft synced on blur, not a computed writing through on every keystroke.
 *
 * `setNote` no longer normalizes, so the old argument for this is gone — but
 * the field is a textarea now, and committing a multi-paragraph note on every
 * keystroke would push an undo entry per character through a field people write
 * sentences in. Blur is the right granularity for prose; `titleDraft` and
 * `codeDraft` are drafts for their own reasons.
 */
const noteDraft = ref('')

/**
 * A draft for the same reason, and one sharper one.
 *
 * `normalizeSlug` strips `*`. Written through on every keystroke, typing one
 * would delete the character as it appeared, leave the document unchanged, and
 * — on the next character that did commit — snap the caret to the end. On blur
 * the author sees the `*` they typed quietly dropped, once, which is what the
 * hint below the field warns them about.
 */
const slugDraft = ref('')

// Keyed on the node, not on its id. Every mutation clones, so this re-reads
// after one — which is the point: keyed on the id, an undo would revert the
// document while the field went on showing the value that was undone, and the
// next blur would commit it straight back and quietly defeat the undo. Nothing
// here is typed into without committing on the way out, so re-reading costs no
// keystrokes. `codeError` below is the deliberate exception.
watch(
  node,
  (n) => {
    titleDraft.value = n?.title ?? ''
    codeDraft.value = n?.code ?? ''
    slugDraft.value = n?.slug ?? ''
    noteDraft.value = n?.note ?? ''
  },
  { immediate: true },
)

// Keyed on the id, not the node: every mutation clones, so watching the object
// would clear a refusal on the author's next keystroke anywhere — including in
// the Note field directly above, which commits live. A rejected code has to
// stand until the author does something about it.
watch(
  () => node.value?.id,
  () => {
    codeError.value = null
  },
  { immediate: true },
)


function commitNote() {
  if (!node.value) return
  store.noteSet(node.value.id, noteDraft.value)
  noteDraft.value = node.value.note
}


function commitSlug() {
  if (!node.value) return
  store.slugSet(node.value.id, slugDraft.value)
  slugDraft.value = node.value.slug
}

/**
 * The whole running slug, untruncated.
 *
 * The card shows only the tail, because the line is 161px wide and a running
 * slug grows with depth. This is the one place the full string is readable, so
 * it is not abbreviated here whatever its length.
 *
 * `null` means no route from the start arrives — a different thing from `''`,
 * which means the route is real and nothing on it carries a mark yet.
 */
const runningSlug = computed<string | null>(() => {
  const id = node.value?.id
  if (id === undefined) return null
  return store.runningSlugs.value.get(id) ?? null
})

/**
 * Whether the card is drawing it too.
 *
 * It is not, once nothing at or below this passage carries a mark — the code is
 * finished and the canvas stops repeating it. Saying so here is what keeps a
 * blank card line from reading as a bug.
 */
/**
 * Whether this passage is carrying a note.
 *
 * Read off the document rather than the draft: a half-typed note has not been
 * committed yet, and the tab should not start claiming one mid-keystroke and
 * then lose it if the author clears the field again.
 */
const hasNote = computed(() => (node.value?.note ?? '').length > 0)

const runOnCard = computed(() => {
  const id = node.value?.id
  return id !== undefined && (store.cardSlugs.value.get(id) ?? '') !== ''
})

const inferred = store.selectedGate

// Nothing to validate: titles are cosmetic, repeatable and may be left empty.
function commitTitle() {
  if (!node.value) return
  store.rename(node.value.id, titleDraft.value)
}

function revertTitle() {
  titleDraft.value = node.value?.title ?? ''
}

// Committed on blur rather than per keystroke, because a code has to be unique:
// typing "A3" over an existing "A" would otherwise fail on every character. The
// commit also rewrites every inbound link, which is not a per-keystroke job.
function commitCode() {
  if (!node.value) return
  if (codeDraft.value.trim() === node.value.code) {
    codeError.value = null
    return
  }
  codeError.value = store.codeSet(node.value.id, codeDraft.value)
}

function revertCode() {
  codeDraft.value = node.value?.code ?? ''
  codeError.value = null
}

const body = computed({
  get: () => node.value?.body ?? '',
  set: (v: string) => node.value && store.editBody(node.value.id, v),
})

/**
 * The body as it stood when the author started editing.
 *
 * `resolveLinks` needs it to tell a link they just wrote from one that was
 * already there and deliberately left dangling. Captured lazily on the first
 * keystroke after a settle, because focus alone is not an edit.
 */
const bodyAtFocus = ref<string | null>(null)

// Keyed on the id, not the node: every mutation clones, so watching the object
// would reset this on the author's own keystroke and the body would never settle.
watch(
  () => node.value?.id,
  () => {
    bodyAtFocus.value = null
  },
)

function onBodyInput(v: string) {
  if (!node.value) return
  if (bodyAtFocus.value === null) bodyAtFocus.value = node.value.body
  store.editBody(node.value.id, v)
}

/** The author has left the editor: bind the links they wrote. */
function settleBody() {
  const was = bodyAtFocus.value
  bodyAtFocus.value = null
  if (node.value && was !== null) store.resolveBody(node.value.id, was)
}

/* ---------- tabs ---------- */

/**
 * Which half of the sidebar is showing.
 *
 * Global rather than per-passage, and deliberately sticky across a selection
 * change: the component stays mounted and only `node` swaps, so structuring
 * several passages in a row keeps the same half in front of you. A per-passage
 * memory would change the sidebar's shape as you arrow through cards, which is
 * a mode moving under the author.
 */
const tab = ref<'write' | 'advanced'>('write')

/**
 * Commit everything the swap is about to unmount, *before* it does.
 *
 * Every field in this sidebar commits on blur, and a tab switch removes the one
 * being typed in. Whether that produces a `blur` at all is browser-dependent —
 * clicking a `<button>` moves focus on Chrome but not on Safari or Firefox for
 * macOS, and no browser fires `blur` for a focused element removed from the DOM.
 * So a draft left to `@blur` is discarded on some browsers and not others, and
 * the next document change resets it from the document, wiping what the author
 * typed with no trace. Each `commit*` is already a no-op when nothing changed,
 * so a switch without an edit costs nothing.
 *
 * `settleBody` is the one that matters most: it is `resolveLinks`, so skipping
 * it means a link the author just wrote never binds and the passage it names is
 * never created.
 *
 * A refused code is the one thing that can *stop* the swap. It is only legible
 * beside the field holding the rejected text, and that field lives here — so
 * leaving would discard the refusal along with it and the code would silently
 * keep its old value, which is the very failure the Code disclosure's forced
 * open used to guard. Escape in the field reverts and unblocks.
 */
function pickTab(next: 'write' | 'advanced') {
  if (next === tab.value) return
  if (tab.value === 'write') {
    commitTitle()
    settleBody()
  } else {
    commitNote()
    commitSlug()
    commitCode()
    if (codeError.value !== null) return
  }
  tab.value = next
}

/** What the editor's link picker offers, here and in the pop-out. */
const targets = computed(() =>
  [...store.state.doc.nodes].sort(compareNodes).map((n) => ({ code: n.code, title: n.title })),
)

/**
 * Hoisted rather than called from each of its two readers: `pathsFrom` rebuilds
 * the ending set and runs a fresh BigInt walk every time, and both the tile and
 * the coverage share below want the same number on every document change.
 */
const routesOut = computed(() => (node.value ? store.pathsFrom(node.value.id) : 0n))
const pathCount = computed(() => formatCount(routesOut.value))

/** Routes the reader can take from the start to get here. */
const routesIn = computed(() => (node.value ? store.pathsTo(node.value.id) : 0n))
const routesInCount = computed(() => formatCount(routesIn.value))

/**
 * How much of the story runs through this passage.
 *
 * A complete route is one the reader can actually finish: start to wherever
 * nothing leads on — a dead end, or an Ending the author marked. The routes
 * through here are exactly the ways of getting here times the ways of carrying
 * on, because forward levels increase strictly, so no route can visit this
 * passage twice and every route through it splits at it exactly once.
 *
 * The Ending flag matters to this only in a story that has already been warned
 * about: a marked Ending with links still leaving it is not a leaf, and routes
 * stop there anyway. Counting it any other way would have the same tile read
 * "Routes leading here: 0" and "on 100% of all routes" about one passage.
 *
 * `null` when there is no start, or nothing to be a share of.
 */
const routeCoverage = computed<number | null>(() => {
  const id = node.value?.id
  const startId = store.state.doc.startNodeId
  if (id === undefined || startId === null) return null
  const total = store.pathsFrom(startId)
  if (total <= 0n) return null
  return share(routesIn.value * routesOut.value, total)
})

/**
 * The share as the tile prints it.
 *
 * `share` divides in BigInt before rounding, so anything under 0.05% comes back
 * as exactly `0` — and "Routes leading here: 1" above "on 0% of all routes"
 * reads as a broken sum rather than a small number. A story only needs a couple
 * of thousand routes to get there.
 */
const coverageLabel = computed<string | null>(() => {
  const pct = routeCoverage.value
  if (pct === null) return null
  return pct === 0 && routesIn.value > 0n ? '<0.1' : String(pct)
})

/**
 * Links the author wrote, not edges a route can take — the other question, and
 * the reason `authoredOut` lives in `paths.ts` beside `forwardTargets` rather
 * than being spelled out here. Off the route model a hub-and-spoke story
 * reports its own spokes as unwritten, and ticking one Ending changes the link
 * count of passages it never touched. The labels say "links" for the same reason.
 */
const linksOut = computed(() =>
  node.value ? authoredOut(store.layout.value.graph, node.value.id) : 0,
)
const linksIn = computed(() =>
  node.value ? authoredIn(store.layout.value.graph, node.value.id) : 0,
)

const isStart = computed(() => node.value?.id === store.state.doc.startNodeId)

/**
 * No route from the start arrives here.
 *
 * Broader than the gate inference's `dead` flag, and cheaper to explain: it
 * catches an orphan, a passage stranded behind an Ending, and a branch whose
 * condition nothing can satisfy, all as the one thing the author actually cares
 * about. The start passage itself is exempt — routes begin there rather than
 * reaching it, so `countPathsTo` counts zero and means nothing by it — and so is
 * every passage when the story has no start at all, where the count is zero for
 * a reason this sentence would misreport.
 */
const unreached = computed(
  () => routesIn.value === 0n && !isStart.value && store.state.doc.startNodeId !== null,
)

/**
 * Does a passage marked as an ending still link somewhere?
 *
 * Worth saying out loud right where the box is ticked: marking an ending is the
 * one edit in the app that can make other passages unreachable, and the author
 * should learn that here rather than from the stats panel later.
 */
const endingHasLinks = computed(() => {
  const id = node.value?.id
  if (!id) return false
  const { graph, backEdges } = store.layout.value
  // No `endings` argument: the passage is marked, and the warning is about the
  // links that marking it just stranded. The same call the stats lint makes.
  return forwardTargets(graph, backEdges, id).length > 0
})

/**
 * The inspector is a fixed-width column, so long prose is written through a
 * letterbox. Expanding swaps in the same editor over the whole window; both
 * write the same v-model, so there is nothing to sync when it closes.
 */
const expanded = ref(false)

// Driven from App.vue too, where the Cmd/Ctrl E shortcut lives. Guarded on the
// same condition the aside is — `expanded` outlives a selection change, so
// without it the dialog could be armed now and spring open later.
defineExpose({
  toggleExpanded: () => {
    if (node.value && geom.value) expanded.value = !expanded.value
  },
  /** For the shortcut layer: the expanded editor is a dialog that owns Escape. */
  isExpanded: () => expanded.value,
})

/* ---------- scene ---------- */

const setting = computed({
  get: () => node.value?.setting ?? '',
  set: (v: string) => node.value && store.settingSet(node.value.id, v),
})

// Both hints are one element with a computed string rather than two `v-if`
// paragraphs, so the section's shape never changes with a preference.
const settingHint = computed(() =>
  prefs.inheritSetting
    ? 'New passages linked from here start in this setting.'
    : 'This passage only. Editor settings can pass it on to new passages.',
)

const castHint = computed(() =>
  prefs.inheritCharacters
    ? 'New passages linked from here start with this cast. Notes here describe this scene only and are not copied.'
    : 'Notes here describe this scene only. The cast list is shared story-wide.',
)

const castPicker = ref<InstanceType<typeof CharacterPicker> | null>(null)

function castCreate(name: string) {
  if (!node.value) return
  castPicker.value?.setError(store.castCreateAndAdd(node.value.id, name))
}

// Named rather than inline in the template: an inline arrow loses the `v-if`
// narrowing on `node`, since the closure could outlive it.
function castNote(name: string, note: string) {
  if (node.value) store.castSetNote(node.value.id, name, note)
}

/* ---------- level control ---------- */

const pushedDown = computed(() => (node.value?.levelOffset ?? 0) === 1)

function setOffset(offset: number) {
  if (node.value) store.changeLevelOffset(node.value.id, offset)
}

/**
 * A passage can only ever sit at its structural floor or one below it. Moving
 * up is not merely discouraged, it is impossible: the floor is the deepest
 * parent's level plus one, so anything higher would put an edge inside a level.
 * Saying which parent pins it is far more useful than a validation error.
 */
const upBlockedBy = computed(() => store.blockingParent.value)
</script>

<template>
  <aside v-if="multi" class="inspector">
    <header>
      <span class="eyebrow">Selection</span>
      <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
    </header>

    <div class="scroll">
      <section>
        <p class="hint">{{ picked.length }} passages selected</p>
        <ul class="picked">
          <li v-for="n in picked" :key="n.id">
            <button
              class="row"
              :title="`Show ${nodeLabel(n.code, n.title)}`"
              @click="store.select(n.id)"
            >
              {{ nodeLabel(n.code, n.title) }}
            </button>
            <button
              class="btn btn-ghost btn-icon"
              title="Remove from the selection"
              @click="store.toggleSelected(n.id)"
            >
              &times;
            </button>
          </li>
        </ul>

        <!-- A blocked action says so where the button is, not only in the
             banner: the Delete below is disabled and this explains why. -->
        <div v-if="impact && refused" class="confirm">
          <span>
            Deleting these would cut
            {{ impact.stranded.map((n) => `"${nodeLabel(n.code, n.title)}"`).join(', ') }}
            off from the start. Select them too, or keep a link to them.
          </span>
        </div>
        <div v-else-if="impact && pendingDelete" class="confirm">
          <span>
            Delete {{ picked.length }} passages?
            <template v-if="impact.dangling > 0">
              {{ impact.dangling }} {{ impact.dangling === 1 ? 'link' : 'links' }} to them will be
              left as broken links.
            </template>
          </span>
          <button class="btn btn-ghost btn-icon" title="Cancel" @click="pendingDelete = false">
            &times;
          </button>
          <button class="btn danger" @click="confirmDeleteSelection">Delete</button>
        </div>
      </section>
    </div>

    <footer>
      <button class="btn" title="Deselect everything" @click="store.select(null)">Clear</button>
      <button class="btn danger" :disabled="refused" @click="pendingDelete = true">
        Delete {{ picked.length }} passages
      </button>
    </footer>
  </aside>

  <aside v-else-if="node && geom" class="inspector">
    <header>
      <span class="eyebrow">Passage</span>
      <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
    </header>

    <!-- `.seg.on` says which half is showing with a border colour and a tint,
         which is nothing at all to a screen reader. The roles carry it instead:
         without them the sidebar's whole contents change with no announcement
         and no way to tell which of two unlabelled buttons is current. -->
    <div class="tabs">
      <div class="segmented" role="tablist" aria-label="Passage sections">
        <button
          class="seg"
          role="tab"
          :class="{ on: tab === 'write' }"
          :aria-selected="tab === 'write'"
          aria-controls="passage-panel"
          data-tab="write"
          @click="pickTab('write')"
        >
          Write
        </button>
        <button
          class="seg"
          role="tab"
          :class="{ on: tab === 'advanced' }"
          :aria-selected="tab === 'advanced'"
          aria-controls="passage-panel"
          data-tab="advanced"
          :title="hasNote ? 'Advanced \u2014 this passage has a note' : 'Advanced'"
          @click="pickTab('advanced')"
        >
          Advanced
          <!-- The note moved behind this tab, so the tab has to say it is
               holding one. Not the accent the State dots take: this sits right
               beside the active tab, which is accent-coloured, and a purple dot
               against a purple tab is one nobody sees. -->
          <span v-if="hasNote" class="dot note-dot" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div id="passage-panel" class="scroll" role="tabpanel">
      <template v-if="tab === 'write'">
        <section>
          <label class="label" for="passage-title">Title</label>
          <input
            id="passage-title"
            v-model="titleDraft"
            class="field"
            @blur="commitTitle"
            @keydown.enter.prevent="commitTitle"
            @keydown.esc="revertTitle"
          />
          <p class="hint">
            A name for you. Two passages may share one, and it never affects links.
          </p>
        </section>

        <section class="grow">
          <div class="body-head">
            <span class="label">Body <span class="muted">Harlowe</span></span>
            <button class="expand" title="Edit in a larger window" @click="expanded = true">
              &#10530; Expand
            </button>
          </div>
          <p class="hint above">
            Link with <code>[[Text|Code]]</code>, <code>[[Text-&gt;Code]]</code> or
            <code>[[Code&lt;-Text]]</code>. A link to a code that doesn&rsquo;t exist creates the
            passage when you leave the editor.
          </p>
          <HarloweEditor
            :model-value="body"
            :targets="targets"
            @update:model-value="onBodyInput"
            @settle="settleBody"
          />
        </section>

        <section>
          <span class="label">State</span>
          <div class="segmented">
            <button
              v-for="s in NODE_STATES"
              :key="s"
              class="seg"
              :class="[`state-${s}`, { on: node.state === s }]"
              @click="store.changeState(node.id, s as NodeState)"
            >
              <span class="dot" />
              {{ s }}
            </button>
          </div>
        </section>

        <section>
          <span class="label">Tags</span>
          <TagPicker
            :tags="node.tags"
            :all-tags="store.tags.value"
            :colors="store.tagColors.value"
            @add="store.tagAdd(node.id, $event)"
            @remove="store.tagRemove(node.id, $event)"
            @recolor="(tag: string, color: TagColor) => store.tagRecolor(tag, color)"
          />
        </section>

        <section>
          <label class="label" for="passage-setting">Setting</label>
          <input
            id="passage-setting"
            v-model="setting"
            class="field"
            list="known-settings"
            placeholder="Where does this happen?"
          />
          <datalist id="known-settings">
            <option v-for="value in store.settingSuggestions.value" :key="value" :value="value" />
          </datalist>
          <p class="hint">{{ settingHint }}</p>
        </section>

        <section>
          <span class="label">Characters</span>
          <CharacterPicker
            ref="castPicker"
            :cast="node.characters"
            :roster="store.roster.value"
            @add="store.castAdd(node.id, $event)"
            @create="castCreate"
            @remove="store.castRemove(node.id, $event)"
            @note="castNote"
          />
          <p class="hint">{{ castHint }}</p>
          <button
            v-if="node.characters.length > 0"
            class="cheat-link"
            title="Every cast member's traits and relations, side by side"
            @click="emit('cheatSheet')"
          >
            Character Cheat Sheet
          </button>
        </section>
      </template>

      <template v-else>
        <section>
          <span class="label">Read</span>
          <button class="btn" title="Open the reader on this passage" @click="emit('play', node.id)">
            Play from here
          </button>
          <p class="hint">
            Starts with every variable unset, because nothing before this passage has run. A
            condition that depends on an earlier <code>(set:)</code> will not fire, and the
            reader says so while the session is open.
          </p>
        </section>

        <section>
          <span class="label">Level</span>
          <div class="level">
            <div class="level-now">
              <strong>Level {{ geom.level }}</strong>
              <span class="muted">{{ pushedDown ? 'nudged down' : 'auto' }}</span>
            </div>
            <div class="level-btns">
              <button
                class="btn btn-icon"
                :disabled="!pushedDown"
                :title="
                  pushedDown
                    ? `Return to level ${geom.minLevel}`
                    : upBlockedBy
                      ? `Blocked by “${nodeLabel(upBlockedBy.code, upBlockedBy.title)}” at level ${upBlockedBy.level}`
                      : 'Already at the earliest possible level'
                "
                @click="setOffset(0)"
              >
                &uarr;
              </button>
              <button
                class="btn btn-icon"
                :disabled="pushedDown"
                :title="`Push down to level ${geom.minLevel + 1}`"
                @click="setOffset(1)"
              >
                &darr;
              </button>
            </div>
          </div>
          <p class="hint">
            <template v-if="pushedDown">
              Sitting one level below its natural spot ({{ geom.minLevel }}).
            </template>
            <template v-else-if="upBlockedBy">
              Can&rsquo;t move up: &ldquo;{{ nodeLabel(upBlockedBy.code, upBlockedBy.title) }}&rdquo; links here from level
              {{ upBlockedBy.level }}.
            </template>
            <template v-else>
              Levels come from your links, not from dragging &mdash; a passage sits one level below
              the deepest passage that links to it.
            </template>
          </p>
        </section>

        <section>
          <label class="pref">
            <input
              type="checkbox"
              :checked="node.isEnding"
              @change="store.endingSet(node.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="text">
              Mark as Ending
              <span class="hint">
                Routes stop here. The card gets a teal underline and an END flag, and Story Stats
                counts how many routes reach it.
              </span>
            </span>
          </label>
          <p v-if="node.isEnding && endingHasLinks" class="hint hint-warn">
            Links still lead out of this passage. Nothing past it is reachable any more.
          </p>
        </section>

        <!-- A plain field, not a disclosure. It sat behind one while it shared a
             column with the body editor and everything else; on a tab of its own
             there is nothing to save it from. That also retires the rule the
             disclosure needed — a refusal can no longer be swallowed by a
             collapsed section, because the field it belongs to is always on
             screen whenever it can be produced. -->
        <section>
          <label class="label" for="passage-code">Code</label>
          <input
            id="passage-code"
            v-model="codeDraft"
            class="field"
            :class="{ 'field-error': codeError }"
            @blur="commitCode"
            @keydown.enter.prevent="commitCode"
            @keydown.esc="revertCode"
          />
          <p v-if="codeError" class="hint hint-error">{{ codeError }}</p>
          <p v-else class="hint">
            What links point at, unique across the story and case-sensitive. Changing it
            updates every <code>[[link]]</code> pointing here. Most stories never need to
            &mdash; it is set for you. Codes are also what a reader&rsquo;s story code is
            made of: the ones they visited, in order.
          </p>
        </section>

        <section>
          <label class="label" for="passage-slug">Slug</label>
          <input
            id="passage-slug"
            v-model="slugDraft"
            class="field"
            placeholder="Optional"
            @blur="commitSlug"
            @keydown.enter.prevent="commitSlug"
          />
          <p class="hint">
            <!-- No `maxlength`: the DOM counts UTF-16 units, so it would stop an
                 author at five emoji rather than ten characters and let a typed
                 `*` eat a slot before it is stripped. `normalizeSlug` counts
                 code points and is the one authority on the cap. -->
            At most {{ SLUG_MAX }} characters. A mark for this passage in a shareable route code. On its own it means nothing:
            what a reader quotes is the marks along their route, run together &mdash;
            <code>A</code> then <code>B</code> then <code>D</code> reads <code>ABD</code>.
            Slugs need not be unique, and most passages want none.
          </p>
          <p class="hint">
            Brackets group part of a mark, and the parts are compared on their own:
            two branches marked <code>A(a)</code> and <code>A(b)</code> meet as
            <code>A(*)</code> rather than losing the <code>A</code> as well.
          </p>
          <p class="hint">
            <code>*</code> is reserved: it is what the card shows where the routes here
            disagree, so it is dropped from anything you type.
          </p>
          <div class="readout">
            <span class="muted">Route here</span>
            <template v-if="runningSlug">
              <strong class="mono">{{ runningSlug }}</strong>
              <span v-if="!runOnCard" class="sub">
                Not on the card: nothing from here on carries a slug, so the code is
                finished and the canvas stops repeating it.
              </span>
            </template>
            <span v-else-if="runningSlug === ''" class="sub">
              Nothing on the route here carries a slug yet.
            </span>
            <span v-else class="sub">No route from the start reaches this passage.</span>
          </div>
        </section>

        <section>
          <label class="label" for="passage-note">Note</label>
          <!-- A textarea, and deliberately no `.enter.prevent`: on a one-line
               input that key meant "done", here it would swallow the newline
               the author is trying to type. Blur still commits, and so does
               leaving the tab. -->
          <textarea
            id="passage-note"
            v-model="noteDraft"
            class="field pad"
            spellcheck="true"
            placeholder="What this scene is for, what you still owe it, anything you want to find it by later."
            @blur="commitNote"
          />
          <p class="hint">
            A note to yourself, as long as you like. The search box looks at it; nothing else
            does. Notes may repeat, may be blank, and never affect links, levels or export.
          </p>
        </section>

        <section>
          <span class="label">Metrics</span>
          <div class="stats">
            <div class="stat">
              <span class="muted">Routes from here</span>
              <strong>{{ pathCount }}</strong>
            </div>
            <div class="stat">
              <span class="muted">Routes leading here</span>
              <strong>{{ routesInCount }}</strong>
              <span v-if="coverageLabel !== null" class="sub">
                on {{ coverageLabel }}% of all routes
              </span>
            </div>
            <div class="stat">
              <span class="muted">Links out</span>
              <strong>{{ linksOut }}</strong>
            </div>
            <div class="stat">
              <span class="muted">Links in</span>
              <strong>{{ linksIn }}</strong>
            </div>
            <div class="stat">
              <span class="muted">Order on level</span>
              <strong>{{ geom.order + 1 }}</strong>
            </div>
          </div>

          <!-- The one home for what the macros say about arriving here. It read
               on the Note field too until the two wordings started to differ;
               one inference stated two ways is one of them going stale. -->
          <p v-if="unreached" class="hint hint-warn">
            No route from the start reaches this passage. Nothing links here, or everything
            that does sits behind an Ending.
          </p>
          <p v-else-if="inferred.dead" class="hint hint-warn">
            Nothing reaches this passage: no route satisfies the condition on the links
            that point here. Check the spelling of the value against the
            <code>(set:)</code> that should supply it.
          </p>
          <p v-else-if="inferred.gate" class="hint">
            Every route here passes
            <button class="jump" @click="emit('open', inferred.gate.id)">
              {{ nodeLabel(inferred.gate.code, inferred.gate.title) }}
            </button>
            &mdash; read from the <code>(if:)</code> on the links that point here, which no
            other passage can satisfy.
          </p>
          <p class="hint">
            A route runs from the start until nothing leads on &mdash; a dead end, or an
            Ending you marked. Links are what you wrote, counted as written, so the two
            disagree wherever a link loops back or leaves an Ending.
          </p>
        </section>
      </template>
    </div>

    <footer>
      <button
        class="btn"
        :disabled="isStart"
        :title="isStart ? 'Route counts are measured from here' : 'Measure route counts from this passage'"
        @click="store.makeStart(node.id)"
      >
        {{ isStart ? 'This is the start' : 'Make start' }}
      </button>
      <button
        class="btn"
        title="Create a passage and link to it from this one"
        @click="store.addPassage(node.id)"
      >
        Add linked
      </button>
      <button
        class="btn danger"
        title="Delete this passage. Links to it are left in place as broken links."
        @click="store.removePassage(node.id)"
      >
        Delete
      </button>
    </footer>

    <BodyDialog
      v-if="expanded"
      :model-value="body"
      :label="nodeLabel(node.code, node.title)"
      :targets="targets"
      @update:model-value="onBodyInput"
      @settle="settleBody"
      @close="expanded = false"
    />
  </aside>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-w);
  flex: 0 0 var(--sidebar-w);
  border-left: 1px solid var(--border);
  background: var(--panel-alt);
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--toolbar-h);
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

/* Reuses `.seg`, the way RecodePanel's mode switch does. `--state` is set on
   the container rather than by a `state-*` class on each button, which is what
   lets `.seg.on` paint without borrowing the State control's colour vocabulary;
   scoping it to `.tabs` leaves the State segmented control below to keep its own
   per-button `--state`. */
.tabs {
  display: flex;
  flex: 0 0 auto;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}

.tabs .segmented {
  --state: var(--accent);
  flex: 1;
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* A flex column that scrolls will happily hand an item less height than its
   content needs, and the overflow then paints over the next section rather than
   pushing it down. Pinning shrink to 0 makes every section keep its own height
   and lets `.scroll` do the scrolling, which is its job. */
.scroll > section {
  flex: 0 0 auto;
}

section.grow {
  flex: 1 0 auto;
  min-height: 220px;
  display: flex;
  flex-direction: column;
}

.body-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.body-head .label {
  margin-bottom: 0;
}

.expand {
  padding: 2px 6px;
  border: 0;
  border-radius: 4px;
  background: none;
  font-size: 11px;
  color: var(--text-dim);
}

.expand:hover {
  background: var(--bg);
  color: var(--accent);
}

/* `.link` is scoped to CharacterPicker rather than global, so this repeats it
   rather than reaching for a class that does not exist here. */
.cheat-link {
  margin-top: 6px;
  padding: 0;
  border: 0;
  background: none;
  font-size: 11px;
  color: var(--accent);
}

.cheat-link:hover {
  text-decoration: underline;
}

/* Sits between the label and the editor, so it needs the spacing inverted. */
.hint.above {
  margin-top: 5px;
  margin-bottom: 6px;
}

.muted {
  color: var(--text-faint);
  font-weight: 400;
}

code {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 1px 3px;
  border-radius: 3px;
  background: var(--bg);
}

.segmented {
  display: flex;
  gap: 4px;
}

.seg {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  font-size: 12px;
}

.seg .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--state);
}

.seg .note-dot {
  background: var(--note);
}

.seg.on {
  border-color: var(--state);
  background: color-mix(in srgb, var(--state) 14%, transparent);
  font-weight: 600;
}

.level {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}

.level-now {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.level-btns {
  display: flex;
  gap: 4px;
}

.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  font-size: 11px;
}

/* Five tiles in two columns leave the last one alone on its row; spanning it
   reads as the layout meaning it rather than running out. */
.stat:last-child:nth-child(odd) {
  grid-column: 1 / -1;
}

.stat strong {
  font-size: 15px;
}

/* The card shows the tail of this; here it wraps and shows all of it, however
   long the story makes it. */
/* Prose, so it gets room to be prose. Fixed rather than `flex: 1`, because the
   sections on this tab are `flex: 0 0 auto` and one of them growing would take
   the scroll away from the rest. */
.pad {
  min-height: 120px;
  resize: vertical;
  line-height: 1.5;
}

.readout {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.readout .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.readout .sub,
.stat .sub {
  font-size: 10px;
  line-height: 1.3;
  color: var(--text-faint);
}

/* A jump inside running prose, so it is styled as a link rather than a control
   — same treatment as `.cheat-link` above, which is the other one of these. */
.jump {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
}

.jump:hover {
  text-decoration: underline;
}

footer {
  display: flex;
  gap: 6px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}

footer .btn {
  flex: 1;
}

.danger:hover:not(:disabled) {
  border-color: var(--todo);
  color: var(--todo);
}

.picked {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.picked li {
  display: flex;
  align-items: center;
  gap: 4px;
}

.row {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  padding: 4px 6px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.row:hover {
  background: var(--panel);
}

.confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
  padding: 7px 8px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--todo) 12%, transparent);
  font-size: 11px;
}

.confirm span {
  flex: 1;
}

/* Copied from EditorSettings, which owns the only other checkbox in the app.
   Scoped styles mean the rules cannot be shared; keeping them identical is what
   makes the two read as the same control. */
.pref {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}

.pref input {
  width: 15px;
  height: 15px;
  margin: 1px 0 0;
  accent-color: var(--accent);
  flex: 0 0 auto;
  cursor: pointer;
}

.pref .text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
