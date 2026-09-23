/**
 * A Harlowe evaluator for the playthrough reader: given a passage body and the
 * variables a reader is carrying, the prose they see, the choices they can
 * take, and the variables afterwards.
 *
 * Pure — no UI, no store, no DOM, no `eval`. The output is a tree of typed
 * nodes rather than an HTML string, which is what makes the safety structural
 * instead of disciplinary: prose reaches the DOM only through Vue's `{{ }}`,
 * which escapes unconditionally, so there is no place to forget. `importDoc`
 * reads arbitrary JSON off disk, so the threat model is a story someone else
 * wrote.
 *
 * **Fail OPEN, the exact inverse of `gates.ts`, and it will read as
 * inconsistency without this paragraph.** There, an unreadable construct costs
 * a gate — precision — while a wrong one states something false about the
 * story's shape, so every doubt resolves to "no gate". Here, an unreadable
 * condition that hid its hook would delete prose the author wrote and show the
 * reader nothing at all, which is worse by a distance. So a *readable* false
 * condition hides its hook, which is the entire point of a reader, and an
 * *unreadable* one renders the hook with a marker. Prose repeated, never prose
 * eaten. Every rule below that looks over-cautious is that asymmetry: marking
 * too much can only ever make something render, marking too little hides it.
 *
 * Nothing here is imported by `gates.ts` or `paths.ts`, and nothing here
 * imports them. Wire this broader evaluator into gate inference and
 * `(if: $v is not "x")` — which this reads and that deliberately refuses —
 * starts producing gates, the soundness break `macros.ts` documents at its top.
 * `paths.ts` is the same rule pointed elsewhere: a reader follows self-links
 * and back edges, because a reader really can loop, and `forwardTargets`
 * deliberately does not.
 *
 * The markup read is Harlowe's own, checked against its grammar
 * (`js/markup/patterns.js`, zlib): `''bold''`, `//italic//`, `` `verbatim` ``,
 * `> ` quoting, `<!-- -->`, hooks and links. Harlowe also accepts `**strong**`
 * and `*em*`; those are deliberately unread, because `format.ts` never writes
 * them and reading them would turn an author's literal asterisk into markup.
 *
 * **A `(prompt:)` halts the walk, and the caller replays it.** Harlowe 3 shows
 * the prompt as a dialog and freezes the passage's stack frame until it is
 * answered, queueing the answer (`blockedValues`) for the macro to read on
 * resume. A pure function cannot wait, so this stops at the first prompt it has
 * no answer for, reports it as `pending`, and returns what came before it. The
 * caller asks the reader and renders again from the top with one more answer.
 * That is the frozen frame made pure: the render up to the k-th prompt depends
 * only on the variables carried in and the k-1 answers before it, so the k-th
 * prompt reached is the same prompt on every pass, and nothing is resumed that
 * could have drifted from the source.
 */

import type { ParsedLink } from './links'
import { parseLinks } from './links'
import type { ChainSlot, RawMacro } from './macros'
import {
  chainsOf,
  closeHook,
  HOOK_TAG_BACK,
  HOOK_TAG_FRONT,
  parseMacros,
  skipSpace,
  skipString,
  splitArgs,
  stringValue,
  VARIABLE_RE,
} from './macros'

/** Whether a variable was set, never set, or set to something unreadable. */
export type VarState = 'set' | 'unset' | 'unreadable'

/**
 * What every inline carries.
 *
 * `uncertain` is set throughout a region whose outcome this evaluator could not
 * establish. The chip beside it says *what* could not be read; this says how
 * far the doubt reaches, so the reader can mute the whole region rather than
 * re-deriving its extent from the position of a marker.
 */
interface Marked {
  bold: boolean
  italic: boolean
  uncertain: boolean
}

export type Inline =
  | ({
      kind: 'text'
      text: string
      /**
       * True when this text is a *value* — the output of `(print:)` — rather
       * than prose the author wrote. Block markup is not re-read out of it:
       * `(print: "> hi")` prints a greater-than sign, it does not open a quote,
       * because Harlowe re-parses the output of `(display:)` and not of
       * `(print:)`.
       */
      inert: boolean
    } & Marked)
  | ({ kind: 'link'; ordinal: number; label: string; target: string } & Marked)
  | ({ kind: 'variable'; name: string; value: string | null; state: VarState } & Marked)
  | ({
      kind: 'unsupported'
      name: string
      /**
       * The full source, not a label. `MACRO_OPEN` matches any `(word:`, so an
       * ordinary authorial aside — `He lied (Note: he always lies) and left` —
       * arrives here as a macro named `note`. Rendering only the name would
       * delete the author's sentence, so the reader must show this text.
       */
      source: string
    } & Marked)

export interface Block {
  kind: 'para' | 'quote'
  inlines: Inline[]
}

export interface RunChoice {
  /** `parseLinks`'s ordinal, never an index into `choices`. */
  ordinal: number
  label: string
  target: string
  /**
   * The link sits in a region this evaluator could not establish, so Harlowe
   * might not offer it at all. The caller acts on `choices`, so the marker has
   * to reach it here too — a link out of a `(hidden:)` hook handed over as a
   * definite choice is the fail-open asymmetry losing its marker exactly where
   * it matters.
   */
  uncertain: boolean
}

/** A reader-input macro this passage ran into. */
export interface Ask {
  /**
   * `prompt` is `(prompt:)`, which the caller answers through `renderPassage`'s
   * `answers`. `bind` is an `(input-box:)`-style binding: a live control this
   * evaluator does not model, reported and never answered.
   */
  kind: 'prompt' | 'bind'
  /**
   * Where the answer goes. Null for a `(prompt:)` whose answer goes nowhere
   * this can name — inside `(print:)` or a condition, or standing alone in the
   * prose — which is reported only so the author learns it is never asked.
   */
  variable: string | null
  message: string
  default: string | null
  /** What the reader answered. Null where nothing did, or nothing could. */
  answer: string | null
}

