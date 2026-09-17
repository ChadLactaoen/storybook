/**
 * Harlowe macro reading, for the two constructs that say something the links
 * alone cannot: which variable a passage assigns, and which condition gates a
 * link.
 *
 * Structure only — nothing here evaluates anything, exactly like `highlight.ts`.
 * The difference is that this reads *spans and names*, which the highlighter
 * deliberately does not: it is a flat one-way tokenizer with no macro end, no
 * nesting and no hook concept, so none of it is reusable here.
 *
 * What this feeds is gate inference (`lib/graph/gates.ts`): a passage doing
 * `(set: $v to "x")` plus a later link guarded on `(if: $v is "x")` proves every
 * route to that link's target passed the first passage.
 *
 * A second consumer wants the opposite of what gate inference wants. The
 * playthrough reader's evaluator (`run.ts`) needs breadth, because a condition
 * it cannot evaluate looks to an author like lost prose, where a guessed gate
 * is a lie about the story's shape. That split is visible below: `GUARD_MACROS`
 * reads two macros, while `chainsOf` sees all four branching ones. Nothing here
 * has grown the ability to *run* a macro — positions and adjacency are still
 * structure, and the exports exist so that there is exactly one `closeHook` in
 * the repo rather than one per consumer.
 *
 * Everything is deliberately narrow. A construct this cannot read with
 * certainty is reported as unreadable rather than guessed at, because the
 * consumer turns a guess into a confident claim about the story's shape.
 */

import type { Span } from './links'
import { parseLinks } from './links'

/** A condition of the exact form `$variable is "literal"`. */
export interface Guard {
  variable: string
  value: string
}

/** A `(set:)` of a variable to a bare string literal. */
export interface Assignment {
  variable: string
  value: string
}

export interface GuardSpan {
  guard: Guard
  /** The attached hook, when the author wrote one. Links inside it are gated. */
  hook: Span | null
  /** Offset of the `[[` directly after the macro, when no hook was written. */
  anchor: number | null
}

export interface Assignments {
  literal: Assignment[]
  /**
   * Variables written by something this parser cannot read — `(put:)`,
   * `(move:)`, a non-literal right-hand side, an unparseable `(set:)`.
   *
   * The consumer must refuse to gate on these. Missing one write means a route
   * exists that never passed the assumed gate, which is the one way this
   * feature can state something false rather than merely vague.
   */
  opaque: Set<string>
}

/**
 * Only these gate a link.
 *
 * `(unless:)` has identical surface syntax and the opposite meaning, and
 * `(else:)` carries no condition at all — both are left unread, which costs
 * precision and never correctness.
 *
 * `(else-if:)` belongs here despite only running when the earlier conditions
 * failed: its own condition is still *necessary* to take the branch, and
 * necessity is all a gate needs.
 */
const GUARD_MACROS = new Set(['if', 'else-if'])

/** Macros whose destination operand this parser will not try to read. */
const OPAQUE_MACROS = new Set(['put', 'move', 'unpack'])

