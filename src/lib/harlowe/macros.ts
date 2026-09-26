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

import { compareStr } from '../../types/story'
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

/**
 * The passage a `(display:)` names, when its argument is exactly one string
 * literal — and null when it is anything else, which nobody can read.
 *
 * The single definition, shared by the reader, the publisher, the lint and the
 * recode, so `(display: "P7")` names the same passage to all four. A passage's
 * name in this tool is its code (invariant 3), so what comes back is a code.
 */
export function displayCode(args: string): string | null {
  return stringValue(args.trim())
}

/** One `(display:)` call, located exactly. */
export interface DisplayRef {
  /** The code it names, or null when the argument is not one string literal. */
  code: string | null
  /** The whole `(display: …)` call. */
  macro: Span
  /** The string literal, quotes included, when `code` is not null. */
  literal: Span | null
}

/** Whether `at` falls inside a string literal somewhere in `src[from, at)`. */
function insideString(src: string, from: number, at: number): boolean {
  let i = from
  while (i < at) {
    const c = src[i]
    if (c === '"' || c === "'") {
      const end = skipString(src, i)
      if (at < end) return true
      i = end
      continue
    }
    i++
  }
  return false
}

/**
 * The stretches of prose Harlowe never runs: `<!-- comments -->` and
 * `` `verbatim` `` runs, found the way `run.ts` finds them.
 *
 * Only *prose* is walked. A macro met in prose is jumped whole — its arguments
 * are code, where neither construct exists — and the walk resumes at its end,
 * so a hook after it is prose again. A macro inside one of these spans is text,
 * and every reader of `(display:)` has to agree with the player that it is:
 * a commented-out `(display: $x)` taken at its word would switch off every gate
 * in the story, over a line the author disabled.
 */
function unrunSpans(body: string, macros: readonly RawMacro[]): Span[] {
  const at = new Map<number, RawMacro>()
  for (const m of macros) if (!at.has(m.start)) at.set(m.start, m)
  const out: Span[] = []
  let i = 0
  while (i < body.length) {
    const macro = at.get(i)
    if (macro !== undefined) {
      i = macro.end
      continue
    }
    if (body.startsWith('<!--', i)) {
      const close = body.indexOf('-->', i + 4)
      const end = close === -1 ? body.length : close + 3
      out.push({ start: i, end })
      i = end
      continue
    }
    if (body[i] === '`') {
      let open = i
      while (body[open] === '`') open++
      const close = body.indexOf(body.slice(i, open), open)
      if (close !== -1) {
        const end = close + (open - i)
        out.push({ start: i, end })
        i = end
        continue
      }
      // An unclosed fence is literal backticks, as it is to the reader.
      i = open
      continue
    }
    i++
  }
  return out
}

/**
 * Every `(display:)` in `body` the player would run, in source order.
 *
 * `MACRO_OPEN` scans the whole body, so `(set: $v to "(display: 'X')")` yields a
 * `display` from inside the quotes. That one is dropped — but only that one.
 * `chainsOf`'s statement filter would also drop a display sitting in another
 * macro's *arguments*, which is real code: a recode that skipped it would leave
 * it naming a code that no longer exists. So the test is narrower: a macro is a
 * phantom exactly when it starts inside a string literal of the innermost real
 * macro enclosing it. Prose is not an argument list — Harlowe runs a macro in
 * quoted prose — so a macro enclosed by nothing is never a phantom.
 *
 * A display inside a comment or a verbatim run is dropped too (`unrunSpans`).
 *
 * `macros` is optional so that the cheap test comes first: most bodies name no
 * display at all, and every caller that scans a whole story would otherwise
 * pay for a full macro parse of each one to learn that.
 */
export function parseDisplays(body: string, macros?: readonly RawMacro[]): DisplayRef[] {
  if (!/display/i.test(body)) return []
  const all = macros ?? parseMacros(body)
  if (!all.some((m) => m.name === 'display')) return []
  const unrun = unrunSpans(body, all)
  const out: DisplayRef[] = []
  /** Real macros whose argument list may still enclose the next one. */
  const open: RawMacro[] = []
  for (const m of all) {
    while (open.length > 0 && open[open.length - 1]!.end <= m.start) open.pop()
    const parent = open[open.length - 1]
    if (parent !== undefined && insideString(body, parent.argsStart, m.start)) continue
    if (unrun.some((u) => m.start >= u.start && m.start < u.end)) continue
    open.push(m)
    if (m.name !== 'display') continue

    const lead = m.args.length - m.args.trimStart().length
    const text = m.args.trim()
    const code = displayCode(m.args)
    out.push({
      code,
      macro: { start: m.start, end: m.end },
      literal:
        code === null ? null : { start: m.argsStart + lead, end: m.argsStart + lead + text.length },
    })
  }
  return out
}

