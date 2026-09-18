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
those links *are* the edges. A link names a passage's **code** — a short unique
handle like `3A` — never its title, so titles are free to repeat as often as the
story wants them to.

The same reasoning gives a reader's story its identity. The ordered codes of the passages
they visited *are* their route — `P1->P3->P7` — exact by construction, so two readers who
chose differently cannot land on the same string however often their paths merge. Nothing
generates it: Harlowe's `(history:)` already returns that sequence, because links point at
codes and codes are the Twine passage names.

Conditional links are read the same way. A story that does `(set: $idol to "Sakura")` in
one passage and gates a later link on `(if: $idol is "Sakura")` has said something the
links alone cannot — that only readers who made the first choice can take the second.
That is pattern-matched out of the prose, never executed, so the sidebar can say which
choice a passage is locked behind, or that no route reaches it at all.

## Authoring

| | |
|---|---|
| Link forms | `[[Code]]`, `[[Text\|Code]]`, `[[Text->Code]]`, `[[Code<-Text]]` |
| Code | Every passage has one, unique and case-sensitive (`3A` is not `3a`). Auto-assigned as `P1`, `P2`, … and yours to rename. A new passage follows the shape the story is already in, so after a **Recode** to `T01`, `T02`, … the next one is `T03` rather than `P3` |
| Title | A name for you. Two passages may share one, and no link ever reads it |
| Note | Optional, up to 30 characters of free text, for you. Shows on the card in place of the code and is searchable; nothing structural reads it |
| Story notes | A scratchpad for the story as a whole &mdash; **Story** &rarr; **Story notes**, or `Cmd J`. Opens in the left column, under **Cast & Settings** or the cheat sheet if one is already there. Saved and exported with the story; nothing structural reads it, and search does not match it |
| New passages | A link to a code that doesn't exist creates the passage, in TODO state, when you leave the editor. Write a bare `[[Head north]]` and it gets a code of its own, written back into the link as `[[Head north\|P7]]` |
| Formatting | `''bold''`, `//italic//` and `> quoted` lines, from the editor's buttons or `Cmd B` / `Cmd I` / `Cmd Shift .`. Pressing the same one again takes it off |
| Changing a code | Rewrites the target half of every inbound link; display text is untouched. A colliding or empty code is blocked, as is one containing link syntax |
| Recoding everything | **Edit** &rarr; **Recode** renames every passage&rsquo;s code at once, from the tree as drawn. **Level and node** gives `3N01` &mdash; the level, then the position within it, left to right. **Node** gives `P04` &mdash; the position in the whole story, top to bottom, left to right within each level. Both take a prefix and a separator, so `3/01`, `L3P01` or a bare `04` are all available. Numbers are padded to at least two digits &mdash; `P04`, `3N01` &mdash; and wider once the story needs it, so codes sort in the order they are drawn and growing past ten does not rewrite every code. Inbound links follow; a link to a passage that doesn&rsquo;t exist is left alone. One undo step |
| Renaming a title | Just a field write. Nothing points at a title, so nothing has to follow it |
| Deleting | Leaves inbound `[[...]]` alone — your prose is never rewritten. The link shows as a dashed phantom card you can click to recreate. Refused if it would cut a surviving passage off from the start |
| Tags | Story-global, reusable from a dropdown, colour-coded from Twine's palette. Recolouring a tag repaints every passage carrying it. A tag sticks around once created, so it stays offerable &mdash; **Tags** &rarr; **Remove** clears out one nothing carries |
| Setting | Free text, with autocomplete from settings already used. A passage linked from another inherits its setting |
| Characters | A story-global cast roster, kept in the author's own order — leads first, walk-ons last. A passage picks its cast from the roster and gives each one a note for *that scene* |
| Character sheet | Per character: a description, plus **Personality**, **Dialogue characteristics**, **Mannerisms** and **Relations** as discrete key points. Open it from the index or from a passage's cast |
| Relations | One-directional — Mira→Tam records only how Mira regards Tam. The sheet shows the reverse as dimmed read-only context. Renaming or deleting a character cascades through every relation |
| Story index | **Story** → **Cast & Settings** (`Cmd ;`): every setting and character with a passage count. Click a row to filter the tree; rename from here to update every passage at once. The cast lists in roster order, reordered with the ▲▼ arrows on each row or alphabetized with **Sort A–Z** |
| State | TODO / Draft / Done, shown as a coloured badge on each card |
| Endings | Tick **Mark as Ending** in the sidebar and the card gets a teal underline and an **END** flag. Never guessed for you &mdash; a passage with no links yet is indistinguishable from one you meant to finish. Routes stop at an ending, so the endings divide the story's routes between them rather than overlapping, and anything linked *past* one is unreachable (Story stats says so) |
| Reader | **Story** &rarr; **Play**, the toolbar button, or `Cmd P`: read the draft back a choice at a time, as a book page. Conditions actually run, so you can watch which branch fires; a console shows the variables you are carrying, which passage set each, the route so far as `P1->P3->P7`, and the marks collected along it &mdash; where a card has to write `A*D` because the routes disagree, the console says which one you took, `ABD`. **Sidebar &rarr; Advanced &rarr; Play from here** starts anywhere, with everything unset and a note saying so. Read-only &mdash; a session never changes the story |
| Tags | **Story** &rarr; **Tags**, or `Cmd G`: every tag with the passages carrying it and the share of routes that run through at least one of them. Tick several and it answers the harder question &mdash; how many routes collect *all* of them somewhere along the way, in any order, across any passages &mdash; and how many collect none. Click a count to break the tag down by level &mdash; how many passages carry it at each depth and what share of that level they are &mdash; with the passages listed underneath; click a level to narrow that list to it. **Filter** shows them on the tree instead. A tag no passage carries offers **Remove** instead, which clears it from the story and from the filter chips; a tag still in use is refused rather than stripped off the passages carrying it |
| Story stats | **Story** &rarr; **Stats**, the routes pill, or `Cmd /`. Word count, every ending with the share of routes reaching it, and a draft-health list &mdash; broken links, unreachable passages, dead ends you never marked. Click any row to jump to the passage. Computed when you open it, not as you type |
| Levels | Assigned automatically. A passage can be nudged down exactly one level; moving up is structurally impossible and the inspector says which parent pins it |
| Story codes | A reader's route is the codes of the passages they visited, `P1->P3->P7`. Print it at the end of your story with `(joined: "->", ...(history:), (passage:)'s name)` |
| Conditional links | An `(if: $v is "x")` guarding a link is read and matched against the `(set: $v to "x")` that supplies it. When every route into a passage needs the same value, the sidebar names the choice it is locked behind. Only `if` and `else-if` with a plain `$v is "…"` are read |
| Dead branches | If nothing supplies the value a passage's incoming conditions test — a mistyped `"sakura"` — the sidebar says nothing reaches it |
| Codes on cards | Turn on under **Settings** to show each passage's code above its card |

Harlowe macros, hooks and variables are syntax-highlighted, and `(set:)` and `(if:)` are
*read* for what they say about which routes exist. **The map never executes anything** — it
is a map of the story, not a player for it.

The reader is where a story is played, and it is a sandbox off to one side. `run.ts`
evaluates a passage's macros to show what a reader would see, and none of that ever reaches
the graph, the layout, the gates or the stats — it imports nothing from them and exports
nothing to them. Nothing is `eval`'d either: the evaluator reads a narrow slice of Harlowe
and renders everything it cannot read, marked, rather than guessing at it.

## Interaction

The bar groups its commands the way a desktop app does &mdash; **File**, **Edit**,
**View**, **Story**, **Help** &mdash; and every menu row carries its own shortcut, which is
where you learn them. What stays a button is what you reach for constantly: the zoom
stepper, undo and redo, and **Play**. Each command is described in exactly one place
(`src/lib/ui/commands.ts`), so the menus, the tooltips and the shortcut list below cannot
disagree.

Press **?** (or **Help** &rarr; **How Storybook works**) for a panel covering how levels
work, the link syntax, and the full shortcut list.

**Expand**, above a passage's body, reopens the same editor over the whole
window for longer prose; it writes the same document, so there is nothing to
save when it closes. The expanded editor carries a formatting row — bold,
italic, quote and link — and every one of those is a shortcut in the sidebar
editor too.

`Cmd Shift K` links the selected words to a passage. It asks which one first,
listing each passage by code and title and matching on either: a target is never
half-typed into the document, so choosing an existing passage cannot leave a
stray one behind. Typing a name that isn't on the list writes a bare link, and
the passage behind it is created when you leave the editor.

**Recode** previews the whole result before anything is written &mdash; every old &rarr; new
pair, re-read off the tree as you type the prefix or separator. The rows are the settled
answer, not a first guess at it: what you read is exactly what the document receives. It
warns when a new code is one a dangling link already names, because that link would stop
dangling and the tree would change shape. Applying is a single undo step, and pressing
Recode again with the same settings does nothing.

Wheel or pinch to zoom at the cursor, drag the background to pan.
`Cmd +` / `Cmd -` zoom, `Cmd 0` zooms to fit, `Cmd 1` resets to 100%.
`Cmd F` focuses search, `Cmd G` opens the tag analyzer, `Cmd J` opens the story
notes, `Cmd Z` / `Cmd Shift Z`
undo and redo, `N` adds a
passage, `Delete` removes everything selected. Formatting keys are handled by
the editor itself rather than the global map, so they only fire where a
selection means something.

The left column holds one of **Cast & Settings** or the **Character Cheat
Sheet**, with **Notes** under it; open together they split it in half.

`Cmd`-click a card to select it and everything it leads to, `Shift`-click to add
or drop one, and click the background to clear. With more than one selected the
sidebar lists them and offers a single delete.

Work auto-saves to `localStorage` on a short debounce. **Export** downloads the
canonical JSON; **Import** reads it back.

## Layout engine

`src/lib/graph/` is a deterministic Sugiyama pipeline:

| Module | Job |
|---|---|
| `derive` | parse bodies into a graph, resolving link targets against passage codes; unresolved links become phantoms |
| `acyclic` | designate back edges with a canonical DFS (loops are normal in CYOA writing, never errors) |
| `layering` | longest-path levels, with the user's offset folded in as a lower bound |
| `components` | lay out disconnected fragments separately, pack left to right |
| `layered` | insert dummy nodes so multi-level edges route through inter-node gaps instead of across cards |
| `ordering` / `crossings` | DFS seed, weighted-median sweeps, Barth–Jünger–Mutzel crossing counts |
| `xcoord` | lay each component out, then pack them left to right |
| `tidy` | bottom-up rigid-subtree placement: parents land on the midpoint of their outermost children — exactly so for a tree, best effort once a passage has two parents |
| `routing` | C1-smooth cubics, straight-run collapse, arrowheads clipped to card boundaries |
| `paths` | distinct path counts as BigInt (they grow exponentially), forwards from a passage, backwards to one, and forwards while avoiding a set of passages; also the one definition of an edge a route can take |
| `stats` | word count, the routes reaching each ending, and the draft-health lint |
| `recode` | a numbering read off the drawing, so codes can be renamed to match the tree |
| `gates` | what conditional links prove: which choice a passage is locked behind, and which branches are dead |
| `slugs` | the running slug per passage &mdash; the marks along the route here, with `*` where the routes disagree |
| `tags` | how much of the story a tag covers, counted in routes rather than passages &mdash; which routes collect several at once, and where the tagged passages sit, level by level |
| `macros` *(in `lib/harlowe/`)* | reads `(set:)` and `(if:)` as text, so a guarded link can narrow a trail |
| `run` *(in `lib/harlowe/`)* | the reader's evaluator: a passage's prose, choices and variables, as typed nodes &mdash; a sandbox that feeds nothing above |

`layoutStory(doc)` is the only entry point the UI touches: pure, synchronous and
clone-friendly, so it can move into a Web Worker without a redesign. `paths` and `gates`
are analyses over the graph it retains, run by the store on demand — neither one moves a
card, and neither belongs in the layout memo.

Determinism is load-bearing and enforced deliberately: `Map` over plain objects,
canonical iteration arrays instead of `Map.keys()`, codepoint compares instead of
`localeCompare`, total comparators that never lean on sort stability, fixed
iteration budgets, no transcendentals, and no DOM text measurement. The property
test asserting `layout(doc) === layout(shuffle(doc.nodes))` is the one that keeps
all of it honest.
