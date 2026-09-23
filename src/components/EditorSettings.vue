<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { previewTheme } from '../lib/publish/publish'
import { DEFAULT_THEME, THEMES } from '../lib/publish/themes'
import type { PlayerTheme } from '../lib/publish/themes'
import { prefs, setPref } from '../stores/prefs'
import type { SwitchPref } from '../stores/prefs'

/**
 * How the editor behaves, as against what the story says.
 *
 * Titled "Editor settings" rather than "Settings" on purpose: a passage's
 * *setting* is where its scene takes place, and the index panel is already
 * called "Cast & Settings". A bare "Settings" here would read as that.
 */

const emit = defineEmits<{ close: [] }>()

const TOGGLES: { key: SwitchPref; label: string; hint: string }[] = [
  {
    key: 'inheritSetting',
    label: 'Inherit the parent passage’s Setting',
    hint: 'A new passage linked from another starts in the same place.',
  },
  {
    key: 'inheritCharacters',
    label: 'Inherit the parent passage’s Characters',
    hint: 'A new passage starts with the same cast. Scene notes are never copied.',
  },
]

/**
 * Why the last preview did not open, shown in the sheet. The notice banner
 * would be behind the veil.
 */
const previewError = ref<string | null>(null)

/**
 * Not async, and nothing awaited before `previewTheme` is called: the tab has to
 * open while this click is still being handled, or a popup blocker refuses it.
 */
function preview(theme: PlayerTheme) {
  previewError.value = null
  previewTheme(theme).catch((e: unknown) => {
    previewError.value = e instanceof Error ? e.message : 'Could not open the preview.'
  })
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <!-- One above the help panel: this is the topmost surface, and the shortcut
       guard in App keeps anything else from opening over it. -->
  <div class="veil" @click.self="emit('close')">
    <div class="sheet" role="dialog" aria-label="Editor settings">
      <header>
        <h2>Editor settings</h2>
        <button class="btn btn-ghost btn-icon" title="Close" @click="emit('close')">&times;</button>
      </header>

      <div class="scroll">
        <section>
          <h3>New passages</h3>
          <label v-for="toggle in TOGGLES" :key="toggle.key" class="pref">
            <input
              type="checkbox"
              :checked="prefs[toggle.key]"
              @change="setPref(toggle.key, ($event.target as HTMLInputElement).checked)"
            />
            <span class="text">
              {{ toggle.label }}
              <span class="hint">{{ toggle.hint }}</span>
            </span>
          </label>
          <!-- Said out loud because the alternative reading — that turning one
               on fills in the passages already written — is the natural one. -->
          <p class="hint note">
            Both apply only as a passage is created. Nothing already written is changed, and a
            passage never re-inherits when its parent does.
          </p>
        </section>

        <section>
          <h3>Canvas</h3>
          <label class="pref">
            <input
              type="checkbox"
              :checked="prefs.showCodes"
              @change="setPref('showCodes', ($event.target as HTMLInputElement).checked)"
            />
            <span class="text">
              Show codes above cards
              <span class="hint">
                A card shows your note; this puts its code in the gap above it. Codes are
                what links point at, and what a reader’s story code is made of.
              </span>
            </span>
          </label>
        </section>

        <section>
          <h3>Player</h3>
          <div class="theme-list" role="radiogroup" aria-label="Default player theme">
            <p class="hint lead">
              Default player theme: how Play and Publish show the story. A reader can still
              switch with the player’s own Aa button.
            </p>
            <div v-for="theme in THEMES" :key="theme.id" class="pref theme-row">
              <label class="theme-pick">
                <input
                  type="radio"
                  name="player-theme"
                  :value="theme.id"
                  :checked="prefs.playerTheme === theme.id"
                  @change="setPref('playerTheme', theme.id)"
                />
                <span class="text">
                  <span>
                    {{ theme.label }}
                    <span v-if="theme.id === DEFAULT_THEME" class="tag">default</span>
                  </span>
                  <span class="hint">{{ theme.blurb }}</span>
                </span>
              </label>
              <button
                class="btn btn-ghost preview"
                :title="`Open a sample passage in ${theme.label}, in a new tab`"
                @click="preview(theme.id)"
              >
                Preview
              </button>
            </div>
          </div>
          <p v-if="previewError" class="hint error" role="alert">{{ previewError }}</p>
        </section>

        <!-- Written out rather than added to `TOGGLES`, which is specifically
             the New-passages pair and renders inside that section's `v-for`. -->
        <section>
          <h3>Developer</h3>
          <label class="pref">
            <input
              type="checkbox"
              :checked="prefs.devMode"
              @change="setPref('devMode', ($event.target as HTMLInputElement).checked)"
            />
            <span class="text">
              Developer mode
              <span class="hint">
                Adds a Developer menu to the bar, for reporting how the story is
                <em>drawn</em> rather than writing it: an export of the structure with
                none of your prose in it, and a way to strip the cards down to shape and
                colour for a screenshot. Turning this off puts any of it back.
              </span>
            </span>
          </label>
        </section>
      </div>

      <footer>
        <span class="muted">Saved in this browser, not in the story file.</span>
        <button class="btn btn-primary" @click="emit('close')">Done</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.veil {
  position: fixed;
  inset: 0;
  z-index: 96;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--text) 32%, transparent);
}

.sheet {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 460px;
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
}

.pref {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 0;
  cursor: pointer;
}

.pref + .pref {
  border-top: 1px solid var(--border);
}

/* The one form control in the app that isn't a .field, so it is left native
   and simply tinted — a hand-rolled switch would be the odd one out here. */
.pref input {
  width: 15px;
  height: 15px;
  margin: 1px 0 0;
  accent-color: var(--accent);
  flex: 0 0 auto;
  cursor: pointer;
}

.text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hint {
  margin: 0;
}

/* The same gap `RecodePanel` puts between its sections. */
section + section {
  margin-top: 16px;
}

.lead {
  margin-bottom: 4px;
}

.theme-row {
  align-items: center;
  cursor: default;
}

.theme-pick {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.preview {
  flex: 0 0 auto;
}

.tag {
  margin-left: 6px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.error {
  margin-top: 8px;
  color: var(--tag-red);
}

.note {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
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
