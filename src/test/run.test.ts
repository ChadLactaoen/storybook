import { describe, expect, it } from 'vitest'
import { deriveGraph } from '../lib/graph/derive'
import { parseLinks } from '../lib/harlowe/links'
import { renderPassage, type RunResult } from '../lib/harlowe/run'
import { docFrom } from './helpers'

const render = (body: string, vars?: [string, string | null][]) =>
  renderPassage(body, new Map(vars ?? []))

/**
 * The rendered passage as one readable string: `p:`/`q:` per block, `¶` between
 * them, `<$v=…>` for a variable, `[label->target]` for a link, `{name}` for the
 * chip an unreadable construct leaves behind.
 */
function text(result: RunResult): string {
  return result.blocks
    .map(
      (block) =>
        block.kind[0] +
        ':' +
        block.inlines
          .map((n) =>
            n.kind === 'text'
              ? n.text
              : n.kind === 'link'
                ? `[${n.label}->${n.target}]`
                : n.kind === 'variable'
                  ? `<${n.name}=${n.state === 'set' ? n.value : n.state}>`
                  : `{${n.name}}`,
          )
          .join(''),
    )
    .join(' ¶ ')
}

/** Every variable after the passage, `?` standing for one written unreadably. */
const vars = (result: RunResult) =>
  [...result.vars].map(([k, v]) => `${k}=${v === null ? '?' : v}`).sort()

describe('prose and formatting', () => {
  it('renders plain prose as one paragraph', () => {
    expect(text(render('Just words.'))).toBe('p:Just words.')
  })

  it('splits paragraphs on a blank line and keeps adjacent lines together', () => {
    expect(text(render('one\ntwo\n\nthree'))).toBe('p:one\ntwo ¶ p:three')
  })

  it('reads bold and italic, consuming the markers', () => {
    const [bold, plain] = render("''loud'' soft").blocks[0]!.inlines
    expect(bold).toMatchObject({ text: 'loud', bold: true })
    expect(plain).toMatchObject({ text: ' soft', bold: false })
  })

  it('carries formatting across a link and a macro', () => {
    // Two booleans on every inline, rather than a nested parse: Harlowe's
    // formatting does not nest meaningfully beyond bold inside italic.
    const result = render("''a [[go|P2]] b (set: $v to \"x\") c''")
    for (const inline of result.blocks[0]!.inlines) expect(inline.bold).toBe(true)
  })

  it('leaves a lone // alone rather than italicising the rest', () => {
    // Harlowe's styler syntax needs both terminators, so the `//` of a URL is
    // literal text. A toggle on the opener alone would italicise to the end.
    const result = render('See https://example.com for more.')
    expect(text(result)).toBe('p:See https://example.com for more.')
    expect(result.blocks[0]!.inlines.every((n) => !n.italic)).toBe(true)
  })

  it('groups quoted lines into one block and strips the markers', () => {
    expect(text(render('> one\n> two\n\nplain'))).toBe('q:one\ntwo ¶ p:plain')
  })

  it('ends a quote block at an unquoted line, leaving no literal marker', () => {
    // Classifying a whole group would leave the `>` of the quoted line in the
    // reader's prose.
    expect(text(render('> quoted\nplain'))).toBe('q:quoted ¶ p:plain')
  })

  it('drops an HTML comment', () => {
    expect(text(render('before <!-- hidden --> after'))).toBe('p:before  after')
  })

  it('renders a bare hook without its brackets', () => {
    expect(text(render('a [an aside] b'))).toBe('p:a an aside b')
  })

  it('renders a named hook without its tag', () => {
    expect(text(render('|greeting>[Hello.]'))).toBe('p:Hello.')
  })

  it('treats a verbatim span as literal text', () => {
    expect(text(render("a `''not bold''` b"))).toBe("p:a ''not bold'' b")
  })
})