/**
 * The `(prompt:)` a render stopped at, waiting for the reader.
 *
 * The argument order is Harlowe's, and easy to get backwards: `(prompt:
 * message, default, cancel, confirm)`. Cancel returns `default` whatever was
 * typed — the rule since Harlowe 3.1 — which is why a prompt whose default
 * cannot be read is never asked at all.
 */
export interface PendingPrompt {
  variable: string
  /** The literal's text, or the argument's source when it is not a literal. */
  message: string
  default: string
  /** The Cancel button's text, or null where the author hid it with `""`. */
  cancel: string | null
  confirm: string
}

/**
 * The variables a reader carries.
 *
 * Absent means never set. `null` means set by something this evaluator could
 * not read — a different fact, and collapsing the two would tell an author who
 * wrote `(set: $n to 3)` that they never set `$n`.
 *
 * Keys keep their sigil (`$lantern`, `_i`). That differs from `macros.ts`'s
 * `assignersOf`, which strips `$` and ignores temps; this layer is independent
 * of the gate path, and `$v` and `_v` are two variables. A caller mixing the
 * two vocabularies would silently look up nothing.
 */
export type Vars = ReadonlyMap<string, string | null>

export interface RunResult {
  blocks: Block[]
  /** In `parseLinks` ordinal order — the links that actually rendered. */
  choices: RunChoice[]
  /** Variables after this passage, temps dropped. */
  vars: Vars
  /** What this passage wrote, for the debug console. Temps included. */
  assigned: { variable: string; value: string | null }[]
  /**
   * Input this passage asked the reader for, in the order it was reached. A
   * prompt still `pending` is not among them.
   */
  asks: Ask[]
  /** Distinct macro names this evaluator could not run, in codepoint order. */
  unsupported: string[]
  /**
   * The prompt this render halted at, or null when it ran to the end.
   *
   * While it is set the passage is half-run: `blocks` hold only what came
   * before the prompt, and `choices` and `vars` describe that much and no more.
   * Nothing may be acted on until it is answered and the passage rendered again.
   */
  pending: PendingPrompt | null
}

/** Macros that write a variable in a shape this evaluator refuses to read. */
const OPAQUE_WRITERS = new Set(['move', 'unpack'])

/** Sticky copy of `MACRO_OPEN`, for the one macro `parseMacros` drops. */
const OPENER = /\(\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:/y
/** Sticky copy of the shared variable pattern, so `lastIndex` is ours alone. */
const SIGIL = new RegExp(VARIABLE_RE.source, 'y')
/** Past a hook tag at `i`, or `i` if there is none. Shared with `attachedEnd`. */
function skipHookTag(src: string, i: number, tag: RegExp): number {
  tag.lastIndex = i
  return tag.exec(src) !== null ? tag.lastIndex : i
}

/**
 * The same text with every string literal blanked out, positions preserved.
 *
 * `macros.ts` states the rule this exists for: a `)` or `[` inside a quoted
 * string must never be counted as structure. Neither must a *word* —
 * `(link: "bind $rope to the post")` is prose, not a variable binding.
 */
function outsideStrings(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"' || c === "'") {
      const end = skipString(text, i)
      out += ' '.repeat(end - i)
      i = end
      continue
    }
    out += c
    i++
  }
  return out
}
/**
 * `$v to "x"` / `$v into "x"` — anchored, the way `macros.ts`'s ASSIGN is.
 *
 * No space is needed after the operator, because Harlowe's lexer ends `to` at
 * a word boundary: `$v to(prompt: …)` is a set. The lookahead is what keeps
 * `$v tomato` from reading as one.
 */
