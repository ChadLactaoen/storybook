import { describe, expect, it } from 'vitest'
import { deriveGraph } from '../lib/graph/derive'
import { parseLinks } from '../lib/harlowe/links'
import {
  attachedEnd,
  chainsOf,
  closeHook,
  guardsByOrdinal,
  parseAssignments,
  parseGuardSpans,
  parseMacros,
  readStoryMacros,
  splitArgs,
  stringValue,
  VARIABLE_RE,
} from '../lib/harlowe/macros'
import { docFrom } from './helpers'

/** Guard per link target, which is what the reader of this file cares about. */
function guards(body: string): Record<string, string> {
  const links = parseLinks(body)
  const byOrdinal = guardsByOrdinal(body, links)
  const out: Record<string, string> = {}
  for (const link of links) {
    const g = byOrdinal.get(link.ordinal)
    out[link.target] = g ? `${g.variable}=${g.value}` : '—'
  }
  return out
}

describe('reading link guards', () => {
  it('reads a guard written with no hook around the link', () => {
    // The form in the wild: the author wrote `[[` directly after the macro, so
    // both brackets belong to the link and there is no hook in the source.
    expect(guards('(if:$idolChosen is "Sakura")[[Continue|11]]')).toEqual({
      '11': 'idolChosen=Sakura',
    })
  })

  it('reads a guard written with a hook around the link', () => {
    expect(guards('(if: $idolChosen is "Sakura")[ [[Continue|11]] ]')).toEqual({
      '11': 'idolChosen=Sakura',
    })
  })

  it('reads a whole else-if chain, one guard per link', () => {
    // An else-if only runs when the earlier tests failed, but its own condition
    // is still necessary to take the branch — and necessity is all a gate needs.
    const body = [
      '(if:$idol is "Chaewon")[[Continue|10]]',
      '(else-if:$idol is "Sakura")[[Continue|11]]',
      '(else-if:$idol is "Yunjin")[[Continue|12]]',
    ].join('\n')
    expect(guards(body)).toEqual({
      '10': 'idol=Chaewon',
      '11': 'idol=Sakura',
      '12': 'idol=Yunjin',
    })
  })

  it('gates every link inside one hook', () => {
    expect(guards('(if: $v is "x")[ [[A|1]] and [[B|2]] ]')).toEqual({
      '1': 'v=x',
      '2': 'v=x',
    })
  })

  it('lets a hook span a newline', () => {
    expect(guards('(if: $v is "x")\n[\n[[A|1]]\n]')).toEqual({ '1': 'v=x' })
  })

  it('refuses a negated condition rather than reading it backwards', () => {
    // Searching for `$v is "x"` inside the arguments would return exactly the
    // one value the route provably does not have.
    expect(guards('(if: $v is not "x")[[A|1]]')).toEqual({ '1': '—' })
  })

  it('refuses a compound condition', () => {
    // `or` makes neither side necessary; `and` makes both, but reading one of
    // them is precision this deliberately does not chase.
    expect(guards('(if: $v is "p" or $v is "q")[[A|1]]')).toEqual({ '1': '—' })
    expect(guards('(if: $a is "p" and $b is "q")[[A|1]]')).toEqual({ '1': '—' })
  })

  it('refuses unless, which reads the same and means the opposite', () => {
    expect(guards('(unless: $v is "x")[[A|1]]')).toEqual({ '1': '—' })
  })

  it('refuses else, which carries no condition of its own', () => {
    expect(guards('(if: $v is "x")[ [[A|1]] ](else:)[ [[B|2]] ]')).toEqual({
      '1': 'v=x',
      '2': '—',
    })
  })

  it('leaves an unguarded link alone', () => {
    expect(guards('(set: $v to "x")\n\n[[A|1]]')).toEqual({ '1': '—' })
  })

  it('takes the innermost of two nested guards', () => {
    // Either is necessary, so either is sound; the inner one is the sharper.
    expect(guards('(if: $a is "p")[ (if: $b is "q")[ [[A|1]] ] ]')).toEqual({ '1': 'b=q' })
  })

  it('is not fooled by brackets inside a string', () => {
    expect(guards('(if: $v is "a]b")[ [[A|1]] ]')).toEqual({ '1': 'v=a]b' })
  })

  it('is not fooled by a paren inside a string', () => {
    expect(guards('(if: $v is "a)b")[ [[A|1]] ]')).toEqual({ '1': 'v=a)b' })
  })

  it('keeps guards aligned when a body holds an unusable link', () => {
    // `[[]]` is not a link and never takes an ordinal, so anything counting
    // brackets here would gate the wrong edge from this point on.
    const body = '[[]]\n(if: $v is "x")[[A|1]]'
    expect(guards(body)).toEqual({ '1': 'v=x' })
  })

  it('reports a guard that has no link after it as covering nothing', () => {
    expect(parseGuardSpans('(if: $v is "x") just prose')).toEqual([])
  })
})

