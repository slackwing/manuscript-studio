# FOOTNOTES_PLAN — footnotes & endnotes

Status: **planning** (2026-09-11). Design agreed with the author in
conversation; no implementation yet. Progress tracker in §9 — tick it as
phases land, and keep §3 (settings → mechanism) in lockstep with the code.

Read this before touching notes. The one design rule that governs
everything below: **a note is part of its host sentence.** It shares the
sentence's id, its selection, its notes pane, its edit modal and its
diff. There is no separate "footnote object" anywhere in the system.

## 1. Motivation & scope

Book prose needs footnotes (page bottom) and endnotes (chapter or book
end): authorial asides, citations, translations. Both are READER-facing
book content — unlike author markers (`&marker`) and the notes pane,
which are tooling. Scope of this plan: the two commands, the settings
that choose marks / reset / placement, rendering through Paged.js,
selection and editing semantics, and suggested-edit diffs inside notes.
Out of scope for v1: a second note series (the Chicago "dual system" —
symbols for asides beside numbers for citations; the author declined),
bold or other Markdown inside notes, margin/side notes, docx round-trip,
reusing one note from two call sites.

## 2. Syntax

    &footnote{Any length of text. *Italics* or _italics_ only.}
    &endnote{Same rules.}
    &endnotes                         ← optional: print the collected endnotes HERE

- The commands ride mid-sentence, inside prose, like `&reference`. The
  generic grammar already parses them (`&keyword{arg}`, brace depth
  tracked in both the JS and Go parsers), and segman's RULE 10 keeps a
  command token atomic, so a multi-sentence note never splits its host
  sentence. Nothing in the parsers changes for v1.
- Text inside: the existing `emphasize()` rules (`*x*` / `_x_` → em).
  No bold (decided), no other Markdown, no nested commands (a `&fix` or
  `&reference` inside a note is left literal in v1).
- **No square brackets.** TeX's `\footnote[7]{…}` bracket sets the
  NUMBER, not the style; style and reset scope are document-level in TeX
  too (`\thefootnote`, class-level counter reset, `footmisc`'s
  `perpage`). We mirror that: conventions live in `&meta`, never on the
  note. Adding `[…]` would touch two parsers and the segmenter's token
  scanner for nothing.
- `&endnotes` mirrors TeX's `\theendnotes`: each occurrence prints the
  endnotes collected since the previous occurrence (or the start). If it
  appears anywhere, it overrides `endnote-place` for the notes it covers;
  notes still pending at the end of the book print at the book end.

## 3. Settings → mechanism (the capability map)

`&meta{key}{value}` (existing settings command). The author's rule for
anything outside this table: **an unmappable combination is bad syntax
and the setting is left unprocessed** (invisible, exactly like any
unknown `&`-command — we have no channel for surfacing syntax errors).
"Unprocessed" means the default stands.

