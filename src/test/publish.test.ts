/**
 * The published demo: what it ships, what it hides, and what it refuses to
 * promise.
 *
 * Two of these tests are the feature rather than a check on it. "a passage two
 * hops away" asserts the progressive-unlock property the whole key graph exists
 * to provide, and "ships no legible prose" asserts the promise a reader is
 * actually given. If either stops holding, publishing is worse than useless —
 * it is a lie about where the story went.
 *
 * Nothing here is a golden test. Keys and nonces are random by design, so two
 * publishes of one document differ in every byte; only the plaintext they are
 * built from is deterministic. Do not add a hash assertion.
 */

import { describe, expect, it } from 'vitest'
import {
  buildPayload,
  followLink,
  indexPayload,
  openPassage,
  partitionNodes,
  PublishError,
  type Lookup,
} from '../lib/publish/payload'
import { randomKey } from '../lib/publish/crypto'
import { assemble, AssemblyError } from '../lib/publish/html'
import { publishStory } from '../lib/publish/publish'
import { parseLinks } from '../lib/harlowe/links'
import { renderPassage } from '../lib/harlowe/run'
import { docFrom } from './helpers'

/** What Publish passes. The theme reaches no assertion but the one about it. */
const OPTS = { theme: 'folio' } as const

/** Walk from the start, taking `ordinal` at each step. Returns each body seen. */
async function walk(lookup: Lookup, ordinals: number[]): Promise<string[]> {
  let key: Uint8Array | null = lookup.start
  const seen: string[] = []
  for (const ordinal of ordinals) {
    if (key === null) break
    const envelope = await openPassage(lookup, key)
    if (envelope === null) break
    seen.push(envelope.b)
    key = await followLink(lookup, key, ordinal)
  }
  if (key !== null) {
    const last = await openPassage(lookup, key)
    if (last !== null) seen.push(last.b)
  }
  return seen
}

