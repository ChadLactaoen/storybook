# Storybook

A browser app for visualizing choose-your-own-adventure stories as a level-aligned
tree of passages, in the spirit of Twine.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit + integration + render smoke tests
npm run build    # type-check with vue-tsc, then bundle
```

## How it works

**Layout is a pure function of the saved document.** Nothing positional is ever
persisted — levels, ordering, coordinates and edge paths are all recomputed from
the JSON on every change. Three requirements fall out of that one decision:

- the save file is idempotent (same JSON always renders the same way),
- inserting a passage mid-story re-levels its descendants automatically, because
  there is nothing to refactor — the levels are simply re-derived,
- adding or removing a passage redraws the whole tree with proper spacing.

Structure is derived from the prose: each body is parsed for `[[...]]` links, and
those links *are* the edges. Passage titles double as link targets, exactly as in
Twine.

## Authoring

| | |
|---|---|
| Link forms | `[[Target]]`, `[[Text\|Target]]`, `[[Text->Target]]`, `[[Target<-Text]]` |
| New passages | Linking to a title that doesn't exist creates it, in TODO state |
| Renaming | Rewrites the target half of every inbound link; display text is untouched. A colliding rename is blocked |
| Deleting | Leaves inbound `[[...]]` alone — your prose is never rewritten. The link shows as a dashed phantom card you can click to recreate. Refused if it would cut a surviving passage off from the start |
| Tags | Story-global, reusable from a dropdown, colour-coded from Twine's palette. Recolouring a tag repaints every passage carrying it |
| Setting | Free text, with autocomplete from settings already used. A passage linked from another inherits its setting |
| Characters | A story-global cast roster, kept in the author's own order — leads first, walk-ons last. A passage picks its cast from the roster and gives each one a note for *that scene* |
| Character sheet | Per character: a description, plus **Personality**, **Dialogue characteristics**, **Mannerisms** and **Relations** as discrete key points. Open it from the index or from a passage's cast |
| Relations | One-directional — Mira→Tam records only how Mira regards Tam. The sheet shows the reverse as dimmed read-only context. Renaming or deleting a character cascades through every relation |
| Story index | Toolbar → **Index**: every setting and character with a passage count. Click a row to filter the tree; rename from here to update every passage at once. The cast lists in roster order, reordered with the ▲▼ arrows on each row or alphabetized with **Sort A–Z** |
| State | TODO / Draft / Done, shown as a coloured badge on each card |
| Levels | Assigned automatically. A passage can be nudged down exactly one level; moving up is structurally impossible and the inspector says which parent pins it |

Harlowe macros, hooks and variables are syntax-highlighted. They are **not**
executed — this is a map of the story, not a player for it.

## Interaction

Press **?** (or the toolbar button) for a panel covering how levels work, the
link syntax, and the full shortcut list.

**Expand**, above a passage's body, reopens the same editor over the whole
window for longer prose; it writes the same document, so there is nothing to
save when it closes.

Wheel or pinch to zoom at the cursor, drag the background to pan.
`Cmd +` / `Cmd -` zoom, `Cmd 0` zooms to fit, `Cmd 1` resets to 100%.
`Cmd F` focuses search, `Cmd Z` / `Cmd Shift Z` undo and redo, `N` adds a
passage, `Delete` removes everything selected.

`Cmd`-click a card to select it and everything it leads to, `Shift`-click to add
or drop one, and click the background to clear. With more than one selected the
sidebar lists them and offers a single delete.

Work auto-saves to `localStorage` on a short debounce. **Export** downloads the
canonical JSON; **Import** reads it back.

## Layout engine

`src/lib/graph/` is a deterministic Sugiyama pipeline:

| Module | Job |
|---|---|
| `derive` | parse bodies into a graph; unresolved links become phantoms |
| `acyclic` | designate back edges with a canonical DFS (loops are normal in CYOA writing, never errors) |
| `layering` | longest-path levels, with the user's offset folded in as a lower bound |
| `components` | lay out disconnected fragments separately, pack left to right |
| `layered` | insert dummy nodes so multi-level edges route through inter-node gaps instead of across cards |
| `ordering` / `crossings` | DFS seed, weighted-median sweeps, Barth–Jünger–Mutzel crossing counts |
| `xcoord` | lay each component out, then pack them left to right |
| `tidy` | bottom-up rigid-subtree placement: parents land on the midpoint of their outermost children — exactly so for a tree, best effort once a passage has two parents |
| `routing` | C1-smooth cubics, straight-run collapse, arrowheads clipped to card boundaries |
| `paths` | distinct path counts as BigInt (they grow exponentially) |

`layoutStory(doc)` is the only entry point the UI touches: pure, synchronous and
clone-friendly, so it can move into a Web Worker without a redesign.

Determinism is load-bearing and enforced deliberately: `Map` over plain objects,
canonical iteration arrays instead of `Map.keys()`, codepoint compares instead of
`localeCompare`, total comparators that never lean on sort stability, fixed
iteration budgets, no transcendentals, and no DOM text measurement. The property
test asserting `layout(doc) === layout(shuffle(doc.nodes))` is the one that keeps
all of it honest.