describe('variables', () => {
  it('interpolates a variable that was set', () => {
    expect(text(render('(set: $name to "Mira")Hello $name.'))).toBe('p:Hello <$name=Mira>.')
  })

  it('marks an unset variable rather than printing Harlowe\'s 0', () => {
    // For an author preview, what did not get set is the useful answer.
    expect(text(render('Hello $nobody.'))).toBe('p:Hello <$nobody=unset>.')
  })

  it('keeps written-unreadably apart from never-written', () => {
    // The distinction the three-state model exists for: an author who wrote
    // `(set: $n to 3)` must not be told they never set `$n`.
    const result = render('(set: $n to 3)$n')
    expect(text(result)).toBe('p:<$n=unreadable>')
    expect(vars(result)).toEqual(['$n=?'])
  })

  it('reads several assignments in one macro', () => {
    expect(vars(render('(set: $a to "x", $b to "y")'))).toEqual(['$a=x', '$b=y'])
  })

  it('darkens only the destination of an unreadable part', () => {
    // Marking every variable named would take a readable `$c` dark for nothing.
    expect(vars(render('(set: $c to "keep")(set: $b to $c)'))).toEqual(['$b=?', '$c=keep'])
  })

  it('runs put, whose operands are the other way round', () => {
    expect(text(render('(put: "lit" into $v)(if: $v is "lit")[Bright.]'))).toBe('p:Bright.')
  })

  it('is not fooled by into inside the value it is putting', () => {
    expect(vars(render('(put: "walked into a bar" into $v)'))).toEqual(['$v=walked into a bar'])
  })

  it('lets a temp live for the passage without escaping it', () => {
    // Harlowe temps are per-passage; `assigned` still reports the write.
    const result = render('(set: _t to "x")(set: $p to "y")_t$p')
    expect(text(result)).toBe('p:<_t=x><$p=y>')
    expect(vars(result)).toEqual(['$p=y'])
    expect(result.assigned).toEqual([
      { variable: '_t', value: 'x' },
      { variable: '$p', value: 'y' },
    ])
  })

  it('leaves an underscore inside a word as prose', () => {
    // A sigil only at a word boundary, or four characters of prose become a
    // marker for a temp nobody wrote.
    expect(text(render('the some_word and email_address'))).toBe('p:the some_word and email_address')
  })

  it('reads a hyphen as part of a variable name, as Harlowe does', () => {
    expect(text(render('(set: $hero-like to "yes")$hero-like'))).toBe('p:<$hero-like=yes>')
  })

  it('carries variables in from the caller', () => {
    expect(text(render('(if: $lantern is "lit")[You see.]', [['$lantern', 'lit']]))).toBe('p:You see.')
  })

  it('does not mutate the map it was given', () => {
    const carried = new Map([['$a', 'x' as string | null]])
    renderPassage('(set: $b to "y")', carried)
    expect([...carried.keys()]).toEqual(['$a'])
  })
})