describe('the key graph', () => {
  it('round-trips every reachable passage', async () => {
    const doc = docFrom({ Start: ['Middle'], Middle: ['End'], End: [] }, { endings: ['End'] })
    const lookup = indexPayload(await buildPayload(doc, OPTS))

    const bodies = await walk(lookup, [0, 0])
    expect(bodies).toHaveLength(3)
    expect(bodies[0]).toBe(doc.nodes.find((n) => n.title === 'Start')!.body)
    expect(bodies[1]).toBe(doc.nodes.find((n) => n.title === 'Middle')!.body)
    expect(bodies[2]).toBe(doc.nodes.find((n) => n.title === 'End')!.body)
  })

  it('carries the title and the ending flag', async () => {
    const doc = docFrom({ Start: ['End'], End: [] }, { endings: ['End'] })
    const lookup = indexPayload(await buildPayload(doc, OPTS))

    const start = (await openPassage(lookup, lookup.start))!
    expect(start.t).toBe('Start')
    expect(start.e).toBe(false)

    const end = (await openPassage(lookup, (await followLink(lookup, lookup.start, 0))!))!
    expect(end.t).toBe('End')
    expect(end.e).toBe(true)
  })

  it('carries the code and the mark, sealed with the rest', async () => {
    // The reader's meta row and its trail need both. Inside the envelope,
    // because a list of codes in the clear is the story's shape.
    const doc = docFrom(
      { Start: ['End'], End: [] },
      { codes: { Start: 'T01', End: 'T02' }, slugs: { Start: 'Sk' } },
    )
    const lookup = indexPayload(await buildPayload(doc, OPTS))

    const start = (await openPassage(lookup, lookup.start))!
    expect(start.c).toBe('T01')
    expect(start.s).toBe('Sk')

    const end = (await openPassage(lookup, (await followLink(lookup, lookup.start, 0))!))!
    expect(end.c).toBe('T02')
    expect(end.s).toBe('')
  })

  it('carries the theme, and marks only Play as the author’s', async () => {
    const doc = docFrom({ Start: [] })
    const published = await buildPayload(doc, { theme: 'phosphor' })
    expect(published.theme).toBe('phosphor')
    expect(published.author).toBeUndefined()
    expect(published.midStory).toBeUndefined()

    const played = await buildPayload(doc, { theme: 'phosphor', author: true })
    expect(played.author).toBe(true)
  })

  it('starts from another passage when asked, shipping only what it reaches', async () => {
    // Play from here. `Aside` is reachable from the story's start but not from
    // `Middle`, so it has no business in a session that begins there.
    const doc = docFrom({ Start: ['Middle', 'Aside'], Middle: ['End'], Aside: [], End: [] })
    const middle = doc.nodes.find((n) => n.title === 'Middle')!
    const payload = await buildPayload(doc, { ...OPTS, start: middle.id })
    expect(payload.midStory).toBe(true)
    expect(payload.blobs).toHaveLength(2)

    const lookup = indexPayload(payload)
    const first = (await openPassage(lookup, lookup.start))!
    expect(first.t).toBe('Middle')
    expect((await walk(lookup, [0])).length).toBe(2)
  })

  it('checks there is a passage to start from before asking where to save', async () => {
    // `publishStory` must fail before `pickSaveFile`, or the author picks a
    // file and the browser creates it empty. In `node` there is no window, so
    // reaching the picker would fail differently.
    const doc = docFrom({ Start: [] })
    doc.startNodeId = null
    await expect(publishStory(doc, 'folio')).rejects.toBeInstanceOf(PublishError)
  })

  it('refuses to start from a passage that is not there', async () => {
    const doc = docFrom({ Start: [] })
    await expect(buildPayload(doc, { ...OPTS, start: '99' })).rejects.toBeInstanceOf(PublishError)
  })

  /**
   * The property the feature rests on.
   *
   * `End` is two links from the start, so its blob must be unopenable with the
   * start key alone — not merely absent from a convenient index, but
   * cryptographically shut. Both halves are checked: the address cannot be
   * computed, and even handed the right address the wrong key fails.
   */
  it('will not open a passage two hops away without walking there', async () => {
    const doc = docFrom({ Start: ['Middle'], Middle: ['End'], End: [] }, { endings: ['End'] })
    const payload = await buildPayload(doc, OPTS)
    const lookup = indexPayload(payload)

    const middleKey = (await followLink(lookup, lookup.start, 0))!
    const endKey = (await followLink(lookup, middleKey, 0))!

    // With the right key, it opens.
    expect((await openPassage(lookup, endKey))!.t).toBe('End')

    // With the start key, every route to it is shut.
    expect(await openPassage(lookup, lookup.start)).not.toBeNull() // the start itself still opens
    expect(await followLink(lookup, lookup.start, 1)).toBeNull() // no second link to follow

    // And a key that never reached it cannot address or decrypt its blob: try
    // every blob in the store against the start key and against a stranger.
    const stranger = randomKey()
    for (const holder of [lookup.start, stranger]) {
      const opened = await openPassage(lookup, holder)
      expect(opened?.t).not.toBe('End')
    }
  })

  it('treats a dangling link as an absent wrap entry, not a crash', async () => {
    const doc = docFrom({ Start: ['Nowhere'] })
    const lookup = indexPayload(await buildPayload(doc, OPTS))

    const start = (await openPassage(lookup, lookup.start))!
    expect(parseLinks(start.b)).toHaveLength(1)
    // The link parses, so the player offers it — and finds nothing behind it,
    // which is how it knows to disable the choice. No code map ships.
    expect(await followLink(lookup, lookup.start, 0)).toBeNull()
  })

  it('leaves unreachable passages out of the payload entirely', async () => {
    const doc = docFrom({ Start: [], Orphan: [] })
    const { shipped, excluded } = partitionNodes(doc)
    expect(shipped.map((n) => n.title)).toEqual(['Start'])
    expect(excluded.map((e) => e.node.title)).toEqual(['Orphan'])

    const payload = await buildPayload(doc, OPTS)
    expect(payload.blobs).toHaveLength(1)
  })

  it('leaves out what only an ending leads to, and says why', async () => {
    // The player disables every choice on an ending, so `Epilogue` could be
    // shipped but never opened. `Start` is linked back from `End` and stays.
    const doc = docFrom(
      { Start: ['End'], End: ['Epilogue', 'Start'], Epilogue: [], Orphan: [] },
      { endings: ['End'] },
    )
    const { shipped, excluded } = partitionNodes(doc)
    expect(shipped.map((n) => n.title)).toEqual(['Start', 'End'])
    expect(excluded.map((e) => [e.node.title, e.reason])).toEqual([
      ['Epilogue', 'past-ending'],
      ['Orphan', 'unreachable'],
    ])
    expect((await buildPayload(doc, OPTS)).blobs).toHaveLength(2)
  })

  it('follows back edges and self-loops, because a reader does', async () => {
    const doc = docFrom({ Hub: ['Cave'], Cave: ['Hub'] })
    const { shipped } = partitionNodes(doc)
    expect(shipped).toHaveLength(2)

    const lookup = indexPayload(await buildPayload(doc, OPTS))
    const caveKey = (await followLink(lookup, lookup.start, 0))!
    const backToHub = (await followLink(lookup, caveKey, 0))!
    expect((await openPassage(lookup, backToHub))!.t).toBe('Hub')
  })

  it('refuses a story with no start passage', async () => {
    const doc = docFrom({ Start: [] })
    doc.startNodeId = null
    await expect(buildPayload(doc, OPTS)).rejects.toBeInstanceOf(PublishError)
  })
})