| key | values | mechanism |
|---|---|---|
| `footnote-marks` | `numbers` (default) · `symbols` | CSS counter on the call and marker; `symbols` = an `@counter-style` with `system: symbolic` over `* † ‡ § ‖ ¶` (Chicago order — LaTeX swaps the last two), which the browser doubles past six (`** ††` …). Chrome 91+, Firefox 33+, Safari 17+. |
| `footnote-reset` | `page` · `chapter` · `never` | See below. Default: `chapter` for numbers, `page` for symbols. |
| `endnote-place` | `book` (default) · `chapter` | Ours (renderer): the notes block is emitted before pagination at the chapter end (before the next chapter heading) or at the book end; `book` groups the block by chapter with headings. `&endnotes` overrides. No chapters in the book → `chapter` behaves as `book`. |
| `endnote-reset` | `chapter` (default) · `never` | CSS counter reset on chapter headings / once at the start. **`page` is unmappable** (an endnote's number must survive to the block) → unprocessed. |
| `endnote-marks` | `numbers` (default) · `symbols` | Same counter styles. Symbols keep doubling and tripling past six; allowed, not pretty. |

Where Paged.js is native and where it is not — the author asked for this
list explicitly:

1. **Page-bottom placement, calls, markers, per-page area, long-note
   splitting, keeping a call on the page with its note** — native. Paged
   0.4.3 (pinned) ships the footnote module: `float: footnote` moves the
   element into the page's `@footnote` area, inserts a
   `[data-footnote-call]` element at the original spot (its `::after` is
   the call), and gives the moved body a `[data-footnote-marker]`
   (`::before` is the marker). `footnote-policy` / `footnote-display`
   exist; we take the defaults.
2. **Continuous numbering (`never`)** — native default: Paged carries the
   `footnote` / `footnote-marker` counters across pages through a
   per-page CSS variable in a plain stylesheet rule.
3. **Per-page reset** — not a Paged knob, but pure CSS: override that
   stylesheet rule so each `.pagedjs_page` resets `footnote` and
   `footnote-marker` to 0 (keeping the `pages` counter intact).
4. **Per-chapter reset** — not a Paged knob. Chapter headings already
   start a new page (book.css `page-break-before`), so it is the per-page
   reset applied only to pages that begin a chapter: the existing
   after-render hook that tags divider pages (`no-folio`) also tags
   `chapter-start` pages; a CSS rule on that class resets both counters.
   No numbering JavaScript, no DOM surgery, no re-pagination (marks only
   get shorter, never longer).
5. **Endnotes** — no Paged concept at all. Entirely ours, but simpler than
   footnotes: the bodies are ordinary content blocks emitted before
   pagination; calls and bodies count with our own CSS counters (a
   `endnote` counter incremented at calls, reset on chapter headings or
   never; a `endnote-body` counter reset at each block / chapter group).
   Bodies are emitted in call order, so the two counters agree.
6. **Unmappable** — `endnote-reset: page`; any value outside the table.

Why "inject after pagination" (the first idea) is wrong for footnotes:
the page is already full when Paged finishes. Space for the note must be
reserved WHILE paginating, which is what the module does. Post-pagination
work is limited to tagging chapter-start pages (item 4).

## 4. Rendering pipeline

- **Parse.** `command.js` gains `footnote` / `endnote` / `endnotes` as
  known kinds (inline; `endnotes` block). Go mirrors the keyword list only
  where it matters for segmentation (`&endnotes` alone on a line is a
  block command like `&anchor`).
- **Footnote body.** `renderInlineCommand` emits
  `<span class="sentence fn-body" data-sentence-id="<host>">…emphasized
  text…</span>` with `float: footnote` in CSS. Paged moves it to the
  page's footnote area and leaves the call element inside the host span.
  The body keeps the host's sentence id — that single fact gives §5 and
  §6 for free.
- **Endnote body.** The renderer collects `{hostId, html}` while
  rendering sentences and emits `<section class="endnotes">` (with
  `<h2>`-level heading text per §3) at the chapter end / book end /
  `&endnotes` site. Each body: `<p class="sentence en-body"
  data-sentence-id="<host>">`. The call at the host: `<span
  class="en-call">` with the counter.
- **Counters & styles** live in book.css: `@counter-style
  fn-symbols`; `.pagedjs_page.chapter-start` / per-page reset rules;
  `@page { @footnote { … } }` for the area (thin rule above, smaller
  type, space between notes).
- **Chapter-start tag** in `pagedjs-config.js`'s after-render hook, next
  to the existing `no-folio` tagging.
- **Exclusions.** The attention harvest skips `.fn-body` / `.en-body`
  (not in the reading flow at that point). Word counts INCLUDE note text
  (default; see §10). Docx import/export ignore notes in v1.

## 5. Interaction: a footnote IS its host sentence

Existing machinery (`setupSentenceHover`): hovering a `.sentence` fragment
highlights every fragment with that id; the first click selects them all
and the notes pane shows that sentence; a second click on the selected
sentence opens the suggested-edit modal. Because the note body is a
fragment with the host's id:

- Hovering / clicking a footnote body (or its call) highlights the host
  prose AND the body, and the notes pane shows the host sentence's notes.
  There is no selection inside a note — the body is ONE fragment, selected
  as a whole.
- A second click on the body opens the modal for the host sentence, with
  the caret placed where the note begins: `openModal(sentenceId, {
  caretAt })`, caret = the offset of `&footnote{` (`&endnote{`) in the
  committed text, applied with `selectionStart/End` on the modal's
  textarea. Second click on the host prose keeps today's caret.
- Endnote bodies behave identically even though the host may be pages
  away: both highlight; the pane shows the host. (Scrolling to the host is
  an open question, §10.)
- Split notes (a long footnote continued on the next page) are two DOM
  pieces with the same id — the same fragment mechanics cover them.

## 6. Suggested edits: diffs inside notes

Today the word-diff tokenizer treats a whole `&`-command as ONE atomic
token, so editing three words inside a note would render the entire old
note struck red and the entire new note green. Requirement: word-level
diffs inside the note (green added / red struck, like prose). Precedent:
`&fix{…}` already diffs at CONTENT level — strip the wrapper from both
sides remembering each region's span in the stripped text, diff the
words, re-wrap the regions on assembly. Generalise that to
`&footnote{…}` / `&endnote{…}`:

- Regions re-wrap into the body element (which Paged then floats), so
  the green/red words land inside the footnote area.
- A note added or removed as a whole: the whole body green (or red-struck)
  plus its call. Index-paired like `&fix` (region i ↔ region i).
- The host prose diffs around the call as it does now.
- The modal's diff pane (same renderer path) shows the same thing.

## 7. Testing plan

- **Go**: a segman test — `&footnote{Two sentences. Inside one note.}`
  mid-sentence keeps its host sentence whole (RULE 10); `&endnotes` alone
  on a line is a block. Canonicalize leaves note text untouched.
- **JS units (render)**: body/call markup carries the host id; emphasis
  inside; unknown-value settings left unprocessed; endnote blocks emitted
  at chapter / book / `&endnotes` sites in call order; diff inside a note
  (added words green, removed red, whole-note add/remove).
- **Playwright**: paginate a fixture with notes → bodies in the page's
  footnote area with calls in the text; numbering under `never` / `page`
  / `chapter` (a fixture with two chapters, notes straddling pages);
  symbols and their doubling; endnotes at chapter end, book end (grouped
  by chapter) and at `&endnotes`; hover/click/second-click/caret
  semantics; a suggestion changing note text renders green/red inside the
  area; attention harvest ignores note bodies; folios and the attention
  overlay unaffected.

## 8. Spike (do first, half a day)

Prove the Paged.js path inside OUR pipeline before building on it:
`float: footnote` on a span nested in a `.sentence` span (attributes and
the id survive the move; the call element sits inside the host span);
counter override rules actually beat Paged's stylesheet rule; the
`@counter-style` doubling; long notes splitting; coexistence with
responsive scaling, the attention overlay's per-page SVG and the
`no-folio` tagging. Record findings here (§8a) before Phase 1.

## 9. Phases & progress

- [ ] **0. Spike** (§8) — findings written to §8a.
- [ ] **1. Footnotes** — parse, render, Paged CSS, `footnote-marks`,
      `footnote-reset` (never / page / chapter), chapter-start tagging,
      attention exclusion. Cheatsheet rows.
- [ ] **2. Selection & editing** — fragment semantics verified, second
      click opens the modal with the caret at the note.
- [ ] **3. Diffs inside notes** — content-level diffing generalised from
      `&fix`.
- [ ] **4. Endnotes** — collection, placement (chapter / book / `&endnotes`),
      counters, grouping headings.
- [ ] **5. Ship** — tests green, prod, this doc's status flipped.

## 10. Open questions (non-blocking, defaulted)

- Word counts include note text — default **yes** (it is book prose).
- Clicking an endnote body: select only, or also scroll to the host —
  default **select only**.
- Notes inside headings (`&title` / `&chapter` text) — default
  **unsupported**: left unprocessed.
- Paged's `footnote-policy` / `footnote-display` — default **Paged
  defaults**; expose via `&meta` only if a real book needs it.
- Symbols past six (doubling) — allowed; a book that needs seven symbol
  notes on one page should use numbers.
- Screen affordances (hover popover on a call, back-links from endnotes) —
  later.