const MACRO_OPEN = /\(\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:/g
/**
 * Every `$variable` or `_temp` name in a fragment of macro source.
 *
 * Exported so the reader's interpolation cannot drift from what the gate path
 * reads: two copies of this pattern would be two definitions of what counts as
 * a variable name.
 *
 * It carries `g`, and therefore `lastIndex`. `String.prototype.match` resets
 * that before it runs and leaves it at 0, which is what makes the two uses
 * below immune to whoever else holds this regex; `exec` and `test` do not, so a
 * consumer wanting a scan loop must build its own
 * `new RegExp(VARIABLE_RE.source, 'g')` — the idiom `parseMacros` uses with
 * `MACRO_OPEN` just above.
 */
export const VARIABLE_RE = /[$_][A-Za-z_][A-Za-z0-9_-]*/g

/**
 * The whole condition, anchored end to end.
 *
 * Anchoring is the soundness proof, not a tidiness preference. Searching for
 * `$v is "x"` inside the arguments reads `(if: $v is not "x")` as its exact
 * negation, and `(if: $v is "p" or $v is "q")` as a condition that is not
 * necessary at all — both of which would make a gate assert the one prefix a
 * route provably cannot have.
 */
const CONDITION = /^\$([A-Za-z_][A-Za-z0-9_-]*)\s+is\s+(".*"|'.*')$/

/** One assignment of the exact form `$v to "literal"`, anchored the same way. */
const ASSIGN = /^\$([A-Za-z_][A-Za-z0-9_-]*)\s+(?:to|into)\s+(".*"|'.*')$/

/**
 * A complete string literal and nothing else, escapes honoured.
 *
 * Shared with the reader so a literal means the same thing to both: an
 * evaluator reading `"a\"b"` differently from the gate path is a story that
 * analyses one way and plays another.
 */
export function stringValue(text: string): string | null {
  const quote = text[0]
  if (quote !== '"' && quote !== "'") return null
  let out = ''
  let i = 1
  while (i < text.length) {
    const c = text[i]!
    if (c === '\\') {
      if (i + 1 >= text.length) return null
      out += text[i + 1]
      i += 2
      continue
    }
    // A closing quote anywhere but the very end means this was not one literal.
    if (c === quote) return i === text.length - 1 ? out : null
    out += c
    i++
  }
  return null
}

/**
 * Walk past a string literal starting at `i`, honouring `\` escapes.
 *
 * The idiom is `highlight.ts`'s, and every scanner below routes through it:
 * a `)` or `[` inside a quoted string must never be counted as structure.
 *
 * "Below" stopped being the whole story when the reader arrived. `run.ts`'s
 * condition parser needs a literal's *extent* before it can hand the text to
 * `stringValue`, and a second walk over `\` escapes is exactly the divergence
 * the rest of these exports exist to prevent.
 */
export function skipString(src: string, i: number): number {
  const quote = src[i]!
  let j = i + 1
  while (j < src.length && src[j] !== quote) {
    if (src[j] === '\\') j++
    j++
  }
  return Math.min(j + 1, src.length)
}

/** Index just past the `)` closing the paren at `open`, or -1. */
function closeParen(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]!
    if (c === '"' || c === "'") {
      i = skipString(src, i)
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

/**
 * Index just past the `]` closing the hook at `open`.
 *
 * `[[` is jumped to its `]]` wholesale rather than counted: a link inside a
 * hook opens and closes two brackets, which a naive depth counter happens to
 * balance, but `[[A]]` standing alone balances too — so counting cannot tell a
 * hook containing a link from a bare link.
 *
 * Exported for the reader, which walks hooks to decide what to descend into. A
 * second copy of this is a guaranteed divergence: the `[[`-inside-a-hook case
 * is the only genuinely hard thing in this file, and it reads as an
 * off-by-a-bracket detail right up until it silently swallows a branch.
 */
export function closeHook(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]!
    if (c === '"' || c === "'") {
      i = skipString(src, i)
      continue
    }
    if (c === '[' && src[i + 1] === '[') {
      const close = src.indexOf(']]', i + 2)
      i = close === -1 ? src.length : close + 2
      continue
    }
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

/**
 * A hook's name tag, in Harlowe's two spellings: `|name>[…]` and `[…]<name|`.
 *
 * Sticky, so a scan can test at a position without slicing the rest of the body
 * out to do it. Both belong to the hook, not to what follows: a `(else:)` after
 * `[A]<t|` is still adjacent to its `(if:)`, and `(if: …)[…]<name|` is idiomatic
 * — the tag is what a later `(replace:)` aims at.
 */
export const HOOK_TAG_FRONT = /\|[\w-]*>/y
export const HOOK_TAG_BACK = /<[\w-]*\|/y

/** Past a hook tag at `i`, or `i` if there is none. */
function skipHookTag(src: string, i: number, tag: RegExp): number {
  tag.lastIndex = i
  return tag.exec(src) !== null ? tag.lastIndex : i
}

/** First index at or after `i` that is not whitespace. */
export function skipSpace(src: string, i: number): number {
  let j = i
  while (j < src.length && /\s/.test(src[j]!)) j++
  return j
}

/**
 * Index just past whatever body attaches to a macro ending at `macroEnd`: its
 * hook, the bare link the author wrote instead of one, or nothing at all.
 *
 * `closeHook` alone cannot answer this. It jumps `[[`..`]]` wholesale on
 * purpose, so at the `[` of `(if: $v is "x")[[A|P2]]` it treats the link as a
 * jumped span, runs off the end of the body and returns -1 — right for its own
 * question, useless for this one.
 *
 * `parseGuardSpans` splits the same cases just below and is deliberately *not*
 * refactored onto this. It has to *name* which case happened (`hook` versus
 * `anchor`), it never computes a bare link's end at all, and it emits no span
 * where this falls back to `macroEnd`. Sharing would mean rewriting the gate
 * path's most delicate twelve lines for no gain; the genuinely hard part,
 * `closeHook`, is already shared.
 *
 * An unterminated hook returns `macroEnd`, leaving its own `[` in whatever the
 * caller reads next. For `chainsOf` that breaks the chain, which is the safe
 * direction — an unreadable branch stands alone rather than silently joining.
 *
 * A hook's name tags are part of the hook, on both sides. Stopping at the `]` of
 * `(if: $v is "a")[A]<t|(else:)[B]` would leave `<t|` sitting between the two
 * branches, so `chainsOf` would read them as separate chains and a reader would
 * show both halves of an either-or at once.
 */
export function attachedEnd(src: string, macroEnd: number): number {
  const at = skipHookTag(src, skipSpace(src, macroEnd), HOOK_TAG_FRONT)
  if (src[at] === '[' && src[at + 1] === '[') {
    // No hook in the source at all: both brackets belong to the link.
    const close = src.indexOf(']]', at + 2)
    return close === -1 ? macroEnd : close + 2
  }
  if (src[at] === '[') {
    const close = closeHook(src, at)
    return close === -1 ? macroEnd : skipHookTag(src, close, HOOK_TAG_BACK)
  }
  return macroEnd
}

/**
 * Split macro arguments on the commas that sit at depth zero.
 *
 * Exported as-is, and the signature is frozen: it returns text, never offsets.
 * Offsets would make this a change on the gate path, which reads these same
 * args for `(set:)` — the one place in the reader work whose failure mode is a
 * wrong gate rather than a missing one. The evaluator needs only the text, for
 * a multi-assignment `(set: $a to "x", $b to "y")`.
 */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  let start = 0
  let depth = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"' || c === "'") {
      i = skipString(text, i)
      continue
    }
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
    i++
  }
  out.push(text.slice(start))
  return out
}

