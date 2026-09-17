import { beforeEach, describe, expect, it } from 'vitest'
import { serializeDoc } from '../lib/doc/serialize'
import * as play from '../stores/play'
import * as store from '../stores/story'
import type { StoryDoc } from '../types/story'
import { docFrom } from './helpers'

/** Put a document in front of the reader, the way the app does. */
function load(doc: StoryDoc): void {
  store.loadStory(serializeDoc(doc))
}

/** The passage the reader is on, by title. */
const at = () => play.playStep.value?.node.title ?? null
/** Variables the reader now holds, as `name=value` with `?` for unreadable. */
const held = () => play.playVars.value.map((v) => `${v.name}=${v.value ?? '?'}`)

function setBody(title: string, body: string): void {
  const node = store.state.doc.nodes.find((n) => n.title === title)!
  const before = node.body
  store.editBody(node.id, body)
  store.resolveBody(node.id, before)
}

beforeEach(() => {
  // This file runs in the default `node` environment, so there is no
  // `localStorage`; `saveLocal` already swallows that, which is why `loadStory`
  // works here at all.
  play.resetPlay()
})

describe('walking a story', () => {
  it('starts on the story’s first passage', () => {
    load(docFrom({ One: ['Two'], Two: [] }))
    play.playStart()
    expect(play.playOpen.value).toBe(true)
    expect(at()).toBe('One')
    expect(play.canPlayBack.value).toBe(false)
  })

  it('pushes a step for each choice taken', () => {
    load(docFrom({ One: ['Two'], Two: ['Three'], Three: [] }))
    play.playStart()
    play.playChoose(0)
    expect(at()).toBe('Two')
    play.playChoose(0)
    expect(at()).toBe('Three')
    expect(play.playDepth.value).toBe(3)
  })

  it('spells the route as the codes of the passages visited', () => {
    // Invariant 3, made visible for the first time: the stack *is* the codes.
    load(docFrom({ One: ['Two'], Two: ['Three'], Three: [] }))
    play.playStart()
    play.playChoose(0)
    play.playChoose(0)
    expect(play.playRoute.value).toBe('P1->P2->P3')
  })

  it('goes back a choice at a time', () => {
    load(docFrom({ One: ['Two'], Two: ['Three'], Three: [] }))
    play.playStart()
    play.playChoose(0)
    play.playChoose(0)
    play.playBack()
    expect(at()).toBe('Two')
    play.playBack()
    expect(at()).toBe('One')
    expect(play.canPlayBack.value).toBe(false)
    play.playBack()
    expect(at()).toBe('One')
  })

  it('follows a self-link and a back edge, because a reader can loop', () => {
    // The deliberate divergence from `forwardTargets`, which excludes both.
    load(docFrom({ One: ['Two'], Two: ['One'] }))
    play.playStart()
    play.playChoose(0)
    play.playChoose(0)
    expect(at()).toBe('One')
    expect(play.playRoute.value).toBe('P1->P2->P1')
  })

  it('refuses a choice into a passage nobody has written', () => {
    load(docFrom({ One: ['Ghost'] }))
    play.playStart()
    expect(play.playStep.value!.choices[0]).toMatchObject({ target: 'Ghost', blocked: 'phantom' })
    play.playChoose(0)
    expect(at()).toBe('One')
  })
})

describe('variables along a route', () => {
  it('carries what a passage set into the next one', () => {
    load(docFrom({ One: ['Two'], Two: [] }))
    setBody('One', '(set: $lantern to "lit")\n[[Go to Two|P2]]')
    play.playStart()
    expect(held()).toEqual(['$lantern=lit'])
    play.playChoose(0)
    expect(held()).toEqual(['$lantern=lit'])
  })

  it('names the passage that set each variable', () => {
    load(docFrom({ One: ['Two'], Two: [] }))
    setBody('One', '(set: $lantern to "lit")\n[[Go to Two|P2]]')
    play.playStart()
    play.playChoose(0)
    expect(play.playVars.value[0]).toMatchObject({ name: '$lantern', setBy: 'P1' })
  })

  it('restores exactly what was held, even when the route looped', () => {
    // `varsBefore` is a copy pushed on entering, which is what makes Back exact
    // and O(1). Recomputing forward would have to get this case right too.
    load(docFrom({ One: ['Two'], Two: ['One', 'Three'], Three: [] }))
    setBody('One', '(set: $turns to "again")\n[[Go to Two|P2]]')
    setBody('Two', '[[Go to One|P1]]\n[[Go to Three|P3]]')
    play.playStart()
    expect(held()).toEqual(['$turns=again'])
    play.playChoose(0)
    play.playChoose(0)
    expect(at()).toBe('One')
    play.playBack()
    expect(at()).toBe('Two')
    expect(held()).toEqual(['$turns=again'])
  })

  it('shows a gated choice only when the gate opened', () => {
    load(docFrom({ One: ['Two'], Two: ['Three'], Three: [] }))
    setBody('One', '(set: $key to "found")\n[[Go to Two|P2]]')
    setBody('Two', '(if: $key is "found")[ [[Go to Three|P3]] ]')
    play.playStart()
    play.playChoose(0)
    expect(play.playStep.value!.choices.map((c) => c.target)).toEqual(['P3'])
  })

  it('hides a gated choice when the gate never opened', () => {
    load(docFrom({ One: ['Two'], Two: ['Three'], Three: [] }))
    setBody('Two', '(if: $key is "found")[ [[Go to Three|P3]] ]')
    play.playStart()
    play.playChoose(0)
    expect(play.playStep.value!.choices).toEqual([])
    expect(play.playStep.value!.unwritten).toBe(true)
  })

  it('starts mid-story with nothing set, and says so', () => {
    load(docFrom({ One: ['Two'], Two: [] }))
    setBody('One', '(set: $lantern to "lit")\n[[Go to Two|P2]]')
    const two = store.state.doc.nodes.find((n) => n.title === 'Two')!
    play.playStart(two.id)
    expect(at()).toBe('Two')
    expect(play.playMidStory.value).toBe(true)
    expect(held()).toEqual([])
  })
})