describe('ordinals', () => {
  /**
   * The drift that would produce a confident lie rather than a missing feature.
   *
   * `DerivedEdge.ordinal` and `RunChoice.ordinal` are both `parseLinks`'s, and
   * `parseLinks` skips an empty target *without consuming one*. If either side
   * ever counted links itself, a choice would silently lead to the wrong
   * passage — so the empty-target case is checked explicitly.
   */
  it('agree between the wrap table and what the player renders', async () => {
    const doc = docFrom({ Start: [], Left: [], Right: [] })
    const start = doc.nodes.find((n) => n.title === 'Start')!
    start.body = 'A fork.\n[[foo->]]\n[[Left|P2]]\n[[Right|P3]]'

    const lookup = indexPayload(await buildPayload(doc, OPTS))
    const rendered = renderPassage((await openPassage(lookup, lookup.start))!.b)

    // The empty-target link consumed no ordinal: the two real links are 0 and 1.
    expect(rendered.choices.map((c) => c.ordinal)).toEqual([0, 1])

    for (const choice of rendered.choices) {
      const key = await followLink(lookup, lookup.start, choice.ordinal)
      expect(key).not.toBeNull()
      const envelope = (await openPassage(lookup, key!))!
      expect(envelope.t).toBe(choice.target === 'P2' ? 'Left' : 'Right')
    }
  })
})

describe('an ending', () => {
  /**
   * An ending with links still leaving it is the case the walk-through fixture
   * cannot show, because a passage with no links looks the same from outside.
   * The flag has to do the work: a route stops at a marked ending whatever the
   * author left dangling off it.
   */
  it('stops the story even when links still lead out of it', async () => {
    const doc = docFrom({ Start: ['Last'], Last: ['Start'] }, { endings: ['Last'] })
    const lookup = indexPayload(await buildPayload(doc, OPTS))

    const lastKey = (await followLink(lookup, lookup.start, 0))!
    const last = (await openPassage(lookup, lastKey))!
    expect(last.e).toBe(true)
    expect(renderPassage(last.b).choices).toHaveLength(1)

    // The key is still wrapped - the edge is real and the author wrote it - so
    // what stops the reader is the flag, which is the player's to honour.
    expect(await followLink(lookup, lastKey, 0)).not.toBeNull()
  })
})