const SET_PART = /^([$_][A-Za-z_][A-Za-z0-9_-]*)\s+(?:to|into)(?=[\s("'])\s*([\s\S]+)$/
/**
 * `"x" into $v` — reversed operands, anchored on the tail so a string may hold
 * `into`. A closing paren, quote or bracket ends the left side as well as a
 * space does, for the same word-boundary reason.
 */
const PUT_PART = /^([\s\S]+?)(?:\s+|(?<=[)"'\]]))into\s+([$_][A-Za-z_][A-Za-z0-9_-]*)\s*$/
/** A `(prompt:)` call, to be matched only against text with its strings blanked. */
const PROMPT_CALL = /\(\s*prompt\s*:/i
/** `(input-box: bind $v, …)`, and Harlowe 3's two-way `2bind`. */
const BIND = /\b2?bind\s+([$_][A-Za-z_][A-Za-z0-9_-]*)/

type Tri = boolean | null

interface ChainState {
  /** A branch of this chain has run; later ones are skipped. */
  satisfied: boolean
  /** A branch of this chain was unreadable, so later ones are marked too. */
  tainted: boolean
}

interface Ctx {
  body: string
  macroAt: Map<number, RawMacro>
  chains: Map<number, ChainSlot>
  linkAt: Map<number, ParsedLink>
  chainState: Map<number, ChainState>
  vars: Map<string, string | null>
  out: Inline[]
  choices: RunChoice[]
  assigned: { variable: string; value: string | null }[]
  asks: Ask[]
  unsupported: Set<string>
  /** The reader's answers to this passage's prompts, in the order they were reached. */
  answers: readonly string[]
  /** How many of `answers` the walk has used so far. */
  answered: number
  /** Set when the walk reached a prompt with no answer left; the walk stops there. */
  pending: PendingPrompt | null
  bold: boolean
  italic: boolean
  /** Greater than zero inside a region whose outcome could not be established. */
  speculative: number
  /**
   * Greater than zero where the source is malformed, so what follows is read
   * for its prose but nothing in it is allowed to run.
   */
  frozen: number
  /** Pending run of plain text, flushed when anything else is emitted. */
  buf: string
}

/**
 * Render one passage.
 *
 * The three-state variable model rests on a precondition worth stating: every
 * variable reaching `vars` came either from a passage this same function ran —
 * where an unreadable write records `null` rather than going missing — or was
 * seeded by the caller. Variables a Harlowe `startup` or `header` passage would
 * set are outside that guarantee, and are the caller's to seed.
 *
 * The map handed in is never mutated; the one handed back is fresh.
 *
 * `answers` are the reader's replies to the prompts this passage reaches, in
 * order. Pass the same list again with one more reply to go past the prompt
 * the last render stopped at; replies beyond the prompts reached are unused.
 */
export function renderPassage(
  body: string,
  vars: Vars = new Map(),
  answers: readonly string[] = [],
): RunResult {
  const macros = parseMacros(body)
  const ctx: Ctx = {
    body,
    macroAt: new Map(macros.map((m) => [m.start, m])),
    // One parse, shared — the way `readStoryMacros` shares its own.
    chains: chainsOf(body, macros),
    linkAt: new Map(parseLinks(body).map((l) => [l.span.start, l])),
    chainState: new Map(),
    // Temps are per-passage in Harlowe, so none arrives and none leaves.
    vars: new Map([...vars].filter(([name]) => name.startsWith('$'))),
    out: [],
    choices: [],
    assigned: [],
    asks: [],
    unsupported: new Set(),
    answers,
    answered: 0,
    pending: null,
    bold: false,
    italic: false,
    speculative: 0,
    frozen: 0,
    buf: '',
  }

  evalSpan(ctx, 0, body.length)
  flush(ctx)

  const out = new Map<string, string | null>()
  for (const [name, value] of ctx.vars) if (name.startsWith('$')) out.set(name, value)

  return {
    blocks: toBlocks(ctx.out),
    choices: ctx.choices,
    vars: out,
    assigned: ctx.assigned,
    asks: ctx.asks,
    // Codepoint order, not `localeCompare` — this repo's determinism rule.
    unsupported: [...ctx.unsupported].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    pending: ctx.pending,
  }
}

// ---------------------------------------------------------------- emitting

function marks(ctx: Ctx): Marked {
  return { bold: ctx.bold, italic: ctx.italic, uncertain: ctx.speculative > 0 }
}

function flush(ctx: Ctx): void {
  if (ctx.buf.length === 0) return
  ctx.out.push({ kind: 'text', text: ctx.buf, inert: false, ...marks(ctx) })
  ctx.buf = ''
}

/** Emit a value rather than prose, so block markup is not read back out of it. */
function pushValue(ctx: Ctx, text: string): void {
  flush(ctx)
  ctx.out.push({ kind: 'text', text, inert: true, ...marks(ctx) })
}

/**
 * Walk a region whose outcome could not be established.
 *
 * The flushes are load-bearing rather than tidiness: `marks` is read when the
 * buffer is flushed, not when text is appended to it, so text gathered inside
 * the region would otherwise be emitted after the depth had dropped back and
 * would carry `uncertain: false` — the region would render unmarked, which is
 * the one thing the flag exists to prevent.
 */
function speculate(ctx: Ctx, from: number, to: number): void {
  ctx.speculative++
  evalRegion(ctx, from, to)
  ctx.speculative--
}

/**
 * Walk a nested region — a hook's interior — with formatting of its own.
 *
 * `bold` and `italic` are context flags on the walk, which is what lets them
 * survive a link or a macro. They must not survive the *hook* that opened them:
 * `[start ''here] plain` would otherwise bold everything after the hook as well,
 * leaving the author's real `''…''` unread and a stray marker in the prose.
 *
 * The flushes are load-bearing either way: `marks` is read when the buffer is
 * flushed, not when text is appended, so text gathered inside the region would
 * otherwise be emitted with whatever state applied after it ended.
 */
function evalRegion(ctx: Ctx, from: number, to: number): void {
  flush(ctx)
  const bold = ctx.bold
  const italic = ctx.italic
  evalSpan(ctx, from, to)
  flush(ctx)
  ctx.bold = bold
  ctx.italic = italic
}

function chip(ctx: Ctx, name: string, source: string): void {
  flush(ctx)
  ctx.unsupported.add(name)
  ctx.out.push({ kind: 'unsupported', name, source, ...marks(ctx) })
}

function emitVariable(ctx: Ctx, name: string): void {
  flush(ctx)
  const held = ctx.vars.get(name)
  const state: VarState = !ctx.vars.has(name) ? 'unset' : held === null ? 'unreadable' : 'set'
  // An unset variable shows its own name rather than Harlowe's `0`: for an
  // author preview, what did not get set is the useful and honest answer.
  ctx.out.push({ kind: 'variable', name, value: state === 'set' ? held! : null, state, ...marks(ctx) })
}

function emitLink(ctx: Ctx, link: ParsedLink): void {
  flush(ctx)
  const label = link.label ?? link.target
  const uncertain = ctx.speculative > 0
  ctx.out.push({ kind: 'link', ordinal: link.ordinal, label, target: link.target, ...marks(ctx) })
  ctx.choices.push({ ordinal: link.ordinal, label, target: link.target, uncertain })
}

// ---------------------------------------------------------------- the walk

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c)
}

function evalSpan(ctx: Ctx, from: number, to: number): void {
  const src = ctx.body
  let i = from
  /*
    Whether a `$` or `_` here would begin a variable. It is a question about the
    previous *token*, not the previous character: mid-word in `some_word` the
    answer is no, but directly after a variable or a macro — `_t$p`, or
    `(set: …)$v` — it is yes, because Harlowe's lexer starts a fresh token there.
  */
  let boundary = true

  // A pending prompt ends the walk everywhere at once. Every region is walked
  // by this loop, so no nested caller can emit past the prompt: what they do on
  // the way back up is flush a buffer that already stopped short of it.
  while (i < to && ctx.pending === null) {
    const c = src[i]!

    // A macro runs only when it starts *exactly* at the cursor, and running it
    // moves the cursor past its whole argument list. That is the operand trap
    // closed by construction: `parseMacros` yields a macro sitting inside
    // another's arguments as well as the one containing it, and the cursor is
    // never inside an argument list to meet it. The phantom `(if:` that
    // `MACRO_OPEN` finds inside `(set: $v to "(if: x)")` is skipped the same way.
    const macro = ctx.macroAt.get(i)
    if (macro !== undefined) {
      // A `]` inside unquoted arguments can close a hook early, leaving a macro
      // that starts inside this span and ends outside it. Never run a straddler.
      if (macro.end > to) {
        chip(ctx, macro.name, src.slice(i, to))
        return
      }
      i = runMacro(ctx, macro, to)
      boundary = true
      continue
    }

    // The one way the cursor could otherwise reach an argument list:
    // `parseMacros` drops a macro whose paren never closes, so nothing is
    // indexed at its `(` and the walk would stroll in and execute what it
    // found. Harlowe fails the whole passage here; this reports the rest of the
    // span as one unreadable chunk, which loses no characters — the source
    // rides on the inline — and keeps the cursor out of the arguments.
    if (c === '(') {
      OPENER.lastIndex = i
      const opener = OPENER.exec(src)
      if (opener !== null) {
        // `parseMacros` drops a macro whose paren never closes, so nothing is
        // indexed at its `(` and the walk would stroll into its arguments and
        // execute what it found. Chipping the rest of the span would keep the
        // cursor out but strand every link after it — one typo'd paren and the
        // reader has no way forward, on a passage the map still draws edges
        // from. So: report the opener, then read on with execution frozen.
        // Prose kept, links kept, and nothing inside can run.
        chip(ctx, opener[1]!.toLowerCase(), opener[0])
        ctx.frozen++
        speculate(ctx, i + opener[0].length, to)
        ctx.frozen--
        return
      }
    }

    const link = ctx.linkAt.get(i)
    if (link !== undefined && link.span.end <= to) {
      emitLink(ctx, link)
      i = link.span.end
      boundary = true
      continue
    }

    // Invisible in Harlowe (`comment: "<!--[^]*?-->"`), so invisible here.
    if (c === '<' && src.startsWith('<!--', i)) {
      const close = src.indexOf('-->', i + 4)
      i = close === -1 || close + 3 > to ? to : close + 3
      boundary = true
      continue
    }

    // Verbatim: whatever is between matching backtick runs is literal text, so
    // markup inside it must not be read.
    if (c === '`') {
      const next = runVerbatim(ctx, i, to)
      if (next !== null) {
        i = next
        boundary = true
        continue
      }
    }

    // A hook standing on its own, named or not. Harlowe renders the contents
    // and drops the brackets, which costs prose like `[aside]` its brackets.
    if (c === '[' || (c === '|' && skipHookTag(src, i, HOOK_TAG_FRONT) > i)) {
      const next = runBareHook(ctx, i, to)
      if (next !== null) {
        i = next
        boundary = true
        continue
      }
    }

    if ((c === "'" || c === '/') && src[i + 1] === c) {
      const marker = c + c
      const on = c === "'" ? ctx.bold : ctx.italic
      // Harlowe's `stylerSyntax` is `''([^]*?)''`: it needs *both* terminators,
      // so a lone `//` is literal text. Toggling on the opener alone would let
      // the `//` of `https://example.com` italicise the rest of the passage.
      // The closer has to be inside this span, not merely somewhere in the
      // body: an unrelated `//x//` further down the passage would otherwise let
      // the `//` of `https://…` open an emphasis that swallows everything
      // between them.
      const close = src.indexOf(marker, i + 2)
      if (on || (close !== -1 && close + 2 <= to)) {
        flush(ctx)
        if (c === "'") ctx.bold = !ctx.bold
        else ctx.italic = !ctx.italic
        i += 2
        boundary = true
        continue
      }
    }

    // A sigil only at a word boundary, or `some_word` renders as a marker where
    // four characters of the author's prose used to be.
    if ((c === '$' || c === '_') && boundary) {
      SIGIL.lastIndex = i
      const m = SIGIL.exec(src)
      if (m !== null && m[0].length > 1 && i + m[0].length <= to) {
        emitVariable(ctx, m[0])
        i += m[0].length
        boundary = true
        continue
      }
    }

    ctx.buf += c
    boundary = !isWordChar(c)
    i++
  }
}

/** Past the closing backtick run, having emitted the interior as literal text. */
function runVerbatim(ctx: Ctx, at: number, to: number): number | null {
  const src = ctx.body
  let open = at
  while (src[open] === '`') open++
  const fence = src.slice(at, open)
  const close = src.indexOf(fence, open)
  if (close === -1 || close + fence.length > to) return null
  // One space at each end, not `trim()`: Harlowe's grammar allows a single
  // space so a literal backtick can sit against the fence, and preserving the
  // rest is the whole point of verbatim.
  pushValue(ctx, src.slice(open, close).replace(/^ /, '').replace(/ $/, ''))
  return close + fence.length
}

/** Past a hook standing on its own, having rendered its interior. */
function runBareHook(ctx: Ctx, at: number, to: number): number | null {
  const src = ctx.body
  const open = skipHookTag(src, at, HOOK_TAG_FRONT)
  // `[[` is a link, and `runVerbatim`'s caller has already had its turn.
  if (src[open] !== '[' || src[open + 1] === '[') return null
  const close = closeHook(src, open)
  if (close === -1 || close > to) return null
  evalRegion(ctx, open + 1, close - 1)
  return skipHookTag(src, close, HOOK_TAG_BACK)
}

// ---------------------------------------------------------------- macros

/** What a macro owns: a hook's interior, the bare link written instead, or nothing. */
interface Attached {
  start: number
  end: number
  /** Where the walk resumes. */
  after: number
  /** False when the hook never closed, so nothing about it can be trusted. */
  certain: boolean
}

/**
 * What attaches to a macro ending at `macroEnd`.
 *
 * Not `attachedEnd`: that answers where the body *ends*, which is all
 * `chainsOf` needed. A branch has to descend into the body, so it needs the
 * interior — and it needs to know when the hook never closed, because an
 * unterminated hook is a condition nobody can act on.
 */
function attachmentOf(src: string, macroEnd: number, limit: number): Attached | null {
  const at = skipHookTag(src, skipSpace(src, macroEnd), HOOK_TAG_FRONT)
  if (at >= limit || src[at] !== '[') return null

  if (src[at + 1] === '[') {
    // No hook in the source at all: the author wrote the link directly, and
    // both brackets belong to it. `closeHook` jumps `[[`..`]]` wholesale and so
    // cannot measure this case — it would run off the end and return -1.
    const close = src.indexOf(']]', at + 2)
    if (close === -1 || close + 2 > limit) return null
    return { start: at, end: close + 2, after: close + 2, certain: true }
  }

  const close = closeHook(src, at)
  if (close !== -1 && close <= limit) {
    // The back tag belongs to the hook, and `attachedEnd` agrees — a drift
    // there would have `chainsOf` read `[A]<t|(else:)[B]` as two chains and
    // show both halves of an either-or at once.
    return { start: at + 1, end: close - 1, after: skipHookTag(src, close, HOOK_TAG_BACK), certain: true }
  }
  // Unterminated. Take the rest of the span as the body and call it uncertain:
  // the alternative is letting the cursor walk in as plain text, which would
  // run a `(set:)` under a condition that came out false.
  return { start: at + 1, end: limit, after: limit, certain: false }
}

function runMacro(ctx: Ctx, macro: RawMacro, to: number): number {
  // Inside malformed source: say what is here, change nothing.
  if (ctx.frozen > 0) {
    chip(ctx, macro.name, source(ctx, macro))
    return macro.end
  }

  const slot = ctx.chains.get(macro.start)
  if (slot !== undefined) return runBranch(ctx, macro, slot, to)

  switch (macro.name) {
    case 'set':
    case 'put':
      runAssign(ctx, macro)
      // Not the attached body: `attachedEnd` skips newlines, so consuming one
      // here would swallow a bracketed aside the author wrote on the next line,
      // with no chip and no marker. Only a branch owns what follows it.
      return macro.end
    case 'print':
      runPrint(ctx, macro)
      return macro.end
    default:
      if (OPAQUE_WRITERS.has(macro.name)) {
        // Reversed operands, and these can write several variables at once.
        // Every one they name is suspect.
        darkenAll(ctx, macro.args)
        chip(ctx, macro.name, source(ctx, macro))
        return macro.end
      }
      return runUnknown(ctx, macro, to)
  }
}

function runUnknown(ctx: Ctx, macro: RawMacro, to: number): number {
  // A variable in a *writer* position goes dark. `(input-box: bind $name, …)`
  // really does write one, and a variable left merely absent compares false,
  // which would hide a hook and eat the prose in it.
  //
  // Only a writer position, though. Darkening everything the macro names took
  // `(text-colour: $name)` — which merely reads it — as a reason to replace a
  // value the passage provably set, and pushed a write into `assigned` that
  // never happened. The fail-open argument licenses pushing a *condition* to
  // unreadable; it does not license overwriting a known value in the prose, or
  // reporting a write in the debug console that Harlowe would not perform.
  readBind(ctx, macro)
  if (macro.name === 'prompt' || mentionsPrompt(macro.args)) unreadPrompt(ctx, null)
  chip(ctx, macro.name, source(ctx, macro))

  const body = attachmentOf(ctx.body, macro.end, to)
  if (body === null) return macro.end
  // Whatever it does with its hook, we are guessing.
  speculate(ctx, body.start, body.end)
  return body.after
}

function runPrint(ctx: Ctx, macro: RawMacro): void {
  const text = macro.args.trim()
  const name = wholeVariable(text)
  if (name !== null) {
    emitVariable(ctx, name)
    return
  }
  const literal = stringValue(text)
  if (literal !== null) {
    pushValue(ctx, literal)
    return
  }
  if (mentionsPrompt(text)) unreadPrompt(ctx, null)
  chip(ctx, macro.name, source(ctx, macro))
}

/** `text` as one variable name, sigil and all, or null if it is anything more. */
function wholeVariable(text: string): string | null {
  SIGIL.lastIndex = 0
  const name = SIGIL.exec(text)?.[0]
  return name !== undefined && name.length === text.length ? name : null
}

function runBranch(ctx: Ctx, macro: RawMacro, slot: ChainSlot, to: number): number {
  if (slot.position === 0) ctx.chainState.set(slot.chainId, { satisfied: false, tainted: false })
  const state = ctx.chainState.get(slot.chainId) ?? { satisfied: false, tainted: false }
  ctx.chainState.set(slot.chainId, state)

  const body = attachmentOf(ctx.body, macro.end, to)

  // An `(else:)` or `(else-if:)` opening its own chain is an orphan: whatever
  // it was written to alternate with, this cannot see it.
  const orphan = slot.position === 0 && slot.kind !== 'if' && slot.kind !== 'unless'
  let cond: Tri
  if (orphan) cond = null
  else if (slot.kind === 'else') cond = true
  else {
    cond = evalCondition(macro.args, ctx.vars)
    if (slot.kind === 'unless') cond = cond === null ? null : !cond
  }
  // An unterminated hook is a condition nobody can act on, whatever it says.
  if (body !== null && !body.certain) cond = null

  if (state.satisfied) return body ? body.after : macro.end
  // Reached, so Harlowe would ask it — and this reads no macro in a condition.
  if (slot.kind !== 'else' && mentionsPrompt(macro.args)) unreadPrompt(ctx, null)

  if (cond === false) {
    // The one place this evaluator hides what the author wrote — and the only
    // one, which is why the condition had to be *readable* to get here.
    // Nothing inside runs: no `(set:)`, and no link reaches `choices`.
    return body ? body.after : macro.end
  }

  if (body === null) {
    // `(if: $v is "x")(else:)[B]` — no hook to render either way, but a readable
    // true condition still settles the chain. Without this the `(else:)` runs,
    // and its prose is shown unmarked as though Harlowe had chosen it: one of
    // the few paths where this could state something false rather than merely
    // show too much.
    if (cond === null) chip(ctx, macro.name, source(ctx, macro))
    else state.satisfied = true
    return macro.end
  }

  if (cond === null) {
    // Show it, mark it, and do *not* satisfy the chain, so a following
    // `(else:)` shows too. Repeating prose is recoverable; eating it is not.
    state.tainted = true
    chip(ctx, macro.name, source(ctx, macro))
    speculate(ctx, body.start, body.end)
    return body.after
  }

  if (state.tainted) {
    // An earlier branch of this chain was unreadable and rendered anyway, so
    // this one is the answer to a question nobody settled. Mark it too, or the
    // reader sees an unmarked contradiction with only half of it flagged.
    chip(ctx, macro.name, source(ctx, macro))
    speculate(ctx, body.start, body.end)
  } else {
    evalRegion(ctx, body.start, body.end)
  }
  state.satisfied = true
  return body.after
}

function source(ctx: Ctx, macro: RawMacro): string {
  return ctx.body.slice(macro.start, macro.end)
}

// ---------------------------------------------------------------- variables

function assign(ctx: Ctx, variable: string, value: string | null): void {
  ctx.vars.set(variable, value)
  ctx.assigned.push({ variable, value })
}

/** Record a variable as written-but-unreadable, so conditions on it render. */
function darken(ctx: Ctx, variable: string): void {
  assign(ctx, variable, null)
}

function darkenAll(ctx: Ctx, text: string): void {
  // `match` with a `/g` regex resets `lastIndex` before it runs, which is what
  // lets the shared `VARIABLE_RE` be used directly rather than rebuilt — the
  // idiom `parseAssignments` uses, and one fewer copy of what a name is.
  for (const name of text.match(VARIABLE_RE) ?? []) darken(ctx, name)
}

/**
 * Read `(set:)` and `(put:)`.
 *
 * Not `parseAssignments`: that is a flat pass over a whole body, which is
 * precisely what must not happen here — it would run the sets inside hidden
 * hooks. Its `ASSIGN` is no use either, being `$`-only, sigil-stripping and
 * `(put:)`-opaque, three things this needs the other way round. The risky half
 * is still shared: `stringValue` and `skipString` are the one escape rule.
 */
function runAssign(ctx: Ctx, macro: RawMacro): void {
  const parts = splitArgs(macro.args)
  // Harlowe evaluates every argument before it assigns any, so a prompt's
  // default reads the variables as they stood when this macro began, not as the
  // parts to its left have since written them. A lone part has nothing to its
  // left, which spares the copy in the common case.
  const before: Vars = parts.length > 1 ? new Map(ctx.vars) : ctx.vars
  for (const part of parts) {
    const text = part.trim()
    if (text.length === 0) continue

    const m = macro.name === 'set' ? SET_PART.exec(text) : PUT_PART.exec(text)
    if (m === null) {
      // Unreadable shape. Mark the first variable named, the way
      // `parseAssignments` does — marking every one would take a readable
      // right-hand side dark for nothing.
      const dest = text.match(VARIABLE_RE)?.[0]
      if (dest !== undefined) darken(ctx, dest)
      if (mentionsPrompt(text)) unreadPrompt(ctx, dest ?? null)
      continue
    }

    const variable = macro.name === 'set' ? m[1]! : m[2]!
    const valueText = (macro.name === 'set' ? m[2]! : m[1]!).trim()
    const prompt = readPrompt(before, valueText)
    if (prompt !== null) {
      runPrompt(ctx, variable, prompt)
      // Harlowe runs a whole `(set:)` only once its prompts are answered, so
      // stopping mid-list leaves nothing it would have done undone for good:
      // the next render starts over from the top.
      if (ctx.pending !== null) return
      continue
    }
    const value = stringValue(valueText)

    // Speculative: this sits inside a branch whose condition could not be read,
    // so Harlowe may never have run it. Recording the literal would turn a guess
    // into a confident value, and a confident value hides the other branch of
    // the *next* condition. Unreadable can only ever show.
    if (value === null || ctx.speculative > 0) darken(ctx, variable)
    else assign(ctx, variable, value)
    // A prompt inside an expression this cannot evaluate — `(prompt: …) + "!"`.
    // The reader is never asked, so the author has to be told.
    if (value === null && mentionsPrompt(valueText)) unreadPrompt(ctx, variable)
  }
}

/** A `(prompt:)` as written: `PendingPrompt` before it is known to be askable. */
type PromptCall = Omit<PendingPrompt, 'variable' | 'default'> & { default: string | null }

/**
 * The right-hand side, when it is one `(prompt:)` call and nothing else.
 *
 * *Exactly* one: `(prompt: "a", "b") + "!"` is an expression this cannot
 * evaluate, and taking the prompt out of it would assign the answer without
 * the suffix — a confident value Harlowe would never produce.
 */
function readPrompt(vars: Vars, valueText: string): PromptCall | null {
  // Most right-hand sides are literals, and a parse would be wasted on them.
  if (valueText[0] !== '(') return null
  const call = parseMacros(valueText)[0]
  if (call === undefined || call.name !== 'prompt') return null
  if (call.start !== 0 || call.end !== valueText.length) return null
  const [message = '', fallback, cancel, confirm] = splitArgs(call.args).map((a) => a.trim())
  const cancelLabel = cancel === undefined ? 'Cancel' : (stringValue(cancel) ?? 'Cancel')
  return {
    // Not a literal — a code hook, a variable, an expression — so show what
    // was written rather than a blank question.
    message: stringValue(message) ?? message,
    default: readDefault(vars, fallback),
    // `""` hides Cancel, Harlowe's own rule. A blank confirm is an error there,
    // and "OK" is the label it would otherwise have had.
    cancel: cancelLabel === '' ? null : cancelLabel,
    confirm: (confirm === undefined ? null : stringValue(confirm)) || 'OK',
  }
}

/**
 * The default a prompt offers and Cancel returns: a literal, or a variable
 * holding a known value. Null for anything else, since Cancel must return it.
 */
function readDefault(vars: Vars, text: string | undefined): string | null {
  if (text === undefined) return null
  const literal = stringValue(text)
  if (literal !== null) return literal
  const name = wholeVariable(text)
  if (name === null) return null
  // Absent is Harlowe's `0`, a number, which `(prompt:)` refuses as a default.
  return vars.get(name) ?? null
}

/**
 * `(set: $name to (prompt: "Your name?", "Mira"))` — answer it, or stop here.
 *
 * Two prompts are never asked. One in a region this could not establish, which
 * Harlowe may never reach: asking would put a question to the reader that the
 * story does not, and the write would be darkened anyway (`runAssign`). And one
 * whose default cannot be read, because Cancel would have nothing to return.
 * Both fall back to what any unreadable write does, which fails open.
 */
function runPrompt(ctx: Ctx, variable: string, call: PromptCall): void {
  const { message, default: fallback, cancel, confirm } = call
  if (ctx.speculative > 0 || fallback === null) {
    darken(ctx, variable)
    ctx.asks.push({ kind: 'prompt', variable, message, default: fallback, answer: null })
    return
  }
  if (ctx.answered < ctx.answers.length) {
    const answer = ctx.answers[ctx.answered++]!
    assign(ctx, variable, answer)
    ctx.asks.push({ kind: 'prompt', variable, message, default: fallback, answer })
    return
  }
  ctx.pending = { variable, message, default: fallback, cancel, confirm }
}

/** Whether `text` calls `(prompt:)` anywhere outside its string literals. */
function mentionsPrompt(text: string): boolean {
  return PROMPT_CALL.test(outsideStrings(text))
}

/**
 * A `(prompt:)` this cannot run: the reader is never asked it. Reported as an
 * ask with no answer, which is what puts the author note on the page in Play.
 */
function unreadPrompt(ctx: Ctx, variable: string | null): void {
  ctx.asks.push({ kind: 'prompt', variable, message: '', default: null, answer: null })
}

/**
 * `(input-box: bind $v, …)` — the other way a passage asks the reader for input.
 *
 * The bind is read out of the arguments with their string literals blanked, so
 * the word `bind` inside an author's prose cannot invent a prompt for a variable
 * nothing binds.
 *
 * No message is guessed. The first string argument of `(input-box:)` is its
 * size pattern (`"=XX="`) and of `(dropdown:)` its first option, so taking one
 * would show the reader a layout spec where a question belongs. The variable's
 * own name is the honest label, and naming it is the caller's job.
 */
function readBind(ctx: Ctx, macro: RawMacro): void {
  const bound = BIND.exec(outsideStrings(macro.args))
  if (bound === null) return
  darken(ctx, bound[1]!)
  ctx.asks.push({ kind: 'bind', variable: bound[1]!, message: '', default: null, answer: null })
}

// ---------------------------------------------------------------- conditions

interface Cursor {
  src: string
  i: number
  /** A paren that never closed — structural, unlike a term merely unread. */
  failed: boolean
}

/**
 * Evaluate a condition, three ways: true, false, or unreadable.
 *
 * Narrower than Harlowe by a distance — `$v is "x"`, `is not`, `and`, `or` and
 * parentheses, and nothing else. Everything unread returns `null`, which
 * renders the branch with a marker rather than hiding it.
 *
 * `is not` is read here where `gates.ts` refuses it, which is the whole reason
 * these two must never share code: a gate built on this reading would state
 * something false about the story, while a reader that ignored it would hide
 * prose.
 */
export function evalCondition(args: string, vars: Vars): Tri {
  const cur: Cursor = { src: args, i: 0, failed: false }
  const value = parseOr(cur, vars)
  skipWs(cur)
  // Text left over is this parser's proof that it did not understand the
  // condition: `contains`, `>`, `it`, a macro call all end up here.
  return cur.failed || cur.i < cur.src.length ? null : value
}

function skipWs(cur: Cursor): void {
  cur.i = skipSpace(cur.src, cur.i)
}

/** Consume `word` when it stands alone, so `isnt` is never read as `is`. */
function word(cur: Cursor, text: string): boolean {
  skipWs(cur)
  if (!cur.src.startsWith(text, cur.i)) return false
  const after = cur.src[cur.i + text.length]
  if (after !== undefined && /[A-Za-z0-9_-]/.test(after)) return false
  cur.i += text.length
  return true
}

function parseOr(cur: Cursor, vars: Vars): Tri {
  let left = parseAnd(cur, vars)
  while (word(cur, 'or')) {
    // Both sides are parsed even once the answer is settled: short-circuiting
    // would leave the other operand unconsumed, and unconsumed text is exactly
    // how this proves it understood nothing.
    const right = parseAnd(cur, vars)
    left = left === true || right === true ? true : left === false && right === false ? false : null
  }
  return left
}

function parseAnd(cur: Cursor, vars: Vars): Tri {
  let left = parseTerm(cur, vars)
  while (word(cur, 'and')) {
    const right = parseTerm(cur, vars)
    left = left === false || right === false ? false : left === true && right === true ? true : null
  }
  return left
}

/**
 * Step past a term this parser could not read, to the next `and` or `or` at
 * depth zero, or to the end of the group.
 *
 * Abandoning the whole condition instead would give up the case where the rest
 * of it settles the answer anyway: `$lantern is "lit" and $x > 3` is false
 * whenever the lantern is out, whatever the second half turns out to mean. The
 * term itself still evaluates to unreadable — this only keeps the cursor in
 * step, so the operators around it can still be read.
 */
function skipTerm(cur: Cursor): void {
  let depth = 0
  while (cur.i < cur.src.length) {
    const c = cur.src[cur.i]!
    if (c === '"' || c === "'") {
      cur.i = skipString(cur.src, cur.i)
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) return
      depth--
    } else if (depth === 0) {
      const keyword = cur.src.startsWith('and', cur.i) ? 3 : cur.src.startsWith('or', cur.i) ? 2 : 0
      if (keyword > 0) {
        const wordish = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_-]/.test(ch)
        if (!wordish(cur.src[cur.i - 1]) && !wordish(cur.src[cur.i + keyword])) return
      }
    }
    cur.i++
  }
}

function parseTerm(cur: Cursor, vars: Vars): Tri {
  skipWs(cur)
  if (cur.src[cur.i] === '(') {
    cur.i++
    const value = parseOr(cur, vars)
    skipWs(cur)
    if (cur.src[cur.i] !== ')') {
      cur.failed = true
      return null
    }
    cur.i++
    return value
  }

  SIGIL.lastIndex = cur.i
  const name = SIGIL.exec(cur.src)?.[0]
  if (name === undefined || name.length < 2) {
    skipTerm(cur)
    return null
  }
  cur.i += name.length
  // A bare `(if: $v)` lands here: readable to Harlowe, not to this.
  if (!word(cur, 'is')) {
    skipTerm(cur)
    return null
  }
  const negated = word(cur, 'not')
  const literal = readLiteral(cur)
  if (literal === null) {
    // `$a is $b`, `is 3` — a comparison whose right side is not a literal.
    skipTerm(cur)
    return null
  }

  if (!vars.has(name)) {
    // Never assigned on this playthrough, so it provably does not hold that
    // literal. Sound only because an unreadable *write* darkens its variable
    // instead of leaving it absent — see `runAssign` and `runUnknown`.
    return negated
  }
  const value = vars.get(name)!
  if (value === null) return null
  return negated ? value !== literal : value === literal
}

function readLiteral(cur: Cursor): string | null {
  skipWs(cur)
  const quote = cur.src[cur.i]
  if (quote !== '"' && quote !== "'") return null
  const end = skipString(cur.src, cur.i)
  const value = stringValue(cur.src.slice(cur.i, end))
  if (value === null) return null
  cur.i = end
  return value
}

// ---------------------------------------------------------------- blocks

/**
 * Split a rendered stream on its newlines.
 *
 * Exported because a block is a run of lines, and a caller that wants to ask
 * something of a single *line* — the reader asks whether one holds nothing but
 * links — would otherwise re-implement this and drift from it.
 */
export function linesOf(stream: readonly Inline[]): Inline[][] {
  const lines: Inline[][] = [[]]
  for (const inline of stream) {
    if (inline.kind !== 'text') {
      lines[lines.length - 1]!.push(inline)
      continue
    }
    const parts = inline.text.split('\n')
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) lines.push([])
      const part = parts[k]!
      if (part.length > 0) lines[lines.length - 1]!.push({ ...inline, text: part })
    }
  }
  return lines
}

