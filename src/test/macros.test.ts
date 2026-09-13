import { describe, expect, it } from 'vitest'
import { deriveGraph } from '../lib/graph/derive'
import { parseLinks } from '../lib/harlowe/links'
import {
  guardsByOrdinal,
  parseAssignments,
  parseGuardSpans,
  readStoryMacros,
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