describe('conditions', () => {
  it('renders a true hook and hides a false one', () => {
    expect(text(render('(set: $v to "lit")(if: $v is "lit")[Bright.]'))).toBe('p:Bright.')
    expect(text(render('(set: $v to "lit")(if: $v is "dark")[Bright.]'))).toBe('')
  })

  it('reads unless as the negation of if', () => {
    expect(text(render('(set: $v to "lit")(unless: $v is "dark")[Shown.]'))).toBe('p:Shown.')
  })

  it('reads is not, which the gate path deliberately refuses', () => {
    // The designed asymmetry: a gate built on this reading would state
    // something false, while a reader ignoring it would hide prose.
    expect(text(render('(set: $v to "a")(if: $v is not "b")[Shown.]'))).toBe('p:Shown.')
    expect(text(render('(set: $v to "a")(if: $v is not "a")[Shown.]'))).toBe('')
  })

  it('reads and, or and parentheses', () => {
    const set = '(set: $a to "1")(set: $b to "2")'
    expect(text(render(`${set}(if: $a is "1" and $b is "2")[both]`))).toBe('p:both')
    expect(text(render(`${set}(if: $a is "9" and $b is "2")[both]`))).toBe('')
    expect(text(render(`${set}(if: $a is "9" or $b is "2")[either]`))).toBe('p:either')
    expect(text(render(`${set}(if: ($a is "9") or ($a is "1"))[ok]`))).toBe('p:ok')
  })

  it('settles a compound whose other half is unreadable', () => {
    // Kleene logic: false wins an and, true wins an or, whatever sits opposite.
    expect(text(render('(set: $a to "1")(if: $a is "9" and $a > 3)[shown]'))).toBe('')
    expect(text(render('(set: $a to "1")(if: $a is "1" or $a > 3)[shown]'))).toBe('p:shown')
  })

  it('compares an unset variable as false, and is not on it as true', () => {
    expect(text(render('(if: $v is "x")[shown]'))).toBe('')
    expect(text(render('(if: $v is not "x")[shown]'))).toBe('p:shown')
  })

  it('calls everything it cannot read unreadable, and shows it', () => {
    for (const condition of ['$v', '$a is $b', '$v > 2', '$v contains "x"', '$v isnt "x"']) {
      expect(text(render(`(if: ${condition})[kept]`))).toBe(`p:{if}kept`)
    }
  })

  it('reads a literal containing a paren and the word is', () => {
    expect(text(render('(set: $v to "a is b)c")(if: $v is "a is b)c")[ok]'))).toBe('p:ok')
  })
})

describe('chains', () => {
  it('runs exactly one branch of an if / else-if / else', () => {
    const body = '(set: $v to "b")(if: $v is "a")[A](else-if: $v is "b")[B](else:)[C]'
    expect(text(render(body))).toBe('p:B')
  })

  it('skips a later else-if once a branch has run', () => {
    const body = '(set: $v to "a")(if: $v is "a")[A](else-if: $v is "a")[again]'
    expect(text(render(body))).toBe('p:A')
  })

  it('keeps two adjacent ifs independent', () => {
    const body = '(set: $v to "a")(if: $v is "a")[one](if: $v is "a")[two]'
    expect(text(render(body))).toBe('p:onetwo')
  })

  it('shows both branches when the first is unreadable, and marks both', () => {
    // Prose repeated, never prose eaten. Marking only the first would leave the
    // branch this understood least looking the most authoritative.
    const result = render('(if: $v > 3)[one](else:)[two]')
    expect(text(result)).toBe('p:{if}one{else}two')
    expect(result.blocks[0]!.inlines.every((n) => n.uncertain || n.kind === 'unsupported')).toBe(true)
  })

  it('leaves a readable chain unmarked', () => {
    const result = render('(set: $v to "a")(if: $v is "a")[one](else:)[two]')
    expect(text(result)).toBe('p:one')
    expect(result.blocks[0]!.inlines.every((n) => !n.uncertain)).toBe(true)
  })

  it('shows an orphan else, marked', () => {
    expect(text(render('words (else:)[y]'))).toBe('p:words {else}y')
  })

  it('gives a nested chain its own state', () => {
    const body = '(set: $a to "1")(set: $b to "9")(if: $a is "1")[outer (if: $b is "1")[in](else:)[out] done]'
    expect(text(render(body))).toBe('p:outer out done')
  })
})