/**
 * Cut blocks from the *rendered* stream, never from the source.
 *
 * A hidden hook can delete the text a line started with, so what the reader
 * sees as a paragraph is a property of the output. Quoting is decided per line
 * and then like lines are grouped, the way `format.ts` writes it — classifying
 * a whole group would leave a literal `>` in the prose the moment one line of
 * it was unquoted.
 */
function toBlocks(stream: readonly Inline[]): Block[] {
  const lines = linesOf(stream)

  const blocks: Block[] = []
  let open: Block | null = null
  for (const line of lines) {
    if (line.every((n) => n.kind === 'text' && n.text.trim().length === 0)) {
      open = null
      continue
    }
    const head = line[0]
    // `inert` text is the output of `(print:)`, not something the author wrote
    // on a line, so a `>` in it is a greater-than sign and not a quote marker.
    const quoted =
      head !== undefined && head.kind === 'text' && !head.inert && head.text.startsWith('>')
    const kind: Block['kind'] = quoted ? 'quote' : 'para'
    const content = quoted
      ? [{ ...head, text: head.text.replace(/^>\s?/, '') }, ...line.slice(1)]
      : line

    if (open === null || open.kind !== kind) {
      open = { kind, inlines: [] }
      blocks.push(open)
    } else {
      open.inlines.push({
        kind: 'text',
        text: '\n',
        inert: false,
        bold: false,
        italic: false,
        uncertain: false,
      })
    }
    open.inlines.push(...content.filter((n) => n.kind !== 'text' || n.text.length > 0))
  }
  return blocks
}
