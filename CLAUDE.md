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

Vitest runs in `node` by default. `src/test/render.test.ts` is routed to `jsdom` by
`environmentMatchGlobs` in `vitest.config.ts`; `commands.test.ts` and `regressions.test.ts`
ask for it themselves with a `// @vitest-environment jsdom` line, which is the lighter way
to add one.

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

**4. A macro may be read, never executed — everywhere the map is concerned.**
`run.ts` is the one exception and it is not a hole in the rule, it is the rule's other
half: the reader is a sandbox whose results reach nothing. It imports nothing from
`gates.ts` or `paths.ts` and exports nothing to either, and it `eval`s nothing — it reads a
narrow slice of Harlowe and *renders* what it cannot read rather than guessing. The
direction inverts there, deliberately: `gates.ts` fails closed because a wrong gate states
something false about the story, while `run.ts` fails open because a hidden hook deletes
prose the author wrote. Wire the reader's broader evaluator into gate inference and
`(if: $v is not "x")` — which it reads and `gates.ts` refuses — starts producing gates,
which is the exact soundness break the rest of this invariant is about.

`deriveGraph` sees only `[[...]]`, so a
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
| `src/lib/graph/` | Deterministic Sugiyama pipeline; `layoutStory` in `layout.ts` is the only entry point the UI touches. `paths.ts`, `gates.ts`, `coverage.ts` and `stats.ts` are analyses over the derived graph, called by the store and the panels rather than by `layoutStory` |
| `src/lib/harlowe/` | `links.ts` (parse/retarget), `highlight.ts` (macros are highlighted, never executed), `macros.ts` (macros are *read* — spans and names — still never executed), `run.ts` (the reader's evaluator: the one place a macro is acted on, in a sandbox that feeds nothing above it) |
| `src/lib/publish/` | The standalone demo: `payload.ts` (the key graph), `crypto.ts` (the six primitives, one place), `html.ts` (assembly), `styles.ts` (the four themes' stylesheet), `themes.ts` (their names and fonts — pure data, read by both the editor's prefs and the bundle), `sample.ts` (the story a theme preview plays), `publish.ts` (orchestration: to a file, or to a tab) and `player/` (the bundled runtime, built by `vite/plugins/player-bundle.ts`) |
| `src/lib/ui/` | `commands.ts` (the one description of every command — label, group, chord, hint) and `platform.ts` (the one answer to what this keyboard's modifier is called). Pure data: no Vue import, so it tests in `node` |
| `src/stores/story.ts` | Module-level singleton store: a `reactive` state object plus exported functions and computeds. Not Pinia |
| `src/components/`, `src/composables/` | Presentation; viewport pan/zoom and global shortcuts |

The graph pipeline runs `derive → acyclic → layering → components → layered → ordering /
crossings → xcoord / (tidy | straight) → routing` (each a module of that name). Alongside it sit the
analyses the pipeline never calls: `paths.ts` counts distinct paths as `BigInt` (both
forwards from a passage and backwards to one) and owns the one definition of a route edge,
`gates.ts` reads what the story's `(if:)` macros say about which routes exist, `slugs.ts`
spells out what a reader would have collected on the way to a passage, `coverage.ts`
measures how much of the story something covers — with `tags.ts` and `characters.ts`
supplying the vocabulary —
`recode.ts` reads a numbering off the drawing, and
`stats.ts` totals the story — words, the routes reaching each ending, and the draft-health
lint — only when the panel asks. `README.md` has a per-module table.

### Rules that are load-bearing

**Every mutation returns a fresh document, and none writes to an object it did not
itself create.** `mutations.ts` is pure: nothing there reads layout, and layout never
writes back. The second clause is the precise form of the rule, and it is narrower than
"copy everything" on purpose. `clone()` is the one way to acquire writable objects — it
must copy every array- and object-valued field, and the mutations that genuinely do
assign in place (`setTagColor`, `renameTag`, `renameSetting`, `recodeAll`, the roster
edits) all call it first and write only onto what it handed back. Anything reached from
the *input* document is read-only, because that document is also sitting on the undo
stack: aliasing it means editing the present silently rewrites the past, and only
surfaces as a broken undo much later.

That distinction is what lets `replaceNode` share. Patching one passage copies the
document shell, the nodes array and the one node; every untouched passage, and every
`tags` array on it, keeps its identity. Cloning wholesale instead meant the canvas could
not tell a keystroke from a rewrite — Vue compares props by reference, so all several
hundred cards re-rendered for one character typed in one body, whatever the layout memo
said. `doc.test.ts` deep-freezes a document and runs every mutation against it, so a
future caller that patches in place fails loudly instead of quietly corrupting history.

Store functions call `commit()`, which pushes onto the undo stack (limit 100) and clears
redo. `editBody` is the one exception: it goes through `commitTyping`, which folds a
continuous run of keystrokes in one passage into a single entry. A run is broken by a
pause, by leaving or reselecting, and by any other mutation (`commit` ends it for free),
so undo can never swallow something that was not typing. One entry per character made
Cmd Z walk back through a paragraph a letter at a time, and filled the hundred-deep
history with one sentence being typed — so the structural change worth undoing had
already fallen off the end.

**Layout must be deterministic.** `layout(doc)` must equal `layout(shuffle(doc.nodes))`;
a property test asserts it. That requires: `Map` over plain objects, canonical iteration
arrays instead of `Map.keys()`, codepoint comparison instead of `localeCompare` (ICU
version varies by host), total comparators that never lean on sort stability, fixed
iteration budgets, no transcendentals (see `EQUILATERAL_FACTOR` in `graph/constants.ts`,
a literal rather than `Math.sqrt(3)/2`), and no DOM text measurement.

**`transpose` decides on a delta, and that is the same comparison, not an approximation
of it.** Because the two nodes it tests are *adjacent*, nothing sits between them, so
swapping them leaves the relative order of either against every third node exactly as it
was — and a crossing is a function of two relative orders. Only the pair itself flips, so
only crossings between an edge at one and an edge at the other can change: `after -
before` is exactly `c_vu - c_uv`, and the strict `<` accepts and refuses precisely what
the full recount did, ties included. Recounting the whole layer instead made
`countBilayerCrossings` run some 43,000 times per layout on a 224-passage story rather
than 273, which was 98% of the pipeline. Two details are load-bearing: neighbours absent
from the adjacent layer are dropped, matching what `countBilayerCrossings` does with a
target it cannot place; and duplicates are kept, because two links to one passage are two
edges that cross independently. Card geometry is
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
`levelOffset`, `startNodeId`, and each body's **link signature** — so tag, state and
story-notes edits are pure re-renders. `code` is in
there because links resolve against it; leave it out and a recode goes unnoticed while
every inbound edge re-resolves to a phantom.
`layoutVersion` is a stale-result guard so layout can later move into a Web Worker.

The signature, not the body, is invariant 2 read precisely: prose is the source of truth
for structure **through its `[[...]]` links**, so layout depends on a body only by way of
`parseLinks`. Hashing the whole body made every character typed a structural change — a
full Sugiyama pass, and a full canvas re-render, per keystroke, which on a few hundred
passages is the difference between typing and waiting. The signature is the ordered list
of each link's target *and label*: a label names a phantom, so it reaches the dashed
card's title, the wire's caption, and the title written into the document when that
phantom is made real. It carries no spans, and `DerivedEdge` no longer has one — the memo
now rightly holds across a prose edit, and a span is an offset into text that edit has
moved. Anything wanting one parses the live body, as `macros.ts` and `run.ts` already do.
`DerivedGraph.stateOf` is gone for the same reason: `state` was never in the key.

The counterpart is `bodyVersion`, bumped in `setDoc` **above** the early return and
whenever any body changes at all. That placement is load-bearing: now that a prose edit
can leave the layout key untouched, anything memoized on `layoutVersion` alone would sit
on a key that never moves and hand back an answer read from prose that has since changed.

The card prop maps — `tagColors`, `cardStates`, `cardTags`, `cardEndings` — are memoized
on their own contents so they keep their identity when nothing in them moved. They go to
every card as props, so a freshly built Map, however identical, re-renders the whole
canvas; that is the half of the typing cost a memoized layout alone could not reach. They
live in the store rather than `App.vue` for that reason. `StoryCanvas` uses a shared
`NO_TAGS` constant rather than `?? []`, which would allocate a new array per untagged
card per render and undo the same work.

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

**Tags do not partition the routes, so a tag is counted by complement.** The endings
table sums `to(n)` across endings because a route stops at exactly one of them; a route
may collect the same tag three times, and a per-passage sum counts it three times. So
`coverage.ts` asks the opposite question — `countPathsAvoiding`, the routes that never
enter any passage carrying the tag — and subtracts. The same primitive answers "which
routes collect *all* of these", by inclusion–exclusion over which of the chosen tags a
route is allowed to miss, at one graph walk per subset; the cap on how many may be
combined therefore lives in the library, not in the panel, because each one added doubles
the work. Two orderings inside `forwardCounter` are load-bearing and both state something
false if tidied: `blocked` is checked **before** `endings`, or a passage that is both a
marked ending and carries the tag returns `1n` as an ending before anyone notices it is
blocked; and `kids` is **never** filtered, because `kids.length === 0` means *a route ends
here*, so pruning blocked children invents a route that stops in the middle of the story.
Like `gates.ts`, it runs outside `layoutStory` — a tag moves nothing on the canvas — and
it needs no store memo at all, because only the panel reads it and the panel only exists
while it is open. A memo keyed on `layoutVersion` alone would be the exact trap
`runningSlugs` documents, since `tags` is deliberately absent from `layoutKey`. What it
cannot see is a reader looping back: dropping back edges only ever *removes* a
collection, so "all of these" is a lower bound and "none of these" is an **upper** one —
the panel names the model rather than letting the number speak for itself.

**The same sentence holds with a character's name in it, which is why the arithmetic is
written once.** A route through three scenes Mira is cast in meets her three times, so the
count is the same complement, over the same primitive, erring the same way. `coverage.ts`
is that arithmetic, generic over one function — `KeysOf`, what a passage carries — and
`tags.ts` and `characters.ts` are adapters that own nothing but a vocabulary: the list of
keys, the combination cap, and what the buckets are called. Those three stay per-domain
deliberately. The key lists disagree (a tag is in use or merely registered; a character is
on the roster or merely cast), the cap is a tolerance rather than a law, and the labels are
wording — a tag is collected, a character is met in a passage, and `TAG_HIT_CAP` must go
on reading off `TAG_HIT_LABELS.length` rather than a shared constant. Everything else —
the zero-prune that depends on subsets being visited in ascending mask order, the unsigned
`none`, the phantom-excluded level denominator — exists once, because two copies of it
would be `forwardTargets` all over again. `characters` is absent from `layoutKey` for the
same reason `tags` is, so neither analyzer may be memoized on `layoutVersion` alone; both
panels compute on demand and memoize nowhere. What a route "meeting" a character means is
reaching a passage they are cast in — presence on the page, not a speaking part, because
`SceneCharacter` records a name and a scene note and nothing that would grade one
appearance against another.

How *often* a route collects one tag is the other legal sum, and it is legal for the
same reason: a route passes through a tag's passages exactly one number of times, so
never / once / twice / three-or-more partitions the routes the way endings do.
`countPathsByHits` (`paths.ts`) is `forwardCounter` carrying a small saturating vector
instead of one `bigint` — `h(n)[j]` is the routes from `n` collecting `j` more marks —
and `coverageHits` is what the panels ask. Two orderings carry over verbatim and
fail the same quiet way: the mark is applied **after** the terminal case, so a tagged
ending files its route at one rather than zero, and `kids` is still never filtered. The
buckets sum to `countPaths` and `buckets[0]` is `countPathsAvoiding` — both asserted,
because two counters disagreeing about one story is worse than either. What the buckets
are *not* is a bound: "at least once" is a lower bound under the dropped back edges, but
"exactly twice" is neither, since a reader who circles collects a third. The panel names
the model rather than letting the count speak for itself, and shows the breakdown only
for a single ticked tag — with two, "twice" has no one meaning. On screen the three
buckets are indented under "collecting all of these", because they *are* that row split
three ways: read flat, the share column sums past a hundred per cent. Their labels live
in the adapter beside the cap, and the cap is that adapter's own
`…_HIT_LABELS.length`, so a cap raised on its own cannot leave a bucket with no row to
print it in.

The per-level breakdown on each row is the one sum that *is* legal here, for the reason the
route counts are not: a passage sits on exactly one level, so levels partition the
*passages* the way endings partition the routes, and `sum(levels[].passages) === passages`
by construction — one pass over `nodeIds` splitting it, never two counts agreeing. It
remains a different question from the share beside it and the two do not reconcile: three
passages on level 4 may lie on one route or on nine hundred. Its denominator is the
passages on that level, counted off `doc.nodes`, **not** `LayoutResult.levels[].count` —
that one includes phantoms, and a phantom can never carry a tag, so a level with a broken
link would report every share on it as smaller than it is. The list is sparse because every
entry names its own level: a missed level is an absent row, which on a deep story is the
difference between a breakdown and a column of zeros. This is also the one thing in
`coverage.ts` that reads `nodeById` — read, never written, still outside `layoutStory`, and
still needing no memo, since the panels are the only callers and only exist while they are
open.

**A command is described once, and `useShortcuts` only dispatches.** `commands.ts` holds
every command's label, group, chord and hint; the menu bar, the help panel and the
toolbar's tooltips all render from it. They used to hold four separate copies, and the
copies had drifted — the help sheet was missing `Cmd G`, `Cmd Y`, `?` and Backspace, and
every tooltip said the literal "Cmd" to Windows and Linux. The table is *description*, not
dispatch: `useShortcuts` still owns which key does what and under which guard, because
those guards are per-command and subtle (`nativeEditing`, and the self-exempt checks that
let a sheet close with the key that opened it), and a table that stated them would be a
second implementation of the thing it describes. What holds the two together is
`commands.test.ts`, which presses every chord the table documents and asserts exactly one
handler fires — the check whose absence let the drift happen. Adding a chord to the table
without teaching `useShortcuts` about it now fails.

**A chord is matched case-folded, because a shifted letter is not spelled the same
everywhere.** macOS suppresses the shift-casing while Cmd is held and sends `z` for ⌘⇧Z,
while Ctrl Shift Z on Windows and Linux arrives as `Z`. An unfolded `case 'z'` therefore
reads redo on one platform and nothing at all on the others — which is why
`commands.test.ts` presses every shifted chord the *strict* way, upper-cased, rather than
the way the host it runs on happens to spell it.

**An open menu is not a modal, and must not join `modalOpen`.** A menu puts focus on a
`<button>`, so neither `isTyping` nor `modalOpen` catches it, and without a guard `n` would
add a passage and Delete would delete the selection behind the open panel — so `menuOpen`
stands the *unmodified* keys down. It stops there: a menu is not a veil, and `Cmd Z` and
the zoom keys still belong to the canvas under it. `AppMenuBar` handles Escape, the arrows
and Enter on `document` rather than on `window`, because `useShortcuts` means nothing by
any of them; every other key closes the menu and travels on, which is what keeps `Cmd P`
from opening a Play tab while a panel is still up — every other key *except* a
lone `Shift`, `Meta`, `Control` or `Alt`, since every chord begins with one of those
arriving on its own and closing there would dismiss the menu before the second key was
pressed. It listens on `document`, and focuses the title on open, because Safari and
Firefox do not focus a `<button>` when it is clicked: bound to the bar, Escape would never
arrive, and the menu could only be dismissed by clicking away while `menuOpen` went on
swallowing the canvas keys.

**The toolbar has to fit, because it can no longer scroll.** `overflow-x: auto` used to
hide the fact that twenty-six controls did not, and it would clip the menu panels hanging
below the bar. With `overflow: visible` anything that does not fit spills off-screen and is
unreachable rather than scrolled to, so the media queries at the foot of `AppToolbar.vue`
give way in a deliberate order — the tally, then the saved label, then the readouts
entirely, then the zoom stepper, which goes last because every item in it is also a
shortcut, a trackpad pinch and a row in the View menu. Play is never the thing that falls
off the edge. Those queries sit at the end of the stylesheet on purpose: they match the
same single class as the rules they override, so earlier ones would simply lose.

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
`layoutVersion` **and** `bodyVersion`. Move it into `layoutStory` and every keystroke
re-parses every macro in the story. `layout.test.ts` asserts notes do not perturb
geometry, and `workflow.test.ts` asserts a note edit leaves `stats.hash` untouched.

Both halves of that key are needed, and each covers a case the other cannot see.
`gatesOf` reads the graph, the back edges and every node's level, so a bare `levelOffset`
nudge moves a gate without touching a body. `readStoryMacros` reads bodies — and since
layout is now memoized on structure, editing `(set: $key to "yes")` into `"no"` changes
no link and so moves no layout. On `layoutVersion` alone this computed would re-run and
then hand back the previous map: stale and recomputed at once, the exact trap
`runningSlugs` documents. A gate that outlived its macro is the confident lie invariant 4
exists to prevent, which is worth a second counter to avoid.

**The macro layer must not depend on the graph.** `readStoryMacros` builds its edge keys
as `${id}|${ordinal}` to match `EdgeId` (`derive.ts`, the only place one is constructed).
A test asserts the two agree, because a drift there attaches a guard to the *wrong* edge
— the single failure mode that produces a confident lie rather than a missing gate. For
the same reason nothing in `macros.ts` counts links itself: `parseLinks` skips an
empty target without consuming an ordinal, so the caller maps guards to links by span.

The memo is about the parse, not about render identity: `gates` reaches no card — only
`selectedGate` and the inspector read it. It exists so that an edit reaching no macro (a
tag, a state, a note, the story's scratchpad) does not re-scan every body in the story.

**A published demo carries the evaluator, and unlocks as it is read.** Publish writes one
self-contained `.html` file: `run.ts` bundled as an IIFE, plus every reachable passage
gzipped and AES-GCM-encrypted under its own random key. Each key is wrapped once per
*inbound link* under a key derived from the link's source, so a passage opens only for
someone who has walked a real route to it. Four things about that are load-bearing:

- **Keys are per node, wrapped per edge.** Keying by route is the obvious reading of
  invariant 3 and it is exponential — `paths.ts` counts routes as `BigInt` for a reason.
  Per node is linear in edges and gives the property actually wanted: you need *some*
  predecessor, which inductively means some full route from the start.
- **A dangling edge must not be wrapped.** `deriveGraph` emits an edge for every parsed
  link, including ones whose target is a phantom with no passage and so no blob. Wrapping
  one hands the player a key that opens nothing — a crash where the design calls for a
  disabled choice. Its *absence* is how the player learns the link is dangling, which is
  why no code map ships.
- **Compress, then pad, then encrypt.** Padding before compression is worse than not
  padding: zeros compress away, so the output would track content length exactly while
  looking hidden.
- **The player builds DOM, never HTML strings.** `run.ts` escapes nothing because Vue
  escapes unconditionally, and that property does not travel into a published file. Nodes
  and `textContent` make the escaping bug impossible rather than merely avoided.

What it buys is that reading ahead costs *writing a program* rather than pressing Ctrl+F.
It does not stop a mechanical walk of the graph, and no single file could — everything
needed to play is in it. Hardening the derivation would not help either, since a player
pays per step taken while an attacker pays per edge once. Do not describe it as more than
this, in the UI or anywhere else.

**Play is the published page in a tab, not a second reader.** `publishStory` and
`openInTab` both go through `buildPage`, and the only thing Play adds is `payload.author`,
which switches on a console under the page. There is no in-editor reader any more: a
second one would drift from the file readers actually get, the way the Vue reader and the
player had already started to. Four things hold it together:

- **The tab opens before the first `await`.** A popup blocker allows `window.open` only
  while the click or key press is still being handled, and encrypting a story outlives
  that. So `openInTab` opens a blank tab synchronously, then sends it to a Blob URL once
  the page exists, and `playInTab` is not `async`. Put an `await` in front of
  `window.open` and Play works on a small story and is silently blocked on a large one.
- **The Blob URL is released when the tab closes, not when it loads.** A reload of the
  tab asks for it again.
- **A reader's saved theme yields to a new author default.** The player remembers `Aa`
  choices under `storyboard.reader.v1` together with the theme they overrode (`over`), and
  applies a saved theme only while that is still the author's. Play tabs share the
  editor's origin, so without `over` one click on `Aa` would outrank every theme the author
  picked after it.
- **The envelope carries the code and the mark, never the payload beside it.** The
  meta row shows `c` and the trail joins `s`, and both are sealed with the prose, because
  a list of codes in the clear is the story's shape. The trail is the literal marks of the
  route walked, not `runningSlugs`: one route cannot disagree with itself, so it never
  needs a `*`. It sits in a footer below the choices, not in the meta row: it grows with
  every passage, and in the top row a long one wrapped and pushed the title down. The meta
  row is the code alone and identical on every passage, which is what keeps an ending from
  showing itself early; an ending has no footer, since "Your trail" already shows it all.

**A `(prompt:)` halts the render, and the player replays it.** Harlowe 3 freezes a
passage's stack frame at a prompt and resumes it with the answer. `run.ts` cannot wait, so
`renderPassage` stops at the first prompt it has no answer for, returns it as `pending`
with only what came before, and the player asks in a modal `<dialog>` and renders the
passage again from the top with one more entry in `Step.answers`. That is sound because a
render up to the k-th prompt depends only on the variables carried in and the k-1 answers
before it. Three details are Harlowe's and easy to get backwards: the labels are cancel
*then* confirm, `""` hides Cancel, and Cancel returns the default whatever was typed — so
a prompt whose default cannot be read is never asked. Nor is one inside a region `run.ts`
could not establish: Harlowe may never reach it, and the write would be darkened anyway.
A prompt `run.ts` cannot run at all — inside an expression, `(print:)` or a condition —
is still reported, as an ask with no answer, because that ask is what puts the author note
on the page; without it the reader is silently never asked. A default that names a
variable reads it as it stood when the `(set:)` began, since Harlowe evaluates every
argument before it assigns any. No link key is unwrapped while a prompt waits, since the answer can change which links
render. `gates.ts` reads the same `(set:)` as an unreadable write and must go on doing so:
a typed answer is exactly what no literal in the source predicts.

A theme is CSS only (`styles.ts`); every theme styles the same markup, switched by
`data-theme` on `.reader` and `<html>`. No theme may transform the trail's text — it is
case-sensitive, and the shared rules pin `text-transform` and `font-variant` on it with
`!important` for exactly that reason.

**The player is bundled by a Vite plugin, and `configFile: false` is why it terminates.**
`virtual:player-bundle` is served by a nested `vite.build()` in lib/IIFE mode. Without
`configFile: false` the inner build re-applies the plugin and recurses — it hangs rather
than erroring, hence the tripwire in `configResolved`, which throws if the plugin ever finds
itself resolving the player's own lib build. It is not a busy flag: two loads at once are
normal (Vitest's jsdom and node graphs load the module separately), so they share one
`inFlight` build instead. Three more constraints: lib mode
returns an *array* of outputs, so it is `result[0].output[0].code`; the format must be
`iife` and the published page a classic `<script>`, because a module script is CORS-blocked
over `file://`, which is the whole delivery model; and the player's styles live in a
template literal, since a CSS import would arrive as a second output and be dropped in
silence. `publish.ts` reaches the virtual module through a **dynamic** import — a static one
would drag it into the module graph of every test that touches the store, and it keeps the
24 KB bundle out of the editor's initial chunk. `vitest.config.ts` carries the plugin too,
so what the tests mount is what the editor ships.

**Publishing is deliberately not deterministic.** Keys and nonces are random, so two
publishes of one document differ in every byte. Only the plaintext is deterministic. Do not
add a golden-hash test; `publish.test.ts` says so where someone would think to.

### Tests

`src/test/helpers.ts` builds documents from a compact adjacency spec: `docFrom({ One:
['Two'] })`. Files are split by concern rather than by source file — `doc` (links,
rename cascade, tags, save file), `layering` / `layout` (levels, geometry, determinism,
paths), `scene` (settings, cast), `profile` (character sheet traits and relations),
`gates` (inference from conditional links, and its fail-closed conditions),
`commands` (the command table, and that every chord it documents is one somebody listens
for),
`tags` and `characters` (routes through a tag or meeting a character, and the
combinations of several, each against its own brute-force walk of every route — two
oracles rather than one shared helper, since an oracle that agreed with the code under
test by construction proves nothing),
`stats` (endings, word counts, the lint, and the line between an authored link and a
route edge), `publish` (the key graph, the progressive-unlock property, and that no prose is
legible in the generated file), `player` (the reader view in jsdom, over a real payload —
the meta row and trail, endings, keys, themes, and the author console), and `compat` (save
files that predate a field),
`recode` (numbering read off the layout, in both modes),
`macros` (reading `(set:)` and `(if:)` out of a body, and the spans and chains an
evaluator needs), `run` (the reader's evaluator — what renders, what is hidden, and what
must never run),
`perf` (the typing budget — see below),
`workflow` (end-to-end walkthroughs), `regressions`, and `render` (mounts the real
component tree in jsdom and fails on any Vue warning — the only check that catches
template-only mistakes, which `vue-tsc` cannot see).

`render` catches template mistakes but not visual affordances: a `<summary>` styled
`display: flex` loses its native disclosure triangle, and only opening a browser
showed it. That disclosure is gone — the Code field it hid now sits plainly on the
inspector's Advanced tab, and no `<details>` remains in the app — but the lesson it
paid for stands. Prefer a real look for anything whose failure mode is "renders, but
reads wrong".

`perf.test.ts` defends the typing budget against a 224-passage, 16-level fixture
(`fixtures/big-story.ts`). Its assertions are counting ones, not timings: fifty prose
keystrokes must call `layoutStory` **zero** times, a keystroke that completes a link must
call it exactly once. A wall-clock budget is there too, but coarse, as a smoke check.

The fixture has to be shaped like a story rather than a tree, and that is the point of
it. `workflow.test.ts`'s 255-node budget test builds a *complete binary tree*, whose DFS
preorder seed yields zero crossings — so `orderComponent` returns at its early exit and
the ordering sweeps, the stage that costs the most by an order of magnitude, never run at
all. It measured everything except the expensive part for as long as it existed. The perf
fixture therefore branches with re-merges, skip links and a few loops back, and asserts
`stats.crossings > 0` so it cannot quietly degenerate into the same blind spot.

Assert the rendered strings, not `stats.hash`, when what changed is a caption: the hash
covers node coordinates and edge path data only, so a label left stale by a too-narrow
memo key passes every hash-equality test in the suite while the canvas shows the wrong
thing.