/** One `(name: ...)` call, located exactly in the body it came from. */
export interface RawMacro {
  name: string
  /** Argument text between the `:` and the closing `)`. */
  args: string
  /** Index of the `(`. */
  start: number
  /** Index just past the `:`, where `args` begins. */
  argsStart: number
  /** Index just past the closing `)`. */
  end: number
}

/**
 * Every `(name: ...)` call in `body`, with its arguments and extent.
 *
 * Positions, not just text. A caller that walks these as *statements* has to
 * tell a macro standing on its own from one sitting inside another's
 * arguments, and comparing `start` against the previous statement's `end` is
 * the only thing that answers it — without that filter, the reader would
 * execute a `(set:)` that is merely an operand. The gate path never asked,
 * which is why the positions were not here before.
 */
export function parseMacros(body: string): RawMacro[] {
  const re = new RegExp(MACRO_OPEN.source, 'g')
  const out: RawMacro[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const end = closeParen(body, m.index)
    if (end === -1) continue
    // `closeParen` does not touch `re`, so `lastIndex` still sits just past the
    // `:`. Slicing `args` *from* `argsStart` rather than alongside it makes
    // `args === body.slice(argsStart, end - 1)` true by construction.
    const argsStart = re.lastIndex
    out.push({
      name: m[1]!.toLowerCase(),
      args: body.slice(argsStart, end - 1),
      start: m.index,
      argsStart,
      end,
    })
    // Nested calls are found by the ongoing scan; only skip the opener itself
    // so `(if: (not: $x))` still yields both.
  }
  return out
}

