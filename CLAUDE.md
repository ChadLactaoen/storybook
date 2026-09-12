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
tree. Two invariants drive nearly every design decision in the repo:

**1. The document is the only persisted state; layout is a pure function of it.**
`StoryDoc` (`src/types/story.ts`) is exactly what is serialized. No coordinate, level,
ordering or edge path is ever saved — `layoutStory(doc)` recomputes all of it. The one
positional field in the document is `StoryNode.levelOffset` (0 or 1), a lower bound fed
into layering. This is why inserting a passage mid-story "auto-refactors" levels: there
is nothing to refactor, levels are simply re-derived.

**2. Body prose is the only source of truth for structure.** Edges are not stored.
`deriveGraph` parses each `body` for `[[...]]` links (`src/lib/harlowe/links.ts` handles
all four Twine forms) and those links *are* the edges. Passage titles are the link
targets, so renaming must cascade through inbound link text — and deriving must never
create real nodes, or a deleted-but-still-linked passage would be resurrected on the
next re-derive. Unresolved targets become *phantoms* (`phantom:`-prefixed ids) that
participate fully in layout but exist only in the derived graph.

### Layers

| Path | Role |
|---|---|
| `src/types/story.ts` | The document model, its canonical comparators (`compareStr`, `compareNodes`, `compareByName`) and `emptyCharacter` / `emptyDoc` constructors |
| `src/lib/doc/` | `mutations.ts` (all document edits), `serialize.ts` (canonical JSON + repairing parse), `storage.ts` (localStorage), `file.ts` (import/export) |
| `src/lib/graph/` | Deterministic Sugiyama pipeline; `layoutStory` in `layout.ts` is the only entry point the UI touches |
| `src/lib/harlowe/` | `links.ts` (parse/retarget), `highlight.ts` (macros are highlighted, never executed) |
| `src/stores/story.ts` | Module-level singleton store: a `reactive` state object plus exported functions and computeds. Not Pinia |
| `src/components/`, `src/composables/` | Presentation; viewport pan/zoom and global shortcuts |

The graph pipeline runs `derive → acyclic → layering → components → layered → ordering /
crossings → xcoord / tidy → routing` (each a module of that name); `paths.ts` counts distinct
paths as `BigInt`. `README.md` has a per-module table.

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
document) and memoizes on a hash of only the fields layout depends on — id, title,
`levelOffset`, body, `startNodeId` — so tag/state edits are pure re-renders.
`layoutVersion` is a stale-result guard so layout can later move into a Web Worker.

### Tests

`src/test/helpers.ts` builds documents from a compact adjacency spec: `docFrom({ One:
['Two'] })`. Files are split by concern rather than by source file — `doc` (links,
rename cascade, tags, save file), `layering` / `layout` (levels, geometry, determinism,
paths), `scene` (settings, cast), `profile` (character sheet traits and relations),
`workflow` (end-to-end walkthroughs), `regressions`, and `render` (mounts the real
component tree in jsdom and fails on any Vue warning — the only check that catches
template-only mistakes, which `vue-tsc` cannot see).
