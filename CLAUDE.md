# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                      # Vite dev server on http://localhost:5173
npm run build                    # vue-tsc -b type-check, then bundle
npm test                         # vitest run (single pass)
npm run test:watch               # vitest watch mode
npx vitest run src/test/layout.test.ts            # one file
npx vitest run -t 'centres a parent'              # one test by name
```

There is no linter. Type checking happens only in `npm run build` (`vue-tsc -b`), so
run it before considering a change done — `tsconfig.app.json` enables
`noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly` and
`noFallthroughCasesInSwitch`, none of which Vite surfaces during `dev`.

Vitest runs in `node` by default; `src/test/render.test.ts` is the one file routed to
`jsdom` (see `environmentMatchGlobs` in `vitest.config.ts`).

## Architecture

A Vue 3 SPA that draws a Twine-style choose-your-own-adventure story as a level-aligned
tree. Five invariants drive nearly every design decision in the repo:

**1. The document is the only persisted state; layout is a pure function of it.**
`StoryDoc` (`src/types/story.ts`) is exactly what is serialized. No coordinate, level,
ordering or edge path is ever saved — `layoutStory(doc)` recomputes all of it. The one
positional field in the document is `StoryNode.levelOffset` (0 or 1), a lower bound fed
into layering. This is why inserting a passage mid-story "auto-refactors" levels: there
is nothing to refactor, levels are simply re-derived.

**2. Body prose is the only source of truth for structure.** Edges are not stored.
`deriveGraph` parses each `body` for `[[...]]` links (`src/lib/harlowe/links.ts` handles
all four Twine forms) and those links *are* the edges. A link target is a passage's
**`code`** — required, unique, case-sensitive, minted as `P<id>` — never its `title`,
which is cosmetic and may repeat. So changing a code must cascade through inbound link
text (`setCode`), while renaming a title is a plain field write. Deriving must never
create real nodes, or a deleted-but-still-linked passage would be resurrected on the
next re-derive. Unresolved targets become *phantoms* (`phantom:`-prefixed ids) that
participate fully in layout but exist only in the derived graph.

**3. `code` is identity, and a route's identity is a sequence of them.** A reader's
story is identified by the ordered codes of the passages they visited — `P1->P3->P7`.
Exact by construction: two readers who chose differently cannot collide, however often
their routes merge. Nothing in the repo generates it — links resolve by code, so codes are
the Twine passage names, so Harlowe's `(history:)` already returns exactly that sequence.
`->` is the delimiter because `setCode` bans it from codes (`LINK_SYNTAX`), so it cannot
collide the way `-` or `.` could.

`note` is unrelated to any of that. It is free text of any length, for the author alone:
repeatable, optional, stored exactly as typed (like `StoryDoc.notes`, and for its reasons)
and read by nothing but `searchableText`. It lives on the inspector's Advanced tab and
reaches no card. It once carried a grammar so per-passage notes could concatenate into a route
(`D-LY`); that was removed because the concatenation was noise — in a real story an early
branch is usually irrelevant to a later one, so the leading characters were something to
strip rather than context to read. Do not reintroduce structure **here**: the note is
prose, and prose is all it is.

`slug` is that concatenation, revived deliberately and somewhere else. Each passage may
carry up to ten characters; `runningSlugs` (`graph/slugs.ts`) spells out the marks along
the route to a passage, and writes `*` wherever the routes disagree — `A -> B -> D` reads
`ABD`, and adding `A -> C -> D` makes it `A*D`. Four things separate it from the grammar
above, and all four have to hold or it is the same mistake again:

- **Its own field.** The two uses were fighting over one string before, which was most of
  the problem. Prose is prose; a mark is a mark.
- **Derived, not authored.** The author writes one mark per passage and never maintains a
  sequence. The route string is computed and stored nowhere — invariant 1, again.
- **It marks its own ambiguity.** `D-LY` asserted a single route because it had no way to
  say otherwise. `A*D` says the middle varies. That is `gates.ts`'s asymmetry pointed at a
  new problem: a `*` where a literal was possible costs precision, a literal where routes
  differ states something false. When in doubt, star. `normalizeSlug` strips `*` from what
  an author types for exactly this reason — a literal one would be indistinguishable from
  the marker. A run is compared as a list of *marks*, never as characters:
  `Ab` and `Bb` are two marks sharing a letter, and reading a `b` out of that would invent
  one nobody wrote. Parentheses are the one structure inside a mark, and their contents are
  compared separately — `A(a)` against `A(b)` is `A(*)`.
- **Shown only while it is going somewhere.** A passage with no mark and no marked
  descendant spells what its parent spelled and always will, so the card says nothing
  rather than repeating a finished code down a corridor (`marksAhead`, and `cardSlugs` in
  the store). The code itself is unchanged — search and the inspector still have it.
- **Display, not identity.** A route's identity is still the code sequence. Running slugs
  are *allowed to collide*: an unslugged passage contributes nothing, so `A -> B -> C` with
  only `A` marked gives all three the running slug `A`. That is correct — the running slug
  names the route so far, not the passage at the end of it, and a reader quotes the pair
  ("on `P7`, route `A*D`"). Do not add a uniqueness rule or a duplicate lint.

What is *not* rebutted is the growth. A running slug still gets longer with depth and the
leading characters are still the part you skip — which is why the card shows the tail and
the inspector shows the whole thing, rather than pretending the problem is gone.

**4. A macro may be read, never executed.** `deriveGraph` sees only `[[...]]`, so a
link gated by `(if: $v is "x")` looks unconditional and the graph over-reports what is
reachable. `macros.ts`
closes that by pattern-matching source text — the same kind of read `links.ts` does — to
learn which passage assigns a variable and which condition guards a link. `gatesOf`
turns that into a *gate*: the passage every route to another provably passes. The same
read proves the opposite case — when nothing assigns the value a condition tests, the
branch is dead, which nothing else in the tool would catch.

The inference is sound only under five conditions (enumerated in `gates.ts`, in
`gateOf`). **Every one of them fails closed**: no gate, which is what the tool said
before it could read macros at all. That asymmetry is the design — a missing gate costs
nothing but precision, a wrong one states something false about the story. Three rules exist purely to hold it:

- **Conditions are matched anchored, whole.** An unanchored search reads
  `(if: $v is not "x")` as its exact negation.
- **Only `if` and `else-if` are read.** `(unless:)` is identical on the surface and means
  the opposite. `(else-if:)` is safe despite running only when earlier tests failed —
  its own condition is still *necessary* to take the branch, and a gate needs necessity,
  not sufficiency.
- **Any unreadable write to a variable disqualifies it.** `(put:)`, `(move:)`, a computed
  right-hand side — one unseen write and a route exists that never passed the gate.

**5. Writing a body and resolving its links are separate mutations.** `setBody` is a
plain field write and runs on every keystroke; `resolveLinks(doc, id, bodyAtFocus)` runs
on blur, creates the passages the links name, and rewrites a bare `[[Head north]]` into
`[[Head north|P7]]`. Folding the two together would splice text in under the author's
caret mid-word. `bodyAtFocus` is what distinguishes a link just written from one left
dangling on purpose, so it must be captured when the editor takes focus, not re-read.

### Layers

| Path | Role |
|---|---|
| `src/types/story.ts` | The document model, its canonical comparators (`compareStr`, `compareNodes`, `compareByName`) and `emptyCharacter` / `emptyDoc` constructors |
| `src/lib/doc/` | `mutations.ts` (all document edits), `serialize.ts` (canonical JSON + repairing parse), `storage.ts` (localStorage), `file.ts` (import/export) |
| `src/lib/graph/` | Deterministic Sugiyama pipeline; `layoutStory` in `layout.ts` is the only entry point the UI touches. `paths.ts`, `gates.ts` and `stats.ts` are analyses over the derived graph, called by the store and the panels rather than by `layoutStory` |
| `src/lib/harlowe/` | `links.ts` (parse/retarget), `highlight.ts` (macros are highlighted, never executed), `macros.ts` (macros are *read* — spans and names — still never executed) |
| `src/stores/story.ts` | Module-level singleton store: a `reactive` state object plus exported functions and computeds. Not Pinia |
| `src/components/`, `src/composables/` | Presentation; viewport pan/zoom and global shortcuts |

The graph pipeline runs `derive → acyclic → layering → components → layered → ordering /
crossings → xcoord / tidy → routing` (each a module of that name). Alongside it sit the
analyses the pipeline never calls: `paths.ts` counts distinct paths as `BigInt` (both
forwards from a passage and backwards to one) and owns the one definition of a route edge,
`gates.ts` reads what the story's `(if:)` macros say about which routes exist, `slugs.ts`
spells out what a reader would have collected on the way to a passage, and
`recode.ts` reads a numbering off the drawing, and
`stats.ts` totals the story — words, the routes reaching each ending, and the draft-health
lint — only when the panel asks. `README.md` has a per-module table.

### Rules that are load-bearing

**Every mutation returns a fresh document.** `mutations.ts` is pure: nothing there reads
layout, and layout never writes back. Its `clone()` must copy every array- and
object-valued field — a missed one aliases across undo-history entries, so editing the
present silently rewrites the past and only surfaces as a broken undo much later. Store
functions call `commit()`, which pushes onto the undo stack (limit 100) and clears redo.

**Layout must be deterministic.** `layout(doc)` must equal `layout(shuffle(doc.nodes))`;
a property test asserts it. That requires: `Map` over plain objects, canonical iteration
arrays instead of `Map.keys()`, codepoint comparison instead of `localeCompare` (ICU
version varies by host), total comparators that never lean on sort stability, fixed
iteration budgets, no transcendentals (see `EQUILATERAL_FACTOR` in `graph/constants.ts`,
a literal rather than `Math.sqrt(3)/2`), and no DOM text measurement. Card geometry is
fixed in `constants.ts`.

**Serialization is canonical.** `serializeDoc` emits keys in fixed order with every array
sorted, so a document always produces byte-identical JSON. `parseDoc` repairs a
hand-edited file rather than rejecting it, returning warnings.

**`StoryDoc.characters` is the only valid source of `SceneCharacter.name`.** Holding that
invariant is why renaming a character cascades through every scene cast and relation, and
why deleting one cannot simply drop the roster entry. The roster is ordered by the
author, not by name: `CharacterEntry.order` is the canonical sort key (name is only the
tiebreak) and every roster mutation ends in `orderRoster`, which renumbers it 0..n-1.
Relations are one-directional:
Mira→Tam records only how Mira regards Tam; the reverse is a separate entry.

**The store keeps `layout` in a `shallowRef` + `markRaw`.** Deep-proxying a large story's
layout costs more than computing it. `setDoc` recomputes layout synchronously (not in a
watcher, which would flush a tick late and leave `layout` describing the previous
document) and memoizes on a hash of only the fields layout depends on — id, code, title,
`levelOffset`, body, `startNodeId` — so tag, state and story-notes edits are pure
re-renders. `code` is in
there because links resolve against it; leave it out and a recode goes unnoticed while
every inbound edge re-resolves to a phantom.
`layoutVersion` is a stale-result guard so layout can later move into a Web Worker.

**A recode is planned in `graph/` and applied in `doc/`.** `planRecode` (`graph/recode.ts`)
is another of those analyses, like `paths.ts` and `gates.ts`: it reads
`LayoutResult` and emits strings, so the "mutations never read layout" direction holds.
`recodeAll` receives a finished id → code map and knows nothing about levels, and `setCode`
is now its one-entry case — a hand-written loop there used to skip the recoded passage's own
body and drop a self-link into a phantom. It must stay *one* mutation: a recode is a permutation, so `setCode` in a loop would refuse `P1 → P2`
while `P2` still exists, and `retargetLinks` applied per pair would move a link an earlier
pair already rewrote. `remapLinks` is the primitive that holds it — one pass over the parse,
every target looked up once in the old vocabulary — and `retargetLinks` is now its one-entry
case, so the splice discipline lives in one place.

**A numbering must be a fixed point of the layout it was read from, and padding is what
makes it one.** Canonical node order *is* code order (`deriveGraph`), `findComponents`
numbers components by it, and `xcoord` packs them left to right in that order. Unpadded,
`P10` sorts before `P2`, so past nine components the assignment and the packing chase each
other around a cycle with no fixed point: every press of Recode rotates every code, forever.
`planRecode` therefore pads each number to the width of the largest the story needs, under a
floor of `MIN_NUMBER_WIDTH`, which makes codepoint order equal drawing order. Do not "tidy"
the padding away. The floor is a separate concern from correctness: width taken purely from
the count would rewrite every code in the story each time it crossed a power of ten, so the
floor moves the first cliff out to a hundred. It applies to the counter, never to the level.

**`freeCode` reads the story's own code shape.** A new passage in a story recoded to
`T001`..`T101` mints `T102`, not `P102`: `codeShape` infers the prefix and padding from the
codes already there and falls back to `P<n>` when they are not a prefix plus a number (a
level-and-node code like `3N01`) or disagree. It is read from the document rather than kept
as a preference so that it survives export, import, and a story someone else wrote.
`parseDoc`'s repair path mints through the same shape, which is what keeps its
promise intact: a story recoded to `P01`.. that loses a code reproduces `P0<id>`, not the
bare `P<id>` a fixed prefix would invent. An inferred prefix is checked for link syntax
before it is used — a hand-edited file can hold a code `setCode` would have refused. The store still re-plans up to `RECODE_PASSES` times, but only
because applying can change the *graph*: a new code may land on one a dangling link already
names, attaching it and redrawing the tree. `settleRecode` runs that loop once and feeds both
the preview and the apply — the panel hands its own settled result back to `codesRecode`,
which uses it only if `base` is still the current document — so the panel cannot show one
mapping and the document receive another. Attaching a dangling link is the only way applying
a plan can change the graph, so a pass that captures nothing ends the loop without laying the
result out again; and the capture warning is measured as "was a phantom, no longer is" rather
than read off any one pass, because a passage that captures a link can be renumbered on the
next pass and finish under a different code than the one that did the capturing. Its rows are read off the layout it is about to install (`drawingOrder`), never
re-planned from it — that stays true whether the loop converged or ran out of passes,
which a re-plan would not. `commit` is handed that same layout rather than paying for
Sugiyama twice on one button press.

**An ending is authored, and it terminates routes.** `StoryNode.isEnding` is never
inferred: a passage with no outgoing links is indistinguishable from one whose links are
simply unwritten, so deriving it would flag most of a draft as finished. `countPaths`
honours it by treating the passage as a leaf *before* expanding its out-edges, which is
what makes the endings a partition of the routes rather than an overlapping tally — and
which is why `stats.ts` reports what sits past one as stranded. The set is an explicit
parameter, defaulting to empty: a field on `DerivedGraph` would live inside `LayoutResult`,
which is memoized on `layoutKey`, which deliberately excludes `isEnding` — so it would go
stale the moment the box was ticked. For the same reason it is absent from `NodeLayout` and
reaches the card as a prop map from `App.vue`, the way `state` and `token` do. It moves
nothing on the canvas, and `layout.test.ts` asserts that.

**A link the author wrote and an edge a route can take are different questions.**
`forwardTargets` in `paths.ts` is the single definition of the second — no self-loop, no
back edge, nothing leaving a passage marked as an ending — and `backwardSources` mirrors
it, stopping at the edge's *source* rather than at `id`, which is what makes the two
directions agree and the endings sum to the total. Everything that counts routes goes
through them. That predicate was hand-written in six places once, and two copies had
already drifted; the drift is the whole point, because reading an authored question off
the route model makes the tool state something false about the prose. `Cave -> Hub` is a
back edge, so no route takes it, but the author plainly wrote it — which is why `stats.ts`
keeps `authoredOut` separate and answers the dead-end lint and "links per passage" with
it. Off the route model a hub-and-spoke story accused its own spokes of being unwritten
branches, and ticking one Ending changed the link count of passages it never touched.
Leaving `endings` off `forwardTargets` asks the third question — what does this passage
link to, *ignoring* the cutoff — which is exactly what the warning about an ending with
links still leaving it needs.

**A modified key that opens something must check what is already open.** `useShortcuts`
runs its `mod` branch before the `modalOpen` stand-down on purpose: Cmd Z and the zoom keys
still belong to the canvas under a veil. `Cmd /` is the exception in that branch, because
it opens a sheet of its own — and the sheet and the expanded body editor both listen for
Escape on `window`, so stacking them let one press close the editor the author was writing
in. It guards on `dialogOpen`, which is `modalOpen` *plus* the expanded editor: that editor
is deliberately not in `modalOpen`, since it has a textarea `isTyping` already catches, so
a question about who owns Escape cannot be read off `modalOpen` alone. Stats itself is
exempt, or the key that opens it could not close it again.

**Revealing a passage is `App.openPassage`, not `store.select`.** Selecting sets the
anchor; it does not move the canvas or open the sidebar, so a row that offers to jump to a
passage has to go through `openPassage` — which is why `StoryStatsPanel` emits `open`
rather than reaching for the store. A phantom is the case that forces the shape: it has a
card and a place on the canvas but no passage behind it, so centring on it is right and
opening the inspector on it is not.

**A new document field must cost an existing author nothing.** `parseDoc` ignores the
incoming `version` entirely and re-stamps `DOC_VERSION`, so there is no version gate to
fail; every field is read with an inline default and unknown keys are ignored; `loadLocal`
and `importDoc` both funnel through it. So a new field needs a default in exactly two
places — `createNode` and the `parseDoc` node literal — and must push **no** warning when
absent, since a file written before the field existed is not damaged. It must still be
*emitted* even at its default value, or `parseDoc(serializeDoc(x))` stops round-tripping
byte-identically. `compat.test.ts` holds this against a save file exported verbatim from
the build before `isEnding`, asserting the same layout hash and the same route count; do
not regenerate that fixture, and do not bump the `storybook.story.v1` localStorage key.

**The left gutter is lit through the editor's veil only when nothing in it can move the
selection.** `--veil-inset` stops `BodyDialog`'s veil at the gutter so the cheat sheet
stays readable beside an expanded editor; `StoryNotes` qualifies too, since it writes a
story-level field. `StoryIndexPanel` does not — its rows call `select`, and the open
dialog is bound to the selection, so exposing it would let one click swap the passage
being edited mid-keystroke. While the index is up the whole column dims, notes included.
`App.vue` owns the stack: `.left-gutter` sets the width and the stage's edge, and its
occupants only take a share of the height (`flex: 1 1 0`).

**Gate inference runs outside `layoutStory`, and must stay there.** A gate moves
nothing on the canvas, so the macro read is wanted only when something asks. The `gates`
computed in the store reads the graph `LayoutResult` already retains (`graph`,
`backEdges`) plus per-node `level`, exactly as `pathsFrom` does, and memoizes on
`layoutVersion` alone — guards are a pure function of bodies, and bodies are already in
`layoutKey`. Move it into `layoutStory` and every keystroke re-parses every macro in the
story. `layout.test.ts` asserts notes do not perturb geometry, and `workflow.test.ts`
asserts a note edit leaves `stats.hash` untouched.

**The macro layer must not depend on the graph.** `readStoryMacros` builds its edge keys
as `${id}|${ordinal}` to match `EdgeId` (`derive.ts`, the only place one is constructed).
A test asserts the two agree, because a drift there attaches a guard to the *wrong* edge
— the single failure mode that produces a confident lie rather than a missing gate. For
the same reason nothing in `macros.ts` counts links itself: `parseLinks` skips an
empty target without consuming an ordinal, so the caller maps guards to links by span.

The memo is about the parse, not about render identity: `gates` reaches no card — only
`selectedGate` and the inspector read it. It exists so that an edit reaching no macro (a
tag, a state, a note, the story's scratchpad) does not re-scan every body in the story.

### Tests

`src/test/helpers.ts` builds documents from a compact adjacency spec: `docFrom({ One:
['Two'] })`. Files are split by concern rather than by source file — `doc` (links,
rename cascade, tags, save file), `layering` / `layout` (levels, geometry, determinism,
paths), `scene` (settings, cast), `profile` (character sheet traits and relations),
`gates` (inference from conditional links, and its fail-closed conditions),
`stats` (endings, word counts, the lint, and the line between an authored link and a
route edge) and `compat` (save files that predate a field),
`recode` (numbering read off the layout, in both modes),
`macros` (reading `(set:)` and `(if:)` out of a body),
`workflow` (end-to-end walkthroughs), `regressions`, and `render` (mounts the real
component tree in jsdom and fails on any Vue warning — the only check that catches
template-only mistakes, which `vue-tsc` cannot see).

`render` catches template mistakes but not visual affordances: a `<summary>` styled
`display: flex` loses its native disclosure triangle, and only opening a browser
showed it. That disclosure is gone — the Code field it hid now sits plainly on the
inspector's Advanced tab, and no `<details>` remains in the app — but the lesson it
paid for stands. Prefer a real look for anything whose failure mode is "renders, but
reads wrong".