/**
 * Every readable link guard in `body`, as spans for the caller to map onto
 * links.
 *
 * Deliberately no ordinals. `parseLinks` skips an empty target *without*
 * consuming one, so any bracket counting here would drift against `derive`'s
 * edge ids the moment a body contains `[[]]` — and a drifted ordinal gates the
 * wrong edge, which is a confident lie rather than a missing gate. The caller
 * runs the same `parseLinks` and matches by position instead.
 */
export function parseGuardSpans(body: string, macros = parseMacros(body)): GuardSpan[] {
  const out: GuardSpan[] = []
  for (const macro of macros) {
    if (!GUARD_MACROS.has(macro.name)) continue

    const cond = CONDITION.exec(macro.args.trim())
    if (!cond) continue
    const value = stringValue(cond[2]!)
    if (value === null) continue
    const guard: Guard = { variable: cond[1]!, value }

    // Harlowe allows whitespace, newlines included, between a macro and its
    // hook. Nothing else may intervene.
    const at = skipSpace(body, macro.end)
    if (body[at] === '[' && body[at + 1] === '[') {
      // No hook in the source at all: the author wrote the link directly, and
      // both brackets belong to it. Only that one link is gated.
      out.push({ guard, hook: null, anchor: at })
      continue
    }
    if (body[at] === '[') {
      const close = closeHook(body, at)
      if (close === -1) continue
      out.push({ guard, hook: { start: at, end: close }, anchor: null })
    }
  }
  return out
}

/**
 * Which guard, if any, covers each link in `body`, keyed by the link's ordinal
 * as `parseLinks` assigns it.
 *
 * Nested guards resolve to the innermost, because a later opener in source
 * order overwrites an enclosing one. Either condition alone is necessary, so
 * taking one is sound — it only gives up the precision a conjunction would add.
 */
export function guardsByOrdinal(
  body: string,
  links: readonly { ordinal: number; span: Span }[],
  macros = parseMacros(body),
): Map<number, Guard> {
  const spans = parseGuardSpans(body, macros)
  const out = new Map<number, Guard>()
  if (spans.length === 0) return out

  for (const link of links) {
    for (const g of spans) {
      const covers =
        g.anchor !== null
          ? link.span.start === g.anchor
          : g.hook !== null && link.span.start >= g.hook.start && link.span.end <= g.hook.end
      if (covers) out.set(link.ordinal, g.guard)
    }
  }
  return out
}

/**
 * Which variables `body` assigns, split into the ones read exactly and the
 * ones that were not.
 *
 * The `opaque` half is the load-bearing one. A gate is only sound if *every*
 * way of giving a variable its value has been seen, so a variable written by
 * `(put:)`, by another variable, or by anything this parser declines to read
 * must never be gated on.
 */
