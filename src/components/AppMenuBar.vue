<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  chordLabel,
  commandById,
  commandsIn,
  GROUP_LABELS,
  GROUPS,
  type CommandBinding,
  type CommandGroup,
  type CommandSpec,
} from '../lib/ui/commands'

/**
 * The OS-style menu bar.
 *
 * It holds the long tail so the bar stops being the place every new feature
 * lands one more button, and it is where a shortcut becomes discoverable: the
 * chord sits beside the command it runs, which is how anyone learns one.
 *
 * It renders `COMMANDS` and knows nothing else about them. Whoever mounts it
 * supplies a binding per id — `run`, and whether the command is enabled or
 * ticked — because those read panel flags this component has no business
 * seeing.
 */

const props = defineProps<{ bindings: Record<string, CommandBinding> }>()

/**
 * The open menu is reported upward because the shortcut layer has to stand
 * down while one is up. An open menu puts focus on a `<button>`, so `isTyping`
 * is false and `modalOpen` is false, and without the guard a press of `n`
 * would create a passage behind the panel.
 */
const emit = defineEmits<{ openChange: [boolean] }>()

const open = ref<CommandGroup | null>(null)
const bar = ref<HTMLElement | null>(null)

/**
 * The menu the pointer just moved onto while another was open.
 *
 * Hovering a sibling switches to it, so by the time the click lands that menu
 * is already the open one — and a plain toggle would read the click as "close
 * the thing you are pointing at". Clicking a title you browsed onto keeps it
 * up, the way a desktop menu bar does; clicking it a second time closes it.
 */
const switchedTo = ref<CommandGroup | null>(null)

watch(open, (g) => emit('openChange', g !== null))

/**
 * Absent means shown, matching how an absent `enabled` means enabled — and a
 * command with no binding at all stays visible, so an unbound row is still
 * drawn (dimmed) for `render.test.ts` to catch rather than quietly vanishing.
 */
function isVisible(id: string): boolean {
  return props.bindings[id]?.visible !== false
}

/** Only the groups that actually hold something, so an empty menu never shows. */
const groups = computed(() =>
  GROUPS.filter((g) => commandsIn(g).some((c) => isVisible(c.id))),
)

type Row = { kind: 'divider' } | { kind: 'item'; id: string }

/**
 * The rows of the open menu, with a divider wherever the section changes.
 *
 * Hidden rows are filtered out *before* the loop rather than skipped inside it,
 * and that is what keeps the dividers right: a section whose rows are all
 * hidden disappears along with its divider, and no leading or doubled divider
 * can appear. Skipping inside would still advance `section` and emit both.
 */
const rows = computed<Row[]>(() => {
  if (open.value === null) return []
  const items: Row[] = []
  let section: number | undefined
  for (const c of commandsIn(open.value).filter((c) => isVisible(c.id))) {
    if (section !== undefined && c.section !== section) items.push({ kind: 'divider' })
    section = c.section
    items.push({ kind: 'item', id: c.id })
  }
  return items
})

function specOf(id: string): CommandSpec | undefined {
  return commandById(id)
}

function bindingOf(id: string): CommandBinding | undefined {
  return props.bindings[id]
}

function isEnabled(id: string): boolean {
  const b = bindingOf(id)
  return b !== undefined && b.enabled !== false
}

function labelFor(id: string): string {
  return specOf(id)?.label ?? id
}

function chordFor(id: string): string | null {
  const c = specOf(id)?.chord
  return c ? chordLabel(c) : null
}

function hintFor(id: string): string | undefined {
  return specOf(id)?.hint
}

function isToggle(id: string): boolean {
  return specOf(id)?.toggle === true
}

function isChecked(id: string): boolean {
  return bindingOf(id)?.checked === true
}

/** Every focusable row of the open panel, in visual order. */
function itemEls(): HTMLButtonElement[] {
  // Found by class rather than a template ref: a `ref` inside `v-for` collects
  // into an array, and only one panel is ever open.
  const el = bar.value?.querySelector('.menu-panel')
  if (!el) return []
  return Array.from(el.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)'))
}

function focusItem(i: number) {
  const els = itemEls()
  if (els.length === 0) return
  const wrapped = (i + els.length) % els.length
  els[wrapped]?.focus()
}

function titleEl(g: CommandGroup): HTMLButtonElement | null {
  return bar.value?.querySelector<HTMLButtonElement>(`[data-group="${g}"]`) ?? null
}

async function openMenu(g: CommandGroup, focusFirst = false) {
  open.value = g
  await nextTick()
  // Safari and Firefox on macOS do not focus a `<button>` when it is clicked,
  // so a menu opened with the mouse would leave focus on `<body>`. The key
  // handler below is on `document` for the same reason, but the title still
  // takes focus so the arrows have somewhere to start and Escape can hand it
  // back.
  if (focusFirst) focusItem(0)
  else titleEl(g)?.focus()
}

