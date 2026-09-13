<script setup lang="ts">
import { computed, ref } from 'vue'
import * as store from '../stores/story'
import type { NodeState } from '../types/story'
import { NODE_STATES } from '../types/story'

const input = ref<HTMLInputElement | null>(null)

const matchCount = computed(() => store.matches.value?.size ?? null)

function toggleTag(tag: string) {
  store.toggleFilter('tagFilter', tag)
}

function toggleState(s: NodeState) {
  const list = store.state.stateFilter
  const i = list.indexOf(s)
  if (i === -1) list.push(s)
  else list.splice(i, 1)
}

const clear = store.clearFilters

// Shared with the index panel, which can filter by setting and character too.
const active = store.filtering

/** Filters set from the index panel, shown here so every filter has one home. */
const sceneChips = computed(() => [
  ...store.state.settingFilter.map((value) => ({ kind: 'settingFilter' as const, value })),
  ...store.state.characterFilter.map((value) => ({ kind: 'characterFilter' as const, value })),
])

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div class="bar">
    <input
      ref="input"
      v-model="store.state.search"
      class="field search"
      type="search"
      placeholder="Search titles, notes, codes and prose…  (Cmd F)"
      @keydown.esc="clear"
    />

    <div class="chips">
      <button
        v-for="s in NODE_STATES"
        :key="s"
        class="chip"
        :class="[`state-${s}`, { on: store.state.stateFilter.includes(s) }]"
        @click="toggleState(s as NodeState)"
      >
        <span class="dot" />{{ s }}
      </button>

      <span v-if="store.tags.value.length > 0" class="sep" />

      <button
        v-for="tag in store.tags.value"
        :key="tag"
        class="chip tag"
        :class="{ on: store.state.tagFilter.includes(tag) }"
        :style="{ '--chip': `var(--tag-${store.tagColors.value.get(tag) ?? 'none'})` }"
        @click="toggleTag(tag)"
      >
        {{ tag }}
      </button>

      <span v-if="sceneChips.length > 0" class="sep" />

      <button
        v-for="chip in sceneChips"
        :key="chip.kind + chip.value"
        class="chip scene on"
        :title="`Stop filtering by ${chip.value}`"
        @click="store.toggleFilter(chip.kind, chip.value)"
      >
        {{ chip.kind === 'settingFilter' ? '⌖' : '☺' }} {{ chip.value }} &times;
      </button>
    </div>

    <span v-if="matchCount !== null" class="count">
      {{ matchCount }} of {{ store.state.doc.nodes.length }}
    </span>
    <button v-if="active" class="btn btn-ghost btn-icon" title="Clear filters" @click="clear">
      &times;
    </button>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-alt);
  overflow-x: auto;
}

.search {
  width: 260px;
  flex: 0 0 auto;
  height: 26px;
}

.chips {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  font-size: 11px;
  white-space: nowrap;
}

.chip .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--state);
}

.chip.on {
  border-color: var(--state, var(--accent));
  background: color-mix(in srgb, var(--state, var(--accent)) 15%, transparent);
  font-weight: 600;
}

.chip.tag {
  --state: var(--chip);
}

.chip.scene {
  --state: var(--accent);
}

.sep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 3px;
  flex: 0 0 auto;
}

.count {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}
</style>