export function parseAssignments(body: string, macros = parseMacros(body)): Assignments {
  const literal: Assignment[] = []
  const opaque = new Set<string>()

  for (const macro of macros) {
    if (OPAQUE_MACROS.has(macro.name)) {
      // `(put: "x" into $v)` — reversed operands, and `(move:)`/`(unpack:)`
      // can write several at once. Every variable mentioned is suspect.
      for (const v of macro.args.match(VARIABLE_RE) ?? []) {
        if (v.startsWith('$')) opaque.add(v.slice(1))
      }
      continue
    }
    if (macro.name !== 'set') continue

    for (const part of splitArgs(macro.args)) {
      const text = part.trim()
      if (text.length === 0) continue
      const m = ASSIGN.exec(text)
      const value = m ? stringValue(m[2]!) : null
      if (m && value !== null && m[1] !== undefined) {
        literal.push({ variable: m[1], value })
        continue
      }
      // Unreadable: a computed value, `it + "a"`, another variable, a temp.
      // Mark whatever it looks like it writes, so the gate check can refuse.
      const dest = text.match(VARIABLE_RE)?.[0]
      if (dest?.startsWith('$')) opaque.add(dest.slice(1))
    }
  }

  return { literal, opaque }
}

/** The four macros that can stand in an `(if:)`-style chain. */
export type ChainKind = 'if' | 'else-if' | 'else' | 'unless'

export interface ChainSlot {
  /** Which chain, numbered in source order from 0 within one body. */
  chainId: number
  /** 0 for the macro that opens the chain, 1 for the first continuation, … */
  position: number
  kind: ChainKind
}

/** A `Map` rather than a `Set`, so the lookup narrows to `ChainKind` for free. */
const CHAIN_KIND = new Map<string, ChainKind>([
  ['if', 'if'],
  ['else-if', 'else-if'],
  ['else', 'else'],
  ['unless', 'unless'],
])

/** Kinds a later branch may be joined *to*. `(else:)` ends a chain. */
const CHAIN_OPENERS: ReadonlySet<ChainKind> = new Set<ChainKind>(['if', 'else-if', 'unless'])

/**
 * Kinds that may join an open chain.
 *
 * `(if:)` and `(unless:)` are absent on purpose: each carries its own test, so
 * two of them packed tight against each other are two independent conditions,
 * not alternatives. Reading adjacency alone would make the second exclusive
 * with the first and hide a branch the author wrote.
 *
 * `(else-if:)` is in both sets, which is exactly what it is.
 */
const CHAIN_CONTINUATIONS: ReadonlySet<ChainKind> = new Set<ChainKind>(['else-if', 'else'])

/** A branch still open: the slot it took, and where its own body ended. */
interface OpenBranch {
  slot: ChainSlot
  after: number
}

/**
 * Which `(if:)`-style chain each branching macro belongs to, keyed by the
 * macro's `start`.
 *
 * A different question from gate inference, deliberately. `GUARD_MACROS` reads
 * `if` and `else-if` only, because `(unless:)` means the opposite of what it
 * looks like and `(else:)` carries no condition — that is about what a
 * condition *claims*. This asks which branches are alternatives of one another,
 * which is a property of the source layout and true of all four kinds. Nothing
 * here reads a condition, and nothing on the gate path calls it.
 *
 * Adjacency is all Harlowe gives: a branch belongs to the one before it when
 * nothing but whitespace separates that branch's body from this macro's `(`.
 * That is stricter than Harlowe itself, which tolerates prose before an
 * `(else:)`, and the strictness errs toward *more* chains — an unchained
 * `(else:)` is one the reader shows rather than one it hides, so the cost is
 * prose repeated, never prose eaten. Fail open, the reader's direction, which
 * is the inverse of the fail-closed rule `gates.ts` runs on.
 *
 * `macros` must be in source order, which is what `parseMacros` returns.
 * `readStoryMacros` does not call this — it is off the typing path, so
 * `attachedEnd`, the one part here that is not O(1), never runs per keystroke.
 */
