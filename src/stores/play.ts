/**
 * A playthrough session: the reader walking the draft, a passage at a time.
 *
 * Deliberately **not** part of `story.ts`. That module owns the document and its
 * undo history, and a reading session is ephemeral, never persisted, and must
 * never reach `commit`. Its own module makes `layoutKey`, `layoutVersion` and
 * the undo stack structurally untouchable from here, which is the direct
 * defence of invariant 1: the document is the only persisted state. This file
 * imports `story.ts` read-only, for the document and the layout it already
 * computed.
 *
 * Nothing here writes localStorage either. A "last read position" would be
 * persisted state living outside `StoryDoc`, which is the same invariant from
 * the other side.
 *
 * The reader **follows self-links and back edges**, because a reader really can
 * loop. That is why neither this nor `run.ts` imports `paths.ts`, whose
 * `forwardTargets` answers a different question — which edges a *route* can take
 * when counting them, where revisiting a passage would make the count infinite.
 */

import { computed, reactive, watch } from 'vue'
import type { RunChoice, RunResult, Vars } from '../lib/harlowe/run'
import { renderPassage } from '../lib/harlowe/run'
import type { NodeId, StoryNode } from '../types/story'
import { doc } from './story'

/** One passage on the stack, with what the reader carried into it. */
interface Step {
  nodeId: NodeId
  /**
   * The variables as they stood on *entering*, copied.
   *
   * This is what makes Back exact and O(1): popping restores the state the
   * reader actually had, even when the route looped through a `(set:)` twice.
   * Recomputing forward from the start would also be exact and costs O(depth)
   * per press, with the loop cases to get wrong.
   */
  varsBefore: Vars
  /** Which passage set each variable, by code, as of entering. */
  setterBefore: ReadonlyMap<string, string>
  /** The choice taken to leave, or null while this is the top of the stack. */
  ordinal: number | null
}

interface PlayState {
  stack: Step[]
  open: boolean
  /** Why the session ended or could not start, for the panel to show. */
  notice: string | null
  /** Started somewhere other than the story's first passage. */
  midStory: boolean
}

const state = reactive<PlayState>({ stack: [], open: false, notice: null, midStory: false })

/** A choice as the reader meets it: where it goes, and whether it can be taken. */
export interface PlayChoice extends RunChoice {
  /** The passage this leads to, or null when no passage carries that code. */
  node: StoryNode | null
  /**
   * Why this choice cannot be taken.
   *
   * `ending` is the reader agreeing with `countPaths`, which treats an authored
   * ending as a leaf *before* expanding its out-edges — and with the inspector's
   * own warning about an ending that still links out. `phantom` is a link whose
   * target nobody has written; the reader offers no way to create it, because a
   * reading session must not commit a mutation.
   */
  blocked: 'phantom' | 'ending' | null
}

export interface PlayView {
  node: StoryNode
  result: RunResult
  choices: PlayChoice[]
  /** True when nothing leads on and the author has not called this an ending. */
  unwritten: boolean
}

function nodeById(id: NodeId): StoryNode | null {
  return doc.value.nodes.find((n) => n.id === id) ?? null
}

function byCode(): Map<string, StoryNode> {
  return new Map(doc.value.nodes.map((n) => [n.code, n]))
}

export const playOpen = computed(() => state.open)
export const playNotice = computed(() => state.notice)
export const playMidStory = computed(() => state.midStory)
export const playDepth = computed(() => state.stack.length)
export const canPlayBack = computed(() => state.stack.length > 1)

export const playStep = computed<PlayView | null>(() => {
  const top = state.stack[state.stack.length - 1]
  if (!top) return null
  const node = nodeById(top.nodeId)
  if (!node) return null

  const result = renderPassage(node.body, top.varsBefore)
  const codes = byCode()
  const choices: PlayChoice[] = result.choices.map((choice) => {
    const target = codes.get(choice.target) ?? null
    return {
      ...choice,
      node: target,
      blocked: node.isEnding ? 'ending' : target === null ? 'phantom' : null,
    }
  })
  return { node, result, choices, unwritten: choices.length === 0 && !node.isEnding }
})