describe('reading assignments', () => {
  const read = (body: string) => {
    const { literal, opaque } = parseAssignments(body)
    return {
      literal: literal.map((a) => `${a.variable}=${a.value}`),
      opaque: [...opaque].sort(),
    }
  }

  it('reads a set to a string literal', () => {
    expect(read('(set:$idolChosen to "Sakura")')).toEqual({
      literal: ['idolChosen=Sakura'],
      opaque: [],
    })
  })

  it('reads several assignments in one macro', () => {
    expect(read('(set: $a to "x", $b to "y")')).toEqual({
      literal: ['a=x', 'b=y'],
      opaque: [],
    })
  })

  it('splits on commas outside the nested call, not inside it', () => {
    expect(read('(set: $a to (max: 1, 2), $b to "y")')).toEqual({
      literal: ['b=y'],
      opaque: ['a'],
    })
  })

  it('calls a computed value unreadable rather than guessing at it', () => {
    // Every one of these is a way of giving a variable a value that this
    // parser cannot follow, and a gate is only sound if every way is seen.
    expect(read('(set: $v to it + "a")').opaque).toEqual(['v'])
    expect(read('(set: $v to $other)').opaque).toEqual(['v'])
    expect(read('(set: $v to _tmp)').opaque).toEqual(['v'])
  })

  it('calls put and move unreadable, operands being the other way round', () => {
    expect(read('(put: "Sakura" into $idolChosen)')).toEqual({
      literal: [],
      opaque: ['idolChosen'],
    })
    expect(read('(move: $a into $b)').opaque).toEqual(['a', 'b'])
  })

  it('ignores a temp variable, which no gate can be built on anyway', () => {
    expect(read('(set: _tmp to "x")')).toEqual({ literal: [], opaque: [] })
  })

  it('is not fooled by a close paren inside the value', () => {
    expect(read('(set: $v to "a)b")')).toEqual({ literal: ['v=a)b'], opaque: [] })
  })

  it('reads the assignments a real passage carries alongside its links', () => {
    const body = [
      'Hero chooses to meet Sakura.',
      '',
      '[[Suggest a coffee shop|7]]',
      '',
      '(set:$idolChosen to "Sakura")',
    ].join('\n')
    expect(read(body)).toEqual({ literal: ['idolChosen=Sakura'], opaque: [] })
  })
})

describe('reading macro spans', () => {
  const spans = (body: string) => parseMacros(body).map((m) => `${m.name}@${m.start}-${m.end}`)

  it('locates one macro end to end', () => {
    expect(parseMacros('(set: $v to "x")')).toEqual([
      { name: 'set', args: ' $v to "x"', start: 0, argsStart: 5, end: 16 },
    ])
  })

  it('keeps args, argsStart and end agreeing', () => {
    // The positions exist so a caller can walk these as statements. A field
    // that can drift from `args` would be worse than not having it.
    for (const body of [
      '(set: $v to "x")',
      'prose (if: $v is "x")[A] more',
      '(  else :  )',
      '(set: $v to "a)b")',
    ]) {
      for (const m of parseMacros(body)) {
        expect(m.args).toBe(body.slice(m.argsStart, m.end - 1))
        expect(body[m.start]).toBe('(')
        expect(body[m.end - 1]).toBe(')')
      }
    }
  })

  it('yields a macro nested in another argument list, told apart by start', () => {
    // Deliberate: `(if: (not: $x))` must yield both. It is also the trap — an
    // evaluator treating every entry as a statement would run the operand.
    const body = '(if: (not: $x))[A]'
    expect(spans(body)).toEqual(['if@0-15', 'not@5-14'])
    const [outer, inner] = parseMacros(body)
    expect(inner!.start).toBeLessThan(outer!.end)
  })

  it('reads a macro with no arguments at all', () => {
    expect(parseMacros('(else:)')[0]).toMatchObject({ name: 'else', args: '' })
  })

  it('reads a hyphenated name', () => {
    expect(parseMacros('(else-if: $v is "x")')[0]).toMatchObject({ name: 'else-if' })
  })

  it('is not fooled by a paren inside a string', () => {
    expect(spans('(set: $v to "a)b")')).toEqual(['set@0-18'])
  })

  it('drops a macro whose parens never close', () => {
    // `chainsOf` assumes every entry is well formed, so this is worth pinning.
    expect(parseMacros('(if: $v is "x"')).toEqual([])
  })
})