describe('where a reading stops', () => {
  it('offers no choices out of an authored ending', () => {
    // The reader agreeing with `countPaths`, which treats an ending as a leaf
    // before expanding its out-edges — and with the inspector's own warning.
    load(docFrom({ One: ['Two'], Two: ['Three'], Three: [] }, { endings: ['Two'] }))
    play.playStart()
    play.playChoose(0)
    expect(play.playStep.value!.node.isEnding).toBe(true)
    expect(play.playStep.value!.choices[0]).toMatchObject({ blocked: 'ending' })
    play.playChoose(0)
    expect(at()).toBe('Two')
  })

  it('does not call an unlinked passage an ending', () => {
    // `isEnding` is authored, never inferred: an unlinked passage is
    // indistinguishable from one whose links are simply unwritten.
    load(docFrom({ One: ['Two'], Two: [] }))
    play.playStart()
    play.playChoose(0)
    expect(play.playStep.value!.unwritten).toBe(true)
    expect(play.playStep.value!.node.isEnding).toBe(false)
  })

  it('reads again from the passage the session started on', () => {
    load(docFrom({ One: ['Two'], Two: [] }))
    setBody('One', '(set: $lantern to "lit")\n[[Go to Two|P2]]')
    play.playStart()
    play.playChoose(0)
    play.playRestart()
    expect(at()).toBe('One')
    expect(play.playDepth.value).toBe(1)
  })
})

describe('the session and the document', () => {
  it('ends the session when the passage being read is removed', () => {
    load(docFrom({ One: ['Two'], Two: [] }))
    play.playStart()
    play.playChoose(0)
    const two = store.state.doc.nodes.find((n) => n.title === 'Two')!
    store.removePassage(two.id)
    expect(play.playStep.value).toBeNull()
    expect(play.playNotice.value).toMatch(/removed/)
  })

  it('says so rather than opening empty when there is no first passage', () => {
    // `parseDoc` repairs a missing `startNodeId` to the first node, so the only
    // story that really has none is one with no passages at all.
    load(docFrom({}))
    play.playStart()
    expect(play.playOpen.value).toBe(true)
    expect(play.playStep.value).toBeNull()
    expect(play.playNotice.value).toMatch(/first passage/)
  })

  it('never commits, so the document is untouched by a whole reading', () => {
    // `play.ts` is its own module precisely so `commit` is out of reach.
    load(docFrom({ One: ['Two'], Two: ['Three'], Three: [] }))
    const before = serializeDoc(store.state.doc)
    const undos = store.canUndo.value
    play.playStart()
    play.playChoose(0)
    play.playChoose(0)
    play.playBack()
    expect(serializeDoc(store.state.doc)).toBe(before)
    expect(store.canUndo.value).toBe(undos)
  })

  it('writes no localStorage of its own', () => {
    // A "last read position" would be persisted state living outside
    // `StoryDoc`, which invariant 1 forbids. Installed after `load`, since
    // `loadStory` legitimately saves the document.
    load(docFrom({ One: ['Two'], Two: [] }))
    const written: string[] = []
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        setItem: (key: string) => written.push(key),
        getItem: () => null,
        removeItem: (key: string) => written.push(key),
        clear: () => written.push('clear'),
      },
    })
    try {
      play.playStart()
      play.playChoose(0)
      play.playBack()
      play.playClose()
    } finally {
      if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
      else delete (globalThis as Record<string, unknown>).localStorage
    }
    expect(written).toEqual([])
  })

  it('clears everything on reset', () => {
    load(docFrom({ One: ['Two'], Two: [] }))
    play.playStart()
    play.playChoose(0)
    play.resetPlay()
    expect(play.playOpen.value).toBe(false)
    expect(play.playStep.value).toBeNull()
    expect(play.playRoute.value).toBe('')
    expect(play.playNotice.value).toBeNull()
    expect(play.playMidStory.value).toBe(false)
  })
})

describe('what the reader shows of an unreadable passage', () => {
  it('keeps the body it could not evaluate, marked', () => {
    load(docFrom({ One: ['Two'], Two: [] }))
    setBody('One', '(if: $v > 3)[kept]\n[[Go to Two|P2]]')
    play.playStart()
    const inlines = play.playStep.value!.result.blocks.flatMap((b) => b.inlines)
    expect(inlines.some((n) => n.kind === 'unsupported')).toBe(true)
    expect(inlines.some((n) => n.kind === 'text' && n.text === 'kept' && n.uncertain)).toBe(true)
  })

  it('marks a choice only an unreadable region offered', () => {
    load(docFrom({ One: ['Two'], Two: [] }))
    setBody('One', '(hidden:)[ [[Go to Two|P2]] ]')
    play.playStart()
    expect(play.playStep.value!.choices[0]).toMatchObject({ target: 'P2', uncertain: true })
  })

  it('reports what a passage asks the reader for', () => {
    load(docFrom({ One: [] }))
    setBody('One', '(set: $name to (prompt: "Your name?", "Mira"))')
    play.playStart()
    expect(play.playStep.value!.result.asks).toEqual([
      { variable: '$name', message: 'Your name?', default: 'Mira' },
    ])
    expect(held()).toEqual(['$name=?'])
  })
})