describe('what does not run', () => {
  it('does not run a set inside a false hook', () => {
    // The headline: a flat pass over `parseMacros` would set `$flag` here.
    const result = render('(if: $never is "x")[(set: $flag to "on")]after')
    expect(text(result)).toBe('p:after')
    expect(result.assigned).toEqual([])
    expect(vars(result)).toEqual([])
  })

  it('does run a set inside a true hook', () => {
    const result = render('(set: $k to "y")(if: $k is "y")[(set: $flag to "on")]after')
    expect(vars(result)).toEqual(['$flag=on', '$k=y'])
  })

  it('does not execute a macro sitting in another macro arguments', () => {
    // `parseMacros` yields the operand as well as the macro containing it; the
    // cursor never lands inside an argument list to meet it.
    const result = render('(print: (set: $v to "x"))tail')
    expect(vars(result)).toEqual([])
    expect(text(result)).toBe('p:{print}tail')
  })

  it('ignores the phantom macro a string literal can hold', () => {
    // `MACRO_OPEN` scans quotes too, so this body yields a bogus `if`.
    const result = render('(set: $v to "(if: x)")\n(set: $k to "y")')
    expect(vars(result)).toEqual(['$k=y', '$v=(if: x)'])
  })

  it('records a set inside an unreadable branch as unreadable, not as its literal', () => {
    // Otherwise a guess becomes a confident value, and a confident value hides
    // the other branch of the next condition.
    const result = render('(if: $unknown > 3)[(set: $flag to "yes")](if: $flag is "yes")[loud](else:)[quiet]')
    expect(vars(result)).toEqual(['$flag=?'])
    expect(text(result)).toBe('p:{if}{if}loud{else}quiet')
  })

  it('shows an unterminated hook rather than hiding it', () => {
    // `closeHook` fails, so the walk would otherwise stroll in as plain text
    // and run the set under a condition that came out false.
    const result = render('(if: $no is "y")[(set: $v to "y") kept')
    expect(text(result)).toBe('p:{if} kept')
    expect(vars(result)).toEqual(['$v=?'])
  })

  it('executes nothing inside an unterminated macro opener', () => {
    // `parseMacros` drops the outer macro, so nothing is indexed at its `(`
    // and the walk would otherwise stroll into its arguments and run them.
    const result = render('(unknown: (set: $v to "x")')
    expect(vars(result)).toEqual([])
    expect(result.unsupported).toEqual(['set', 'unknown'])
  })

  it('keeps a bracketed aside that follows a set', () => {
    // Consuming an attached body after `(set:)` would swallow this silently.
    expect(text(render('(set: $v to "x")\n[An aside.]'))).toBe('p:An aside.')
  })
})

describe('links and choices', () => {
  it('agrees with parseLinks on ordinals when a body holds an unusable link', () => {
    const body = '[[]]\n[[A|P1]] and [[B|P2]]'
    expect(render(body).choices.map((c) => c.ordinal)).toEqual(
      parseLinks(body).map((l) => l.ordinal),
    )
  })

  it('leaves a gap in choices for a hidden link, and keeps the rest aligned', () => {
    const body = '(if: $no is "y")[ [[A|P1]] ](else:)[ [[B|P2]] ]'
    expect(render(body).choices).toEqual([
      { ordinal: 1, label: 'B', target: 'P2', uncertain: false },
    ])
  })

  it('reads all four Twine link forms', () => {
    const body = '[[P1]] [[Go|P2]] [[Go->P3]] [[P4<-Go]]'
    expect(render(body).choices.map((c) => `${c.label}->${c.target}`)).toEqual([
      'P1->P1',
      'Go->P2',
      'Go->P3',
      'Go->P4',
    ])
  })

  it('offers a self-link and a back edge, which a reader really can take', () => {
    // `forwardTargets` deliberately excludes both; a reader can loop.
    expect(render('[[Stay|P1]] [[Back|P0]]').choices.map((c) => c.target)).toEqual(['P1', 'P0'])
  })

  it('keys choices the way the graph keys its edges', () => {
    const doc = docFrom({ One: ['Two', 'Three'] })
    const start = doc.nodes.find((n) => n.title === 'One')!
    const edges = new Set(deriveGraph(doc).edges.map((e) => e.id))
    for (const choice of render(start.body).choices) {
      expect(edges.has(`${start.id}|${choice.ordinal}`)).toBe(true)
    }
  })
})

