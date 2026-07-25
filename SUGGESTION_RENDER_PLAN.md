# Suggestion Render Plan — unified fragment rendering

Status: **design agreed, not started.**

## The problem

Today there are **two renderers**:

1. **Committed sentences** go through the universal renderer
   (`renderSentencesToHTML`): block commands become headings, `&meta`
   settings apply, the outline builds, references resolve. Everything works.
2. **Suggestions** go through a *separate, shallower* path: `applyToSpans`
   overlays a word-level diff onto each sentence's span, plus a
   special-cased `applyStructuralSuggestion` re-parenting hack for when a
   suggestion turns a sentence into a block command.

The consequence: a suggestion that introduces `&meta`, restructures with
`&title`/`&part`/`&chapter`, or adds references **doesn't actually work in
preview** — the shallow path doesn't run settings, outline, or true command
rendering. It only *looks* structural via accreting hacks. The bug that
surfaced this: a suggested `&meta{chapter-align}{center}` shows as literal
text and doesn't center chapters, because settings are read from committed
sentences, not suggestions.

## The invariant we must not break

**One DB sentence = one sentence ID = one ordinal.** The author's standard
edits — "add a sentence by appending to an existing one", "start a chapter by
editing the last sentence and appending block-level content" — keep the
manuscript as *one* DB sentence per real sentence, so:

- Following sentences never shift ordinal, so their content-addressed IDs
  (`GenerateSentenceID` hashes the ordinal) don't churn in preview.
- Annotations stay attached to stable IDs while editing.

Confirmed by test: inserting a sentence shifts every following sentence's
hashed ID. So we must never re-segment a suggestion into multiple *DB*
sentences at preview time. (At **commit**, the real migration re-segments and
re-pairs annotations by content via `ComputeSentenceDiff`/`bestPreviousByNew`
— that already works and is unaffected by anything here.)

## The universal model

**A DB sentence renders as a SEQUENCE of fragments, all sharing the
sentence's real ID.** This reuses machinery that already exists: paged.js
splits one sentence across page fragments today, and hover/click/annotation
handlers already query `.sentence[data-sentence-id="X"]` as a *set* and
operate on every matching fragment (see `setupSentenceHover`). We borrow that
"one ID, many fragments" pattern for suggestion-induced fragments.

For each DB sentence, the renderer:

1. Takes its **effective text** — the suggestion if one exists, else the
   committed text.
2. **Segments that text into fragments** at block boundaries (`\n\n`, `\n\t`,
   and block-command boundaries) — the same block logic already applied
   *across* DB sentences, now applied *within* a sentence's effective text.
3. Renders each fragment by its **kind**, and paints its **diff** (vs. the
   corresponding part of the original) in the representation appropriate to
   that kind.

No interim IDs: fragments borrow the real sentence ID. No ordinal churn: it's
still one DB sentence. The structural passes (settings, outline) read the
*effective* (segmented) fragment sequence, so suggested structure works.

### Fragment kinds and their diff-representations

The key simplifying law (committed to permanently):

> **Commands are structural, never prose-bearing.** A fragment is either
> prose (which may *contain* inline commands) or a structural command. This
> makes "how do I diff this fragment" a hard yes/no from the parser, not a
> heuristic — and it means the diff/no-diff boundary always falls *between*
> fragments, never *within* one. So there is no diff-alignment-across-block-
> boundary problem.

