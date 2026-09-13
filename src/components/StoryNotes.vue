<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import * as store from '../stores/story'

/**
 * A scratchpad for the story as a whole — where it is going, what still needs
 * fixing, names the author keeps forgetting.
 *
 * Plain text on purpose: no Harlowe highlighting and no formatting row. None of
 * this is ever a passage, so none of it is parsed for links or exported as
 * prose, and dressing it up like a body would promise otherwise.
 *
 * Bound straight to the document with no local draft, exactly as the body
 * editor is. `notes` is in no analysis and in no `layoutKey`, so a keystroke
 * here reaches no layout, graph or macro work — and Cmd J can close the panel
 * mid-sentence without dropping text that a blur-committed draft would still
 * be holding, since a removed element never fires `blur`.
 */

const emit = defineEmits<{ close: [] }>()

const pad = ref<HTMLTextAreaElement | null>(null)

const notes = computed({
  get: () => store.state.doc.notes,
  set: (v: string) => store.storyNotesSet(v),
})

// Opened to write in, not to look at. `BodyDialog` focuses its editor the same
// way, and the veil is inset past this panel, so taking focus from an expanded
// editor is exactly what Cmd J was pressed for.
onMounted(() => pad.value?.focus())
</script>

<template>
  <aside class="notes">
    <header>
      <span class="eyebrow">Story notes</span>
      <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
    </header>

    <textarea
      ref="pad"
      v-model="notes"
      class="field pad"
      spellcheck="true"
      aria-label="Story notes"
      placeholder="Anything that isn't a passage — where this is going, what still needs fixing, names you keep forgetting."
    />
  </aside>
</template>

<style scoped>
/* Width and the gutter's right edge belong to .left-gutter in App.vue. This
   panel only says how it fills the share of height it is handed. */
.notes {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
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

/* Fills the panel rather than growing with the prose: this is a share of a
   column, and a self-sizing field would take that share from whatever is
   stacked above it. `height: auto` undoes `.field`'s fixed 30px. */
.pad {
  flex: 1;
  width: auto;
  height: auto;
  min-height: 0;
  margin: 14px;
  padding: 9px;
  line-height: 1.55;
  resize: none;
  overflow-y: auto;
}
</style>