describe('unsupported macros and asks', () => {
  it('reports an unknown macro once and loses no surrounding prose', () => {
    const result = render('before (cycling-link: "a", "b") after')
    expect(text(result)).toBe('p:before {cycling-link} after')
    expect(result.unsupported).toEqual(['cycling-link'])
  })

  it('renders an unknown macro hook rather than eating it', () => {
    expect(text(render('before (hidden:)[secret] after'))).toBe('p:before {hidden}secret after')
  })

  it('darkens the variables an unknown macro names, so a later condition shows', () => {
    // Left merely absent, `$name` would compare false and the hook would be
    // hidden — failing closed by accident, in the one layer that must not.
    const body = '(input-box: bind $name, "=XX=")(if: $name is "Mira")[known](else:)[stranger]'
    const result = render(body)
    expect(text(result)).toBe('p:{input-box}{if}known{else}stranger')
    expect(vars(result)).toEqual(['$name=?'])
  })

  it('reads print of a variable and of a literal', () => {
    expect(text(render('(set: $v to "lit")(print: $v) and (print: "raw")'))).toBe(
      'p:<$v=lit> and raw',
    )
    expect(text(render('(print: $v + "x")'))).toBe('p:{print}')
  })

  it('refuses move and unpack, whose operands it will not read', () => {
    const result = render('(move: $a into $b)')
    expect(vars(result)).toEqual(['$a=?', '$b=?'])
    expect(result.unsupported).toEqual(['move'])
  })

  it('keeps an authorial aside whole, since any (word:) reads as a macro', () => {
    // The chip's `source` is load-bearing, not a hover nicety: rendering only
    // the name would delete the author's sentence.
    const result = render('He lied (Note: he always lies) and left.')
    const chip = result.blocks[0]!.inlines.find((n) => n.kind === 'unsupported')
    expect(chip).toMatchObject({ name: 'note', source: '(Note: he always lies)' })
  })

  it('lists unsupported names distinctly, in codepoint order', () => {
    const result = render('(zeta:)(alpha:)(zeta:)')
    expect(result.unsupported).toEqual(['alpha', 'zeta'])
  })

  it('reports a bound input as an ask, without inventing a prompt', () => {
    // `(input-box:)`'s first string is its size pattern and `(dropdown:)`'s is
    // its first option, so a first-string heuristic would show the reader a
    // layout spec where a question belongs.
    const result = render('(input-box: bind $name, "=XX=", 3, "Who are you?")')
    expect(result.asks).toEqual([
      { kind: 'bind', variable: '$name', message: '', default: null, answer: null },
    ])
    expect(result.pending).toBeNull()
  })
})

