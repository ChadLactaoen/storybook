import type { Guard } from '../harlowe/macros'
import type { NodeId } from '../../types/story'
import type { DerivedGraph, EdgeId } from './types'

/**
 * Work out, for each passage, which earlier passage every route to it must have
 * passed through — its *gate*.
 *
 * `deriveGraph` reads `[[...]]` and nothing else, so a link gated by
 * `(if: $v is "x")` looks unconditional and the graph over-reports what is
 * reachable. `macros.ts` reads those conditions out of the prose (never
 * executing them); this turns them into a claim about routes: if every way into
 * a passage needs `$v` to be `"x"`, and exactly one passage assigns that, then
 * every reader who arrives has been through it.
 *
 * The same reading proves the opposite case too. When *nothing* assigns the
 * value a condition tests, no reader can ever take those links — a dead branch,
 * usually a mistyped literal, which nothing else in the tool would catch.
 *
 * Five conditions hold the inference up, and **every one of them fails closed**:
 * no gate, which is what the tool said before it could read macros at all. That
 * asymmetry is the design. A missing gate costs nothing but precision; a wrong
 * one states something false about the story.
 */

export interface GateEntry {
  /**
   * The passage every route here provably passes, or null when nothing could be
   * proven.
   *
   * Surfaced in the inspector rather than acted on quietly: the author never
   * asked for this inference and cannot see it in the body text.
   */
  gateId: NodeId | null
  /** No route can satisfy the condition on the links in. A dead branch. */
  dead: boolean
}

export interface GateInput {
  backEdges: ReadonlySet<EdgeId>
  levelOf: ReadonlyMap<NodeId, number>
  /** Guard per edge, as `readStoryMacros` keys them. */
  guardOf?: ReadonlyMap<EdgeId, Guard>
  assignersOf?: ReadonlyMap<string, readonly { nodeId: NodeId; value: string }[]>
  /** Variables written by something the macro parser could not read. */
  opaqueVars?: ReadonlySet<string>
  /** Whether `nodeId` is a forward descendant of `gateId`. */
  isAncestor?: (gateId: NodeId, nodeId: NodeId) => boolean
}

/**
 * Gates for every node in `g`, real and phantom.
 *
 * Pure over the derived graph, like `countPaths` and `reachable` — levels and
 * macro readings are passed in rather than recomputed, so the store can hand
 * over what the layout already worked out.
 */
export function gatesOf(g: DerivedGraph, input: GateInput): Map<NodeId, GateEntry> {
  const { backEdges, levelOf, guardOf, assignersOf, opaqueVars, isAncestor } = input

  function gateOf(id: NodeId): GateEntry {
    const none: GateEntry = { gateId: null, dead: false }
    if (!guardOf || !assignersOf) return none

    // 1. Every inbound edge carries the same guard. One unguarded edge and
    //    there is a route here that never needed the variable at all.
    //
    //    Back edges count. They are a layering artefact — which edge a DFS
    //    calls "back" depends on where it started — not a statement about what
    //    a reader can do, so a passage whose only unguarded way in happens to
    //    be classified as one is still reachable without the gate. Anything
    //    looped into simply gets no gate, which costs precision and nothing
    //    else. Self-loops are the exception: arriving at a passage from itself
    //    means you were already there, so it adds no route.
    let guard: Guard | null = null
    let edges = 0
    for (const eid of g.inAdj.get(id) ?? []) {
      const e = g.edgeById.get(eid)!
      if (e.selfLoop) continue
      if (backEdges.has(eid)) return none
      edges++
      const seen = guardOf.get(eid)
      if (!seen) return none
      if (guard === null) guard = seen
      else if (guard.variable !== seen.variable || guard.value !== seen.value) return none
    }
    if (edges === 0 || guard === null) return none

    // 2. Nothing writes the variable in a way the parser could not read. This is
    //    the condition with no other backstop: miss one write and a route exists
    //    that never passed the gate, while this claims it did.
    if (opaqueVars?.has(guard.variable)) return none

    const assigners = assignersOf.get(guard.variable) ?? []

    // 3. Exactly one passage gives the variable this value. Deduped by id,
    //    because a body may assign the same thing twice.
    const setters = [
      ...new Set(assigners.filter((a) => a.value === guard.value).map((a) => a.nodeId)),
    ]
    // Nothing gives it that value, and the variable is readable everywhere it
    // is written — so no reader can ever take these links. Proven dead, which
    // is a stronger statement than "no gate" and worth saying out loud.
    if (setters.length === 0) return { gateId: null, dead: true }
    if (setters.length > 1) return none
    const gate = setters[0]!

    const gateLevel = levelOf.get(gate) ?? 1
    if (gateLevel >= (levelOf.get(id) ?? 1)) return none

    // 4. Nothing reassigns the variable between the gate and here. Levels prove
    //    it without a reachability query: forward levels increase strictly, so
    //    any passage on a route below the gate sits at a greater level.
    for (const a of assigners) {
      if ((levelOf.get(a.nodeId) ?? 1) > gateLevel) return none
    }

    // 5. The gate is actually an ancestor. Without this a disconnected island
    //    holding the only setter would be named as the gate for a passage no
    //    route from it ever reaches.
    if (isAncestor && !isAncestor(gate, id)) return none

    return { gateId: gate, dead: false }
  }

  // `g.ids` rather than a Map's keys: canonical order in, canonical order out.
  const out = new Map<NodeId, GateEntry>()
  for (const id of g.ids) out.set(id, gateOf(id))
  return out
}