describe('finding what a macro attaches to', () => {
  /** What is left of the body once the first macro and its hook are crossed. */
  const after = (body: string) => body.slice(attachedEnd(body, parseMacros(body)[0]!.end))

  it('crosses a hook', () => {
    expect(after('(if: $v is "x")[A]\ntail')).toBe('\ntail')
  })

  it('crosses a bare link written instead of a hook', () => {
    // The reason this helper exists: `closeHook` jumps `[[`..`]]` wholesale, so
    // on a link standing where a hook would be it runs off the end and fails.
    expect(after('(if: $v is "x")[[A|P2]]\ntail')).toBe('\ntail')
    expect(closeHook('[[A|P2]]', 0)).toBe(-1)
  })

  it('crosses whitespace and newlines between the macro and its hook', () => {
    expect(after('(if: $v is "x")\n\n  [A]tail')).toBe('tail')
  })

  it('stops at the macro when nothing attaches', () => {
    expect(after('(if: $v is "x") prose')).toBe(' prose')
  })

  it('crosses a hook name tag on either side', () => {
    expect(after('(if: $v is "x")|t>[A]\ntail')).toBe('\ntail')
    expect(after('(if: $v is "x")[A]<t|\ntail')).toBe('\ntail')
  })

  it('stops at the macro when the hook never closes', () => {
    // Leaves the `[` in what the caller reads next, which breaks a chain rather
    // than joining one on the strength of text nobody could parse.
    expect(after('(if: $v is "x")[A')).toBe('[A')
  })
})

describe('reading macro chains', () => {
  /** Each branching macro as `chain.position kind`, in source order. */
  function chains(body: string): string[] {
    const macros = parseMacros(body)
    const slots = chainsOf(body, macros)
    return macros.flatMap((m) => {
      const slot = slots.get(m.start)
      return slot ? [`${slot.chainId}.${slot.position} ${slot.kind}`] : []
    })
  }

  it('reads if, else-if and else as one chain', () => {
    const body = '(if: $a is "p")[x](else-if: $a is "q")[y](else:)[z]'
    expect(chains(body)).toEqual(['0.0 if', '0.1 else-if', '0.2 else'])
  })

  it('reads unless and else as one chain', () => {
    // `(unless:)` is unread as a *guard* — it means the opposite of what it
    // looks like — but it opens a chain exactly as `(if:)` does.
    expect(chains('(unless: $a is "p")[x]\n(else:)[z]')).toEqual(['0.0 unless', '0.1 else'])
  })

  it('reads two adjacent ifs as two chains, not one', () => {
    // Each carries its own test, so they are independent however tightly
    // packed. Chaining them would make the second hide when the first ran.
    expect(chains('(if: $a is "p")[x](if: $b is "q")[y]')).toEqual(['0.0 if', '1.0 if'])
  })

  it('opens a new chain for an unless following an if', () => {
    expect(chains('(if: $a is "p")[x](unless: $b is "q")[y]')).toEqual(['0.0 if', '1.0 unless'])
  })

  it('breaks a chain on prose between the branches', () => {
    expect(chains('(if: $a is "p")[x] words (else:)[z]')).toEqual(['0.0 if', '1.0 else'])
  })

  it('breaks a chain on a macro between the branches', () => {
    const body = '(if: $a is "p")[x](set: $b to "q")(else:)[z]'
    expect(chains(body)).toEqual(['0.0 if', '1.0 else'])
  })

  it('keeps the branches adjacent across a bare link', () => {
    const body = '(if: $a is "p")[[A|P2]]\n(else:)[[B|P3]]'
    expect(chains(body)).toEqual(['0.0 if', '0.1 else'])
  })

  it('treats a macro in the arguments as neither a branch nor a break', () => {
    // Without the operand filter the `(else:)` measures itself against
    // `(not:)`, which opens nothing, and every chain with a computed condition
    // silently breaks.
    const body = '(if: (not: $x))[a]\n(else:)[b]'
    expect(chains(body)).toEqual(['0.0 if', '0.1 else'])
    expect(chainsOf(body).size).toBe(2)
    expect(chainsOf(body).get(5)).toBeUndefined()
  })

  it('ignores the phantom macro a string literal can produce', () => {
    // `MACRO_OPEN` scans the whole body, quotes included.
    const body = '(set: $v to "(if: x)")\n(if: $a is "p")[x](else:)[y]'
    expect(chains(body)).toEqual(['0.0 if', '0.1 else'])
  })

  it('gives a chain inside a hook its own id', () => {
    const body = '(if: $a is "p")[ (if: $b is "q")[X] (else:)[Y] ]'
    expect(chains(body)).toEqual(['0.0 if', '1.0 if', '1.1 else'])
  })

  it('lets a trailing else find its opener past a nested chain', () => {
    // The case a single "previous branch" variable gets wrong: the inner
    // `(else:)` belongs to the inner `(if:)`, and the outer one to the outer.
    const body = '(if: $a is "p")[ (if: $b is "q")[X] (else:)[Y] ]\n(else:)[Z]'
    expect(chains(body)).toEqual(['0.0 if', '1.0 if', '1.1 else', '0.1 else'])
  })

  it('gives an orphan else a chain of its own at position 0', () => {
    expect(chains('words (else:)[y]')).toEqual(['0.0 else'])
  })

  it('ends a chain at else, so a later else-if starts a new one', () => {
    const body = '(if: $a is "p")[x](else:)[y](else-if: $a is "q")[z]'
    expect(chains(body)).toEqual(['0.0 if', '0.1 else', '1.0 else-if'])
  })

  it('lets newlines sit between a macro, its hook and the next branch', () => {
    expect(chains('(if: $a is "p")\n\n[x]\n\n(else:)[y]')).toEqual(['0.0 if', '0.1 else'])
  })

  it('is not fooled by a bracket inside a string', () => {
    expect(chains('(if: $v is "a]b")[x](else:)[y]')).toEqual(['0.0 if', '0.1 else'])
  })

  it('keeps a chain across a hook name tag on either side', () => {
    // `(if: …)[…]<name|` is idiomatic — the tag is what a later `(replace:)`
    // aims at. Stopping at the `]` would leave `<t|` between the branches, and
    // the reader would show both halves of an either-or at once.
    expect(chains('(if: $v is "a")[x]<t|(else:)[y]')).toEqual(['0.0 if', '0.1 else'])
    expect(chains('(if: $v is "a")|t>[x](else:)[y]')).toEqual(['0.0 if', '0.1 else'])
  })

  it('keys every slot by the macro start, in source order', () => {
    // Iteration order is load-bearing across this repo, and the key is what
    // the evaluator looks a macro up by while walking spans.
    const body = '(if: $a is "p")[x](else:)[y]'
    const starts = parseMacros(body).map((m) => m.start)
    expect([...chainsOf(body).keys()]).toEqual(starts)
  })
})