describe('prompts', () => {
  const ask = (body: string, answers: string[] = [], carried?: [string, string | null][]) =>
    renderPassage(body, new Map(carried ?? []), answers)

  const NAME = '(set: $name to (prompt: "Your name?", "Daniel"))'

  it('stops at an unanswered prompt, with only what came before it', () => {
    const result = ask(`Before. [[Early|P1]]\n${NAME}Hello $name. (set: $after to "x")[[Late|P2]]`)
    expect(result.pending).toEqual({
      variable: '$name',
      message: 'Your name?',
      default: 'Daniel',
      cancel: 'Cancel',
      confirm: 'OK',
    })
    expect(text(result)).toBe('p:Before. [Early->P1]')
    expect(result.choices.map((c) => c.target)).toEqual(['P1'])
    // Nothing past the prompt ran — not the write, not the link.
    expect(vars(result)).toEqual([])
    // A pending prompt is not yet an ask; it has not been answered or refused.
    expect(result.asks).toEqual([])
  })

  it('reads the example as written, with no spaces after the colons', () => {
    const result = ask('(set:$myName to (prompt:"What is your name", "Daniel"))')
    expect(result.pending).toMatchObject({ variable: '$myName', message: 'What is your name', default: 'Daniel' })
  })

  it('assigns the answer, prints it, and lets a condition read it', () => {
    const body = `${NAME}Hello $name.(if: $name is "Daniel")[ Welcome back.](else:)[ Welcome.]`
    const result = ask(body, ['Daniel'])
    expect(result.pending).toBeNull()
    expect(text(result)).toBe('p:Hello <$name=Daniel>. Welcome back.')
    expect(vars(result)).toEqual(['$name=Daniel'])
    expect(result.assigned).toEqual([{ variable: '$name', value: 'Daniel' }])
    expect(result.asks).toEqual([
      { kind: 'prompt', variable: '$name', message: 'Your name?', default: 'Daniel', answer: 'Daniel' },
    ])
    expect(text(ask(body, ['Mira']))).toBe('p:Hello <$name=Mira>. Welcome.')
  })

  it('takes an empty answer as an answer', () => {
    expect(vars(ask(NAME, ['']))).toEqual(['$name='])
  })

  it('asks several prompts in the order they are reached', () => {
    const body = '(set: $a to (prompt: "A?", "1"))$a (set: $b to (prompt: "B?", "2"), $c to (prompt: "C?", "3"))$b$c'
    expect(ask(body).pending?.message).toBe('A?')
    expect(ask(body, ['x']).pending?.message).toBe('B?')
    expect(ask(body, ['x', 'y']).pending?.message).toBe('C?')
    const done = ask(body, ['x', 'y', 'z', 'unused'])
    expect(done.pending).toBeNull()
    expect(text(done)).toBe('p:<$a=x> <$b=y><$c=z>')
  })

  it('reads the labels in Harlowe\'s order: cancel, then confirm', () => {
    const labelled = ask('(set: $n to (prompt: "Q", "d", "Never mind", "Go"))').pending
    expect(labelled).toMatchObject({ cancel: 'Never mind', confirm: 'Go' })
    // `""` hides Cancel; a blank confirm is an error in Harlowe, so it keeps "OK".
    const bare = ask('(set: $n to (prompt: "Q", "d", "", ""))').pending
    expect(bare).toMatchObject({ cancel: null, confirm: 'OK' })
  })

  it('offers a known variable as the default', () => {
    const carried: [string, string | null][] = [['$name', 'Mira']]
    expect(ask('(set: $name to (prompt: "Again?", $name))', [], carried).pending?.default).toBe('Mira')
  })

  it('never asks a prompt whose default it cannot read, since Cancel must return it', () => {
    for (const body of ['(set: $n to (prompt: "Q"))', '(set: $n to (prompt: "Q", $unset))', '(set: $n to (prompt: "Q", 3))']) {
      const result = ask(body)
      expect(result.pending).toBeNull()
      expect(vars(result)).toEqual(['$n=?'])
      expect(result.asks).toMatchObject([{ kind: 'prompt', variable: '$n', answer: null }])
    }
  })

  it('never asks inside a false branch', () => {
    const result = ask(`(if: $door is "open")[${NAME}]after`)
    expect(result.pending).toBeNull()
    expect(result.asks).toEqual([])
    expect(text(result)).toBe('p:after')
  })

  it('asks inside a true branch, and resumes the chain from the top', () => {
    const body = `(set: $door to "open")(if: $door is "open")[${NAME}$name](else:)[shut]`
    expect(ask(body).pending?.variable).toBe('$name')
    expect(text(ask(body, ['Mira']))).toBe('p:<$name=Mira>')
  })

  it('never asks inside an unreadable branch, and darkens what it would have set', () => {
    // Harlowe may never reach it, so asking would put a question the story
    // does not; and a speculative write is darkened regardless.
    const result = ask(`(if: $n > 3)[${NAME}]after`)
    expect(result.pending).toBeNull()
    expect(vars(result)).toEqual(['$name=?'])
    expect(result.asks).toMatchObject([{ kind: 'prompt', variable: '$name', answer: null }])
    expect(text(result)).toBe('p:{if}after')
  })

  it('takes a prompt only when it is the whole right-hand side, and says so otherwise', () => {
    // Taking the prompt out would assign the answer without the suffix. Not
    // asking is the fail-open answer, and the ask is what tells the author.
    const result = ask('(set: $n to (prompt: "Q", "d") + "!")')
    expect(result.pending).toBeNull()
    expect(vars(result)).toEqual(['$n=?'])
    expect(result.asks).toEqual([
      { kind: 'prompt', variable: '$n', message: '', default: null, answer: null },
    ])
  })

  it('reports a prompt it cannot run even where its answer goes nowhere nameable', () => {
    const unread = (body: string) => ask(body).asks.map((a) => `${a.kind}:${a.variable}:${a.answer}`)
    expect(unread('(print: (prompt: "Q", "d"))')).toEqual(['prompt:null:null'])
    expect(unread('Who? (prompt: "Q", "d") then')).toEqual(['prompt:null:null'])
    expect(unread('(if: (prompt: "Q", "d") is "x")[yes]')).toEqual(['prompt:null:null'])
    // An `(else-if:)` after a settled branch is never evaluated, so never asks.
    expect(unread('(if: $u is not "z")[a](else-if: (prompt: "Q", "d") is "x")[b]')).toEqual([])
    // A prompt in a string is prose, not a call.
    expect(unread('(print: "(prompt: nothing)")')).toEqual([])
  })

  it('needs no space after to, as Harlowe does not', () => {
    expect(ask('(set:$a to(prompt:"Q","d"))').pending?.variable).toBe('$a')
    expect(vars(render('(set: $a to"x")'))).toEqual(['$a=x'])
    // The lookahead is what keeps a word that merely starts with `to` out.
    expect(vars(render('(set: $a tomato "x")'))).toEqual(['$a=?'])
  })

  it('offers the default as it stood before the set began', () => {
    // Harlowe evaluates every argument before it assigns any, so the part to
    // the prompt's left has not yet written `$a` when the default is read.
    const body = '(set: $a to "x", $b to (prompt: "Q", $a))'
    expect(ask(body, [], [['$a', 'old']]).pending?.default).toBe('old')
    expect(vars(ask(body, ['typed'], [['$a', 'old']]))).toEqual(['$a=x', '$b=typed'])
  })

  it('reads put and temps the same way', () => {
    expect(ask('(put: (prompt: "Q", "d") into $v)').pending?.variable).toBe('$v')
    expect(ask('(put: (prompt: "Q", "d")into $v)').pending?.variable).toBe('$v')
    expect(vars(render('(put: "x"into $v)'))).toEqual(['$v=x'])
    const temp = ask('(set: _t to (prompt: "Q", "d"))_t', ['typed'])
    expect(text(temp)).toBe('p:<_t=typed>')
    // Temps stay in the passage.
    expect(vars(temp)).toEqual([])
  })

  it('shows a message it cannot read as it was written', () => {
    expect(ask('(set: $n to (prompt: [Who is there?], "d"))').pending?.message).toBe('[Who is there?]')
  })

  it('never prompts inside malformed source, where nothing runs', () => {
    const result = ask(`(note: unclosed ${NAME}`)
    expect(result.pending).toBeNull()
  })
})