| Fragment kind | Renders as | Diff representation |
|---|---|---|
| **Prose** (may contain inline `&reference`/`&anchor`) | a `<p>`/`<p class=indented>` with the prose; inline commands as links/markers | **word-level diff** (`<del>`/`<ins>`) — the fine-grained one prose needs |
| **Structural break** (`\n\n` / `\n\t`) | the block boundary (new `<p>` / section gap) | **glyph diff**: struck `§`/`¶` if the break was removed, green `§`/`¶` if added, nothing if unchanged (today's `renderStructuralMarkers`, kept) |
| **Block command** (`&title`/`&part`/`&chapter`/ block `&anchor`) | its structural form (heading / page / marker) | **result only, no diff** — a `Chapter 1`→`Part One` change is reviewed by seeing the new heading, not word-comparing labels |
| **Meta** (`&meta`) | nothing | **none** — its effect (a setting) simply applies |

The insight the glyphs gave us: word-diff is just *one* diff-representation
(for prose). Structural breaks have their own (glyphs). Block commands have
their own (render the result). Meta has its own (nothing). The renderer picks
the representation by fragment kind — one rule, glyphs included.

### Identity of block fragments

A block-command fragment born from a suggestion (e.g. editing the last
sentence to append `\n\n&chapter{...}`) renders as its **result** (a real
`<h*>` block, structurally a sibling) and can carry its **own** structural
identity in preview (its slug, its outline entry) — it is not pretending to
be the prose sentence it was appended to. The prose fragment(s) keep the
source sentence's real ID for annotation/hover. Neither needs a *DB* ID in
preview; commit re-derives everything. This resolves the "share one ID
muddiness" — prose fragments share the source ID; block fragments are their
own structural things shown as results.

## Settings from effective text

`&meta` settings are computed from the **effective** text of all sentences
(committed overlaid with suggestions): a suggested `&meta` applies live; a
suggestion that removes/edits a committed `&meta` drops/changes the setting.
Because settings extraction reads *text*, not the DOM, this works regardless
of fragment nesting — it's the cleanest part. (This alone fixes the reported
bug.)

## Outline from effective fragments

The outline is built from the effective fragment sequence, so suggested
structure (a suggested `&part`/`&chapter`) shows in the left-margin nav before
commit. (Server-side outline is built from committed sentences; a preview
outline overlays suggestions client-side, or the endpoint accepts a suggestion
set — decide at build time.)

## What this replaces

- Deletes `applyStructuralSuggestion` (the re-parenting hack).
- Unifies `applyToSpans`' diff overlay and the structural render into one
  pass driven by fragment kind.
- Net *less* special-casing than today: one "segment into fragments, render
  each by kind" rule instead of the growing pile of structural-suggestion
  cases.

## Hard cases / open items (verify during build)

1. **Diff alignment** — solved by the law: the diff/no-diff boundary is
   always *between* fragments (prose vs. command), never within one. Within a
   prose fragment, existing word-diff applies. Structural breaks diff as
   glyphs. Confirm no case produces a "half prose half command" fragment.
2. **Inline `&reference`/`&anchor` in a diffed prose fragment** — decide:
   diff the raw `&reference#...{...}` text then render as a link, OR exclude
   the command token from the word-diff and render it as a link within.
   (Presentation detail; prose around it diffs normally either way.)
3. **A suggestion removing a block boundary** (merging two blocks into one) —
   the glyph diff already handles a removed `\n\n`/`\n\t` (struck glyph); a
   removed *command* just stops rendering its block. Confirm the merged prose
   diffs cleanly.
4. **Preview outline source** — client-side overlay vs. endpoint-with-
   suggestions. Client-side keeps the server simple; endpoint is reusable.
5. **paged.js re-pagination** — the fragment sequence changes when a
   suggestion adds a block; confirm re-pagination keeps annotation/scroll
   anchoring (it already re-runs on suggestion changes).

## Phasing

1. **Settings from effective text** (fixes the reported `&meta` bug;
   smallest, independent, no fragment work).
2. **Fragment model in the renderer** — segment effective text into fragments
   sharing the sentence ID; render prose/break/command/meta by kind; wire the
   glyph diff and word diff into the one pass; delete
   `applyStructuralSuggestion`.
3. **Preview outline** overlaying suggestions.
4. **Polish** — inline-command-in-prose-diff detail; block-command "changed"
   affordance (currently: none, just the result).

Each phase is independently shippable and testable (Go + Playwright).