function close(returnFocus = false) {
  const was = open.value
  open.value = null
  switchedTo.value = null
  if (returnFocus && was) titleEl(was)?.focus()
}

function onTitleClick(g: CommandGroup) {
  if (switchedTo.value === g) {
    switchedTo.value = null
    return
  }
  if (open.value === g) close(true)
  else void openMenu(g)
}

/**
 * Hovering a sibling while a menu is up switches to it, which is what every
 * desktop menu bar does and the only way to browse them without clicking each.
 */
function onTitleEnter(g: CommandGroup) {
  if (open.value === null || open.value === g) return
  open.value = g
  switchedTo.value = g
}

function run(id: string) {
  if (!isEnabled(id)) return
  close()
  bindingOf(id)?.run()
}

function step(delta: number) {
  const els = itemEls()
  const at = els.indexOf(document.activeElement as HTMLButtonElement)
  focusItem(at === -1 ? (delta > 0 ? 0 : -1) : at + delta)
}

function sibling(delta: number) {
  if (open.value === null) return
  const gs = groups.value
  const at = gs.indexOf(open.value)
  const next = gs[(at + delta + gs.length) % gs.length]
  void openMenu(next, true)
}

/**
 * Keys are handled on `document` rather than on the nav, because focus is not
 * reliably inside it — Safari and Firefox do not focus a clicked button — and a
 * handler bound to the bar would then never hear Escape. The shortcut layer is
 * still untouched: none of Escape, the arrows or Enter mean anything to it.
 *
 * Anything else closes the menu and is left to travel on. That is what keeps
 * ⌘P from opening a Play tab while a panel is still up, without teaching the
 * `mod` branch about menus.
 */
function onKeyDown(e: KeyboardEvent) {
  if (open.value === null) return
  switch (e.key) {
    case 'Escape':
      e.preventDefault()
      close(true)
      return
    case 'ArrowDown':
      e.preventDefault()
      step(1)
      return
    case 'ArrowUp':
      e.preventDefault()
      step(-1)
      return
    case 'ArrowRight':
      e.preventDefault()
      sibling(1)
      return
    case 'ArrowLeft':
      e.preventDefault()
      sibling(-1)
      return
    case 'Enter':
    case ' ':
      // The focused button fires it; closing here would beat the click.
      return
    case 'Tab':
      close()
      return
    // Every chord starts with one of these arriving on its own. Closing on them
    // would dismiss the menu before the second key was even pressed — reaching
    // for ⌘Z, or just holding Shift to read a row, would make it vanish.
    case 'Shift':
    case 'Meta':
    case 'Control':
    case 'Alt':
      return
    default:
      close()
  }
}

/**
 * Outside clicks need a real document listener: the pickers elsewhere close on
 * `@blur` of a focused text input, and a menu title has no field to blur.
 */
function onPointerDown(e: PointerEvent) {
  if (open.value === null) return
  if (bar.value?.contains(e.target as Node)) return
  close()
}

watch(open, (g) => {
  if (g !== null) {
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
  } else {
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeyDown)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown)
  document.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <nav ref="bar" class="menubar">
    <div v-for="g in groups" :key="g" class="slot">
      <button
        class="title"
        :class="{ on: open === g }"
        :data-group="g"
        type="button"
        aria-haspopup="menu"
        :aria-expanded="open === g"
        @click="onTitleClick(g)"
        @mouseenter="onTitleEnter(g)"
      >
        {{ GROUP_LABELS[g] }}
      </button>

      <div
        v-if="open === g"
        class="menu-panel"
        role="menu"
        :aria-label="GROUP_LABELS[g]"
      >
        <template v-for="(row, i) in rows" :key="i">
          <div v-if="row.kind === 'divider'" class="menu-divider" />
          <button
            v-else
            class="menu-item"
            type="button"
            role="menuitem"
            :disabled="!isEnabled(row.id)"
            :title="hintFor(row.id)"
            @click="run(row.id)"
          >
            <span v-if="isToggle(row.id)" class="menu-check">{{
              isChecked(row.id) ? '✓' : ''
            }}</span>
            <span class="menu-label">{{ labelFor(row.id) }}</span>
            <span v-if="chordFor(row.id)" class="menu-chord">{{ chordFor(row.id) }}</span>
          </button>
        </template>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.menubar {
  display: flex;
  gap: 1px;
  flex: 0 0 auto;
}

/* Anchors the panel. The toolbar's `overflow-x` is gone precisely so this can
   hang below the bar instead of being clipped by it. */
.slot {
  position: relative;
}

.title {
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--text);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}

.title:hover,
.title:focus-visible {
  background: var(--panel-alt);
  outline: none;
}

.title.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.menu-panel {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
}
</style>