describe('the primitives the evaluator shares', () => {
  it('reads a hook containing a link, and refuses a bare one', () => {
    // The one genuinely hard case in the module, and the reason there must
    // never be a second copy of `closeHook`.
    expect(closeHook('[ [[A|P1]] ]tail', 0)).toBe(12)
    expect(closeHook('[[A|P1]]', 0)).toBe(-1)
  })

  it('splits arguments at depth zero only', () => {
    expect(splitArgs('$a to "x", $b to (max: 1, 2)')).toEqual([
      '$a to "x"',
      ' $b to (max: 1, 2)',
    ])
  })

  it('reads one literal, escapes honoured, and refuses two', () => {
    expect(stringValue('"a\\"b"')).toBe('a"b')
    expect(stringValue('"a" "b"')).toBeNull()
  })

  it('survives a poisoned lastIndex under match', () => {
    // `VARIABLE_RE` carries `g`, so exporting it exposes `lastIndex` to every
    // consumer. `parseAssignments` reads it through `match`, which resets that
    // first — the property that keeps the gate path immune.
    VARIABLE_RE.lastIndex = 99
    expect('$a and $b'.match(VARIABLE_RE)).toEqual(['$a', '$b'])
    expect(VARIABLE_RE.lastIndex).toBe(0)
  })
})

describe('reading a whole story', () => {
  it('keys guards the way the graph keys its edges', () => {
    // This layer builds `${id}|${ordinal}` itself rather than depend on the
    // graph. If the two ever drift, a guard lands on the wrong edge and the
    // gate states something false — so the agreement is asserted, not assumed.
    const doc = docFrom({ One: ['Two', 'Three'], Two: [], Three: [] })
    const one = doc.nodes[0]!
    const withMacros = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === one.id
          ? { ...n, body: `(if: $v is "x")[[Go|P2]]\n(if: $v is "y")[[Go|P3]]` }
          : n,
      ),
    }

    const { guardOf } = readStoryMacros(withMacros.nodes)
    const g = deriveGraph(withMacros)
    expect([...guardOf.keys()].sort()).toEqual([`${one.id}|0`, `${one.id}|1`])
    for (const key of guardOf.keys()) expect(g.edgeById.has(key)).toBe(true)
  })

  it('gathers assigners across passages and keeps unreadable ones apart', () => {
    const nodes = [
      { id: 'a', body: '(set:$idol to "Sakura")' },
      { id: 'b', body: '(set:$idol to "Chaewon")' },
      { id: 'c', body: '(set:$mood to it + "!")' },
    ]
    const { assignersOf, opaqueVars } = readStoryMacros(nodes)
    expect(assignersOf.get('idol')).toEqual([
      { nodeId: 'a', value: 'Sakura' },
      { nodeId: 'b', value: 'Chaewon' },
    ])
    expect([...opaqueVars]).toEqual(['mood'])
  })
})