/**
 * `text` as a string literal in `quote`, escaped so `stringValue` reads it back
 * exactly. Codes may hold quotes — only link syntax is banned from them.
 */
export function quoteString(text: string, quote: '"' | "'" = '"'): string {
  return quote + text.replace(/\\/g, '\\\\').split(quote).join('\\' + quote) + quote
}

/** The macro that shows the passage coded `code` inline. */
export function buildDisplay(code: string): string {
  return `(display: ${quoteString(code)})`
}

/**
 * Rewrite every `(display:)` naming a code in `mapping` to name its new code.
 *
 * `remapLinks`'s discipline, for the same reason: a recode is a permutation, so
 * every literal is looked up once in the *old* vocabulary and the splices run
 * right to left, keeping earlier spans valid. The author's quote character is
 * kept. A display whose argument is not a literal is left alone — there is no
 * code in it to rewrite.
 */
export function remapDisplays(body: string, mapping: ReadonlyMap<string, string>): string {
  if (mapping.size === 0 || !/display/i.test(body)) return body
  const hits = parseDisplays(body).filter((d) => {
    if (d.code === null) return false
    const to = mapping.get(d.code)
    return to !== undefined && to !== d.code
  })
  let out = body
  for (let i = hits.length - 1; i >= 0; i--) {
    const { code, literal } = hits[i]!
    const quote = body[literal!.start] === "'" ? "'" : '"'
    out = out.slice(0, literal!.start) + quoteString(mapping.get(code!)!, quote) + out.slice(literal!.end)
  }
  return out
}

/**
 * Every passage `body` displays, directly or through what it displays, as
 * `[code, body]` pairs in code order.
 *
 * `resolve` answers which codes may be displayed at all, and with what text —
 * this layer knows nothing of snippets. A code it refuses is simply absent,
 * which is how the reader learns to render that display as unreadable. Each
 * code is visited once, so a cycle terminates here and is caught at render.
 *
 * `memo` holds what each resolved code's own body displays, so a caller asking
 * for many passages — the publisher, once per passage — parses each snippet
 * once rather than once per passage that shows it.
 */
export function displayClosure(
  body: string,
  resolve: (code: string) => string | null,
  memo: Map<string, (string | null)[]> = new Map(),
): [string, string][] {
  const found = new Map<string, string>()
  const codesIn = (text: string, code: string | null): (string | null)[] => {
    if (code === null) return parseDisplays(text).map((d) => d.code)
    let codes = memo.get(code)
    if (codes === undefined) {
      codes = parseDisplays(text).map((d) => d.code)
      memo.set(code, codes)
    }
    return codes
  }
  const queue: [string, string | null][] = [[body, null]]
  while (queue.length > 0) {
    const [text, from] = queue.pop()!
    for (const code of codesIn(text, from)) {
      if (code === null || found.has(code)) continue
      const target = resolve(code)
      if (target === null) continue
      found.set(code, target)
      queue.push([target, code])
    }
  }
  return [...found].sort(([a], [b]) => compareStr(a, b))
}

/**
 * How deep displays may nest before the reader stops. A cycle is caught by the
 * reader's stack; this bounds a chain that is merely long.
 *
 * Here rather than in `run.ts`, because the lint has to state the same limit
 * and `run.ts` exports nothing to the graph layer.
 */
export const DISPLAY_DEPTH = 8
/**
 * How many displays one render may walk. Depth alone is not enough: a snippet
 * that displays another twice, at every level, doubles per level.
 */
export const DISPLAY_BUDGET = 256

/** What the reader will meet walking a body's displays, read statically. */
export interface DisplayReach {
  /** Some display comes back round to one already being shown. */
  cycle: boolean
  /** The deepest nesting of displays, 1 for a display of a snippet that shows none. */
  depth: number
  /** Displays walked in all, saturating just past `DISPLAY_BUDGET`. */
  count: number
}