describe('regressions', () => {
  it('needs the styler closer inside the span, not anywhere in the body', () => {
    // An unrelated `//x//` further down would otherwise let the `//` of a URL
    // open an emphasis that swallows everything between the two.
    const result = render('[see https://a.com] then //x//')
    expect(text(result)).toBe('p:see https://a.com then x')
    const inlines = result.blocks[0]!.inlines
    expect(inlines.filter((n) => n.kind === 'text' && n.text.includes('https'))).toHaveLength(1)
    expect(inlines.every((n) => n.italic === (n.kind === 'text' && n.text === 'x'))).toBe(true)
  })

  it('does not let a styler opened in a hook outlive it', () => {
    // Formatting survives a link or a macro on purpose; it must not survive the
    // hook that opened it, or the author's real markers go unread.
    expect(text(render("[start ''here] plain ''end''"))).toBe("p:start ''here plain end")
    const inlines = render("[start ''here] plain ''end''").blocks[0]!.inlines
    expect(inlines.at(-1)).toMatchObject({ text: 'end', bold: true })
    expect(inlines[0]).toMatchObject({ bold: false })
  })

  it('keeps reading past an unterminated opener, so links are not stranded', () => {
    // One typo'd paren used to make the passage a dead end in the reader while
    // the map still drew edges out of it.
    const result = render('a [[One|P1]] (bad: oops\n[[Two|P2]]')
    expect(result.choices.map((c) => c.target)).toEqual(['P1', 'P2'])
    expect(result.choices[1]).toMatchObject({ uncertain: true })
  })

  it('runs nothing after an unterminated opener', () => {
    // Reading on is only safe because execution is frozen for the remainder.
    const result = render('(note: unclosed\n(set: $v to "x")$v')
    expect(vars(result)).toEqual([])
    expect(text(result)).toBe('p:{note} unclosed\n{set}<$v=unset>')
  })

  it('keeps a back-tagged branch in its chain', () => {
    // `attachedEnd` stops where this does, so `chainsOf` sees one chain. A
    // drift there showed both halves of an either-or at once.
    expect(text(render('(set: $v to "a")(if: $v is "a")[A]<t|(else:)[B]'))).toBe('p:A')
  })

  it('does not darken a variable an unknown macro merely reads', () => {
    // Fail-open licenses pushing a *condition* to unreadable. It does not
    // license replacing a value in the prose, or reporting a write that never
    // happened in the debug console.
    const result = render('(set: $name to "Mira")(text-colour: $name)[hi] $name')
    expect(text(result)).toBe('p:{text-colour}hi <$name=Mira>')
    expect(result.assigned).toEqual([{ variable: '$name', value: 'Mira' }])
  })

  it('keeps the spacing a verbatim span exists to keep', () => {
    // One space at each end, which is what lets a backtick sit against the
    // fence — not a full trim.
    expect(text(render('`  keep  spacing  `'))).toBe('p: keep  spacing ')
  })

  it('does not read the word bind out of an author string', () => {
    const result = render('(link: "bind $rope to the post")')
    expect(result.asks).toEqual([])
    expect(vars(result)).toEqual([])
  })

  it('settles a chain on a true condition even with no hook to render', () => {
    // One of the few paths where this could state something false rather than
    // merely show too much: the else has provably not been chosen.
    expect(text(render('(set: $v to "x")(if: $v is "x")(else:)[B]'))).toBe('')
  })

  it('does not read block markup back out of a printed value', () => {
    // Harlowe re-parses the output of `(display:)`, not of `(print:)`.
    expect(text(render('(print: "> not a quote")'))).toBe('p:> not a quote')
  })

  it('marks a choice that only an unreadable region offered', () => {
    // The caller acts on `choices`, so the marker has to reach it there too.
    const result = render('(hidden:)[ [[A|P1]] ] then [[B|P2]]')
    expect(result.choices.map((c) => `${c.target}${c.uncertain ? '?' : ''}`)).toEqual([
      'P1?',
      'P2',
    ])
  })

  it('lists a dropped macro under its own name', () => {
    // `unsupported` is documented as macro names; a two-word phrase is not one.
    expect(render('(note: unclosed').unsupported).toEqual(['note'])
  })
})

describe('safety and shape', () => {
  it('yields markup in the body as text and nothing else', () => {
    const result = render('a <script>alert(1)</script> b')
    expect(result.blocks[0]!.inlines.every((n) => n.kind === 'text')).toBe(true)
    expect(text(result)).toBe('p:a <script>alert(1)</script> b')
  })

  it('carries a markup-bearing value only as a variable value', () => {
    const result = render('$v', [['$v', '<img onerror=x>']])
    expect(result.blocks[0]!.inlines).toEqual([
      {
        kind: 'variable',
        name: '$v',
        value: '<img onerror=x>',
        state: 'set',
        bold: false,
        italic: false,
        uncertain: false,
      },
    ])
    expect(result.blocks[0]!.inlines.every((n) => n.kind !== 'text')).toBe(true)
  })

  it('returns empty everything for an empty body', () => {
    expect(render('')).toEqual({
      blocks: [],
      choices: [],
      vars: new Map(),
      assigned: [],
      asks: [],
      unsupported: [],
      pending: null,
    })
  })
})