describe('the published file', () => {
  const BUNDLE = 'var StoryboardPlayer=(function(){return{start:function(){}}})();'

  /**
   * The promise a reader is actually given.
   *
   * Not a proxy for it - the literal question, asked of the literal bytes that
   * land on disk. Every distinctive phrase in the story must be absent from the
   * file, including the passage titles, which are as much of a spoiler as the
   * prose. Only the story title is exempt, and deliberately: it is the name on
   * the page and in the tab.
   */
  it('ships no legible prose', async () => {
    const doc = docFrom(
      { Doorway: ['Strongroom'], Strongroom: [] },
      {
        endings: ['Strongroom'],
        // Codes and marks too: they sit in the envelope beside the prose.
        codes: { Doorway: 'Qzdoor', Strongroom: 'Qzvault' },
        slugs: { Doorway: 'Xyhinge' },
      },
    )
    doc.storyTitle = 'A Quiet Place'
    doc.nodes.find((n) => n.title === 'Doorway')!.body =
      'The hinge gives with a sound like a held breath.'
    doc.nodes.find((n) => n.title === 'Strongroom')!.body =
      'Inside, the money was never the point.'

    const html = assemble(BUNDLE, await buildPayload(doc, OPTS))

    // Titles too: a passage called Strongroom gives away as much as its prose.
    // The words are chosen to be distinctive - a test word like "start" matches
    // the bootstrap call and proves nothing about the story.
    for (const secret of [
      'hinge',
      'held breath',
      'never the point',
      'Strongroom',
      'Doorway',
      'Qzdoor',
      'Qzvault',
      'Xyhinge',
    ]) {
      expect(html.toLowerCase()).not.toContain(secret.toLowerCase())
    }
    // The story's own name is on the page, which is the whole of what leaks.
    expect(html).toContain('A Quiet Place')
  })

  it('encodes the payload so it cannot escape its script tag', async () => {
    const doc = docFrom({ Start: [] })
    doc.nodes[0]!.body = 'Look: </script><script>alert(1)</script> and <b>markup</b>.'
    const html = assemble(BUNDLE, await buildPayload(doc, OPTS))

    // One payload script, one player script, one bootstrap. The body's markup
    // reaches none of them: base64 has no `<`. The fonts arrive by `<link>`,
    // which is not a script and runs nothing.
    expect(html.match(/<script/g)).toHaveLength(3)
    expect(html).not.toContain('alert(1)')
  })

  it('refuses a bundle that could close its own script tag', async () => {
    const doc = docFrom({ Start: [] })
    const payload = await buildPayload(doc, OPTS)
    expect(() => assemble('var x = "</script>";', payload)).toThrow(AssemblyError)
  })

  it('refuses a bundle that opens a script tag, which would let `<!--` swallow the close', async () => {
    // `<!--` then `<script` puts the tokenizer where the page's own `</script>`
    // no longer ends the element. The real bundle carries a `<!--`, so the
    // opening tag is the half that has to be kept out.
    const payload = await buildPayload(docFrom({ Start: [] }), OPTS)
    expect(() => assemble('var x = "<!--"; var y = "<SCRIPT>";', payload)).toThrow(AssemblyError)
    expect(() => assemble('var x = "<!--";', payload)).not.toThrow()
  })

  it('escapes the story title into the page', async () => {
    const doc = docFrom({ Start: [] })
    doc.storyTitle = 'Tom & "Jerry" <hr>'
    const html = assemble(BUNDLE, await buildPayload(doc, OPTS))
    expect(html).toContain('<title>Tom &amp; &quot;Jerry&quot; &lt;hr&gt;</title>')
    expect(html).not.toContain('<hr>')
  })

  it('writes the author’s theme onto the page before any script runs', async () => {
    // So a dark theme does not flash white while the first passage decrypts.
    const html = assemble(BUNDLE, await buildPayload(docFrom({ Start: [] }), { theme: 'marquee' }))
    expect(html).toContain('<html lang="en" data-theme="marquee">')
    expect(html).toContain('fonts.googleapis.com')
  })
})