/**
 * Read, for any number of bodies, what the reader's display limits will say
 * about them — the lint's half of `runDisplay`'s refusals.
 *
 * Conditions are not evaluated, so a display behind a false `(if:)` counts: the
 * lint says a loop *can* happen, which is the question an author needs asked.
 * One analyzer per story: results are memoized by code, which is sound because
 * a code's reach depends only on its body — the cycle flag included, since a
 * code memoized without one reached nothing that was still being walked.
 */
export function displayReach(resolve: (code: string) => string | null): (body: string) => DisplayReach {
  const memo = new Map<string, DisplayReach>()
  const walking = new Set<string>()
  const cap = DISPLAY_BUDGET + 1

  const ofBody = (body: string): DisplayReach => {
    let cycle = false
    let depth = 0
    let count = 0
    for (const d of parseDisplays(body)) {
      if (d.code === null) continue
      const target = resolve(d.code)
      if (target === null) continue
      const r = ofCode(d.code, target)
      cycle ||= r.cycle
      depth = Math.max(depth, 1 + r.depth)
      count = Math.min(cap, count + 1 + r.count)
    }
    return { cycle, depth, count }
  }

  const ofCode = (code: string, body: string): DisplayReach => {
    if (walking.has(code)) return { cycle: true, depth: 0, count: 0 }
    const known = memo.get(code)
    if (known !== undefined) return known
    walking.add(code)
    const r = ofBody(body)
    walking.delete(code)
    memo.set(code, r)
    return r
  }

  return ofBody
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
 *
 * `(display:)` runs another passage's `(set:)` *at the passage displaying it*,
 * and reading each body in isolation attributes that write to the wrong
 * passage. So every variable a displayed passage writes is opaque: a snippet's
 * writes always (and a snippet is never an assigner — it is on no route, and
 * `gatesOf` would read its missing level as level 1), any other passage's once
 * a literal display names it, and *every* written variable in the story once
 * any display's argument cannot be read, since that one could name anything.
 */
export function readStoryMacros(
  // Required, not optional: a caller that left them off would switch off every
  // rule above in silence — a snippet's `(set:)` read as an assigner is the
  // confident lie invariant 4 exists to prevent.
  nodes: readonly { id: string; body: string; code: string; isSnippet: boolean }[],
): StoryMacros {
  const guardOf = new Map<string, Guard>()
  const assignersOf = new Map<string, { nodeId: string; value: string }[]>()
  const opaqueVars = new Set<string>()
  /** What each passage writes, by code, for the display rule below. */
  const writes: { code: string; vars: string[] }[] = []
  const displayed = new Set<string>()
  let unreadableDisplay = false

  for (const node of nodes) {
    // One scan per body, shared by every reader. This runs on the typing path:
    // `gates` is memoized on `bodyVersion`, which every body keystroke bumps,
    // so parsing twice would double the cost for the whole story per character.
    const macros = parseMacros(node.body)
    const { literal, opaque } = parseAssignments(node.body, macros)
    const vars = [...literal.map((a) => a.variable), ...opaque]
    writes.push({ code: node.code, vars })

    for (const d of parseDisplays(node.body, macros)) {
      if (d.code === null) unreadableDisplay = true
      else displayed.add(d.code)
    }

    if (node.isSnippet) {
      for (const v of vars) opaqueVars.add(v)
      continue
    }

    for (const [ordinal, guard] of guardsByOrdinal(node.body, parseLinks(node.body), macros)) {
      guardOf.set(`${node.id}|${ordinal}`, guard)
    }

    for (const a of literal) {
      const list = assignersOf.get(a.variable) ?? []
      list.push({ nodeId: node.id, value: a.value })
      assignersOf.set(a.variable, list)
    }
    for (const v of opaque) opaqueVars.add(v)
  }

  // Every holder of a displayed code, not the first: which one a display
  // reaches is not this layer's question, and marking both is order-free.
  for (const w of writes) {
    if (unreadableDisplay || displayed.has(w.code)) {
      for (const v of w.vars) opaqueVars.add(v)
    }
  }

  return { guardOf, assignersOf, opaqueVars }
}