/**
 * The route so far, as invariant 3 defines it: the ordered codes of the passages
 * visited, `P1->P3->P7`.
 *
 * Nearly free, because the stack *is* the codes. It is also what #11 consumes
 * from the other direction, so a session produces exactly what a replay reads.
 */
export const playRoute = computed(() =>
  state.stack
    .map((step) => nodeById(step.nodeId)?.code ?? '?')
    .join('->'),
)

/** Every variable the reader now holds, with the passage that last set it. */
export const playVars = computed<{ name: string; value: string | null; setBy: string }[]>(() => {
  const view = playStep.value
  const top = state.stack[state.stack.length - 1]
  if (!view || !top) return []
  const here = view.node.code
  const wrote = new Set(view.result.assigned.map((a) => a.variable))
  return [...view.result.vars]
    .map(([name, value]) => ({
      name,
      value,
      setBy: wrote.has(name) ? here : (top.setterBefore.get(name) ?? here),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
})

function push(nodeId: NodeId, varsBefore: Vars, setterBefore: ReadonlyMap<string, string>): void {
  state.stack.push({ nodeId, varsBefore: new Map(varsBefore), setterBefore, ordinal: null })
}

/**
 * Begin reading, from `nodeId` or from the story's first passage.
 *
 * Starting mid-story is offered on purpose — it is how an author checks one
 * branch without walking to it — but it arrives with nothing set, so the panel
 * says so. Without that note an `(if:)` silently fails and the reader states
 * something false about the passage.
 */
export function playStart(nodeId?: NodeId): void {
  const start = nodeId ?? doc.value.startNodeId
  state.stack = []
  state.notice = null
  state.midStory = start !== null && start !== doc.value.startNodeId
  state.open = true

  if (start === null || nodeById(start) === null) {
    state.notice = 'This story has no first passage yet. Mark one as the start to read it.'
    return
  }
  push(start, new Map(), new Map())
}

/** Take a choice, carrying the variables this passage leaves behind. */
export function playChoose(ordinal: number): void {
  const view = playStep.value
  const top = state.stack[state.stack.length - 1]
  if (!view || !top) return
  const choice = view.choices.find((c) => c.ordinal === ordinal)
  if (!choice || choice.blocked !== null || choice.node === null) return

  const here = view.node.code
  const setter = new Map(top.setterBefore)
  for (const written of view.result.assigned) setter.set(written.variable, here)

  top.ordinal = ordinal
  push(choice.node.id, view.result.vars, setter)
}

/** Back one choice, restoring exactly what the reader held there. */
export function playBack(): void {
  if (state.stack.length < 2) return
  state.stack.pop()
  const top = state.stack[state.stack.length - 1]
  if (top) top.ordinal = null
}

/** Back to the first passage of this session, keeping the session open. */
export function playRestart(): void {
  const first = state.stack[0]
  if (!first) return
  state.stack = [{ ...first, varsBefore: new Map(), ordinal: null }]
  state.notice = null
}

export function playClose(): void {
  state.open = false
}

/**
 * Clear the session entirely.
 *
 * Not optional, and not only for tidiness: this module is a singleton, so
 * `render.test.ts`'s `beforeEach` has to reset it the way it already resets the
 * store and the preferences. Without it one test that opens the reader leaves a
 * full-screen veil mounted over every test after it in that file, and since it
 * asserts on `host.textContent` and fails on any Vue warning, the failures land
 * a long way from the cause.
 */
export function resetPlay(): void {
  state.stack = []
  state.open = false
  state.notice = null
  state.midStory = false
}

/**
 * The document can change under an open reader — an undo, a recode, a delete.
 *
 * Watching the document itself rather than any derived value keeps this cheap;
 * the session only cares whether the passage it is showing still exists. Left
 * unhandled, the panel renders against a missing node and jsdom fills with Vue
 * warnings that `render.test.ts` fails on.
 */
watch(
  doc,
  () => {
    if (!state.open || state.stack.length === 0) return
    const top = state.stack[state.stack.length - 1]!
    if (nodeById(top.nodeId) !== null) return
    state.stack = []
    state.notice = 'The passage being read was removed, so the session ended.'
  },
  // Synchronously, for the reason `setDoc` recomputes layout synchronously: a
  // watcher that flushes a tick late leaves the panel describing the previous
  // document for that tick.
  { flush: 'sync' },
)

export { state }
