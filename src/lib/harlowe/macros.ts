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
const VAR = /[$_][A-Za-z_][A-Za-z0-9_-]*/g

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

/** A complete string literal and nothing else, escapes honoured. */
function stringValue(text: string): string | null {
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
 */
function skipString(src: string, i: number): number {
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
 */
function closeHook(src: string, open: number): number {
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

/** First index at or after `i` that is not whitespace. */
function skipSpace(src: string, i: number): number {
  let j = i
  while (j < src.length && /\s/.test(src[j]!)) j++
  return j
}

/** Split macro arguments on the commas that sit at depth zero. */
function splitArgs(text: string): string[] {
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

interface RawMacro {
  name: string
  /** Argument text between the `:` and the closing `)`. */
  args: string
  /** Index just past the closing `)`. */
  end: number
}

/** Every `(name: ...)` call in `body`, with its arguments and extent. */
function parseMacros(body: string): RawMacro[] {
  const re = new RegExp(MACRO_OPEN.source, 'g')
  const out: RawMacro[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const end = closeParen(body, m.index)
    if (end === -1) continue
    out.push({
      name: m[1]!.toLowerCase(),
      args: body.slice(re.lastIndex, end - 1),
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
      for (const v of macro.args.match(VAR) ?? []) {
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
      const dest = text.match(VAR)?.[0]
      if (dest?.startsWith('$')) opaque.add(dest.slice(1))
    }
  }

  return { literal, opaque }
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