export function chainsOf(body: string, macros = parseMacros(body)): Map<number, ChainSlot> {
  const out = new Map<number, ChainSlot>()
  const open: OpenBranch[] = []
  let nextChain = 0
  /** `end` of the last macro read as a statement rather than as an operand. */
  let prevEnd = -1

  for (const macro of macros) {
    // `parseMacros` yields a macro sitting in another's *arguments* as well as
    // the one containing it. An operand is not a branch: without this,
    // `(if: (not: $x))[A]` leaves `(not:)` as the macro a following `(else:)`
    // is measured against, and every chain whose condition calls a macro
    // silently breaks. It also swallows the phantom a string literal can
    // produce — `MACRO_OPEN` scans the whole body, so `(set: $v to "(if: x)")`
    // yields a bogus `if` from inside the quotes.
    if (macro.start < prevEnd) continue
    prevEnd = macro.end

    const kind = CHAIN_KIND.get(macro.name)
    if (kind === undefined) continue

    // Pop every branch whose body has already closed; the last one popped is
    // this macro's *sibling*, the branch beside it at its own nesting depth.
    // A single "previous branch" variable cannot do this: it would orphan the
    // trailing `(else:)` of `(if:)[ (if:)[X](else:)[Y] ](else:)[Z]`, whose
    // opener is the outer `(if:)` and not the inner chain just above it.
    let sibling: OpenBranch | null = null
    while (open.length > 0 && open[open.length - 1]!.after <= macro.start) sibling = open.pop()!

    // Comparing positions rather than trimming `body.slice(after, start)` is
    // what keeps a nested branch out of the chain enclosing it: that slice runs
    // backwards, and a backwards slice is the empty string, which passes any
    // whitespace test.
    const previous =
      sibling !== null &&
      CHAIN_OPENERS.has(sibling.slot.kind) &&
      CHAIN_CONTINUATIONS.has(kind) &&
      skipSpace(body, sibling.after) === macro.start
        ? sibling.slot
        : null

    // An orphan `(else:)` or `(else-if:)` opens a chain of its own at position
    // 0, so the reader can spot one with a single lookup and leave `undefined`
    // meaning only "not a branching macro at all".
    const slot: ChainSlot = previous
      ? { chainId: previous.chainId, position: previous.position + 1, kind }
      : { chainId: nextChain++, position: 0, kind }

    out.set(macro.start, slot)
    open.push({ slot, after: attachedEnd(body, macro.end) })
  }

  return out
}

/** Everything a whole story's macros say, gathered in one pass over its bodies. */
export interface StoryMacros {
  /** Guard per edge, keyed exactly as `deriveGraph` keys its edges. */
  guardOf: Map<string, Guard>
  /** Which passages assign each variable, and to what. */
  assignersOf: Map<string, { nodeId: string; value: string }[]>
  /** Variables some passage writes in a way this parser could not read. */
  opaqueVars: Set<string>
}

/**
 * Read every passage's macros once.
 *
 * The edge key is built as `${id}|${ordinal}` to match `EdgeId`
 * (`lib/graph/derive.ts`, where it is the only place one is constructed). That
 * duplication is deliberate — this layer must not depend on the graph — and a
 * test asserts the two agree, because a silent drift here would attach a guard
 * to the wrong edge, which is the one failure that produces a confident lie
 * rather than a missing gate.
 */
export function readStoryMacros(
  nodes: readonly { id: string; body: string }[],
): StoryMacros {
  const guardOf = new Map<string, Guard>()
  const assignersOf = new Map<string, { nodeId: string; value: string }[]>()
  const opaqueVars = new Set<string>()

  for (const node of nodes) {
    // One scan per body, shared by both readers. This runs on the typing path:
    // `gates` is memoized on `layoutVersion`, which every body keystroke bumps,
    // so parsing twice would double the cost for the whole story per character.
    const macros = parseMacros(node.body)

    for (const [ordinal, guard] of guardsByOrdinal(node.body, parseLinks(node.body), macros)) {
      guardOf.set(`${node.id}|${ordinal}`, guard)
    }

    const { literal, opaque } = parseAssignments(node.body, macros)
    for (const a of literal) {
      const list = assignersOf.get(a.variable) ?? []
      list.push({ nodeId: node.id, value: a.value })
      assignersOf.set(a.variable, list)
    }
    for (const v of opaque) opaqueVars.add(v)
  }

  return { guardOf, assignersOf, opaqueVars }
}
