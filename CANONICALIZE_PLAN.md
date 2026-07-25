# Canonicalization Plan

## The core idea

One function, `canonicalize(text) -> text`, is the single source of truth for
"house style" in a `.manuscript` file. It runs **per sentence, inside the
render loop**, on each sentence's effective text. The canonical output we
render IS accumulated into the push source as we go — so what we push is
literally the pieces we rendered, not a re-derivation.

```
per sentence i, in the render loop:
  effective_i  = suggestion_i ?? committed_i
  canonical_i  = canonicalize(effective_i)      // per-sentence
  render(canonical_i)                           // what you see (book/outline/settings)
  accumulate canonical_i  ─────────────────────► push source (built as we render)

on push: commit the accumulated push source. Same pieces you rendered.
```

Because push commits the very strings render produced, "what you see is what
you push" is definitional, not merely provable. Substring-replace /
`ApplySuggestions` retires from the push path.

`canonicalize` MUST be **idempotent**: `canonicalize(canonicalize(x)) == canonicalize(x)`.
That is what lets the file converge to canonical form and stay there.

### Why per-sentence is sufficient
Every seam between two sentences is OWNED by the second sentence's leading
marker (`\n\n` or `\n\t`), which lives inside that sentence's own text. So a
per-sentence pass can normalize seams too — there is no cross-sentence byte
movement in these rules. (A leading-anchor split is WITHIN one sentence's
text: `&anchor{x} prose` → `&anchor{x}\nprose`, which segman then splits.) If
a future rule ever needs to look at two sentences at once, we revisit; nothing
here does.

### Consequence the user explicitly wants
The FIRST push after this ships reformats the WHOLE file to canonical form
(every un-converted `#` header stays literal prose, every spacing irregularity
tidies, block commands get their gaps). Big diff. This is the point. Every
push after that is small again (idempotence → only real edits move).

Mechanically, this "big diff" arises because the push source is now the
accumulated canonical sentences for the ENTIRE document (every sentence, not
just edited ones) — so the first push emits the whole file in canonical form.

## Where canonicalize lives (and does NOT live)

- **NOT in segman.** segman stays a pure segmenter ("where are the sentence
  boundaries"). Canonical *house style* (`&`-command spacing, the anchor rule,
  `&meta` vocabulary) is manuscript-studio policy. Ordering is
  `canonicalize (MS) → segment (segman)`: canon prepares text so segman draws
  boundaries where our rules want them (e.g. it inserts the newline that splits
  a leading anchor onto its own line).
- **Two ports, kept in lockstep** like segman's own JS/Go ports:
  - `web/js/canonicalize.js` — used by render + suggestion preview.
  - `internal/sentence/canonicalize.go` — used by push.
  - A shared fixture corpus (`tests/canonicalize-scenarios.jsonl`) that BOTH
    ports run against, so they can't drift.

## Canonical form (the rules)

Applied to the whole document. All rules are whitespace-only reshaping around
recognized commands + trimming; prose bytes are never altered.

1. **Trailing whitespace** stripped from every line. Runs of >2 blank lines
   collapse to exactly one blank line (one `\n\n`). File ends with exactly one
   `\n`.

2. **Block commands** `&title` / `&part` / `&chapter` / `&meta` always sit on
   their own line with exactly one blank line (`\n\n`) before and after
   (except start/end of file). An inline-typed `&part#p1{I.}{...}` anywhere
   becomes the block form automatically. (This is why the suggested-edit UI
   needs NO auto-wrap logic — canon does it.)

3. **Block placeholder** canonical form is `\n\t&placeholder{...}` — a new
   indented paragraph. (A `sentences`-unit placeholder mid-line stays inline.)

4. **Anchor block-vs-inline rule** (the key one):
   - An `&anchor{...}` that is the FIRST non-whitespace thing in its paragraph
     is a **block anchor**: canon puts it as `&anchor{...}\n<prose…>` — a single
     `\n` join to the following prose, so segman splits it into its own sentence
     while the prose stays in the SAME paragraph. The break BEFORE the anchor is
     whatever the paragraph already had (`\n\n` if a new section, `\n\t` if a new
     paragraph) — preserved, not forced.
   - An `&anchor{...}` anywhere else in a paragraph stays **inline**.
   - So the ONLY special chars the author ever enters are `\n\n` and `\n\t`
     (via the modal's two buttons). Block-vs-inline is decided positionally by
     canon; the UI never chooses.

5. Idempotence check baked into tests: every scenario asserts
   `canon(canon(x)) == canon(x)`.

## Rendering changes

`renderer.js`, `outline.js`, and the settings pass already build
`effective = suggestion ?? committed` **per sentence** and segment
independently. Keep that structure — just insert canonicalize per sentence and
accumulate:

1. In the render loop (renderer.js ~line 380): after computing `effective`,
   set `effective = canonicalize(effective)` before `segmentFragments`.
2. Outline (`outline.js buildOutline`) and settings (`extractSettings`) do the
   SAME per-sentence `canonicalize(effective)` so they agree with the page.
3. Push source is authoritative from the SERVER (step 4): Go rebuilds it via
   `Reconstruct(Canonicalize(each sentence))`. We deliberately do NOT port
   `Reconstruct` to JS just to accumulate a client `pushSource` — that would
   duplicate non-trivial join logic and invite drift. If a client-side push
   PREVIEW/diff is wanted, expose a server dry-run endpoint instead. Render's
   job is only to make the on-screen preview truthful (canonicalize per
   sentence before segmenting); it does not build the pushed bytes.

Sentence IDs: fragments still carry their real sentence ID for hover/annotate.
A canon-induced split (leading anchor) is WITHIN one sentence's text, so the
anchor fragment and the prose fragment both share the host sentence's id — the
same one-id-many-fragments pattern already used. No id remapping needed.

## Anchor GLYPH rendering (book)

A **block** anchor no longer renders its label as text. It renders a small grey
`⚓` glyph at the paragraph start, hoverable to reveal the label (title attr).
The label continues to appear in the left-margin outline. **Inline** anchors
stay invisible zero-width targets (unchanged).

- `renderBlockCommandFrag` anchor case: emit `<span class="cmd-anchor-glyph"
  title="{label}">⚓</span>` instead of the label text, prefixed to the
  following prose paragraph.
- `structuralForm` anchor case updated so `visible` is the glyph, not the label.
- CSS: `.cmd-anchor-glyph { color:#8c959f; cursor:help; font-size:.85em; }`

## Push changes

`HandlePushSuggestions`:
- Remove the `ApplySuggestions(srcStr, …)` substring-replace derivation from the
  push path.
- The server rebuilds the push source the SAME way render does: for every
  sentence of the migration in ordinal order, `canonical_i =
  canonicalize(suggestion_i ?? committed_i)`, joined via `Reconstruct`-style
  joining, then that whole string is committed. (Server-side rebuild — never
  trust client bytes. The client's stashed `pushSource` is only used for the
  preview/diff shown before pushing.)
- Since canon is per-sentence and idempotent, the server result equals what the
  client rendered sentence-for-sentence.
- Keep the strict **stale-migration 409 guard** (only push from head) — pushing
  a whole reconstructed doc must not clobber intervening commits.
- The segman sibling file (`.sentences`) regenerates from the committed bytes as
  today.

## Suggested-edit modal

Minimal change — the glyph round-trip (`toGlyphs`/`fromGlyphs`, `§`/`¶`) already
exists. Add the two requested insert buttons:
- A `⏎`/`§`-style button inserts a section break (`\n\n`).
- A `⇥`/`¶`-style button inserts a paragraph break (`\n\t`).
No auto-wrap / block-form logic in the modal at all — canon owns structure. The
read-only "Original" pane shows the canonical form so the author sees exactly
what canon produced.

## Test / rollout discipline

1. `canonicalize.go` + `canonicalize.js` + shared `canonicalize-scenarios.jsonl`;
   a Go test and a Node test both run the corpus, asserting output + idempotence.
2. Port-parity test (like segman's vendor-drift guard): a fixture the two ports
   must agree on.
3. Playwright: leading-anchor → block glyph in book + label in outline; inline
   anchor invisible; inline-typed `&part` renders blocked; the accumulated
   client `pushSource` matches the server-rebuilt push bytes for the same
   migration (parity of the two per-sentence accumulations).
4. Deploy; first push of `the-wildfire` will be the big canonical reformat
   (expected). Verify the resulting branch diff looks right before merging.

## Open sequencing

Do it in this order so each step is independently verifiable:
1. `canonicalize` (both ports + corpus) — pure, no wiring. Land + test.
2. Anchor glyph rendering (render-only, uses existing block anchors). Land + test.
3. Render canonicalizes per-sentence in the loop + accumulates `pushSource`.
   Outline + settings canonicalize too. Land + test.
4. Push rebuilds source per-sentence server-side (retire ApplySuggestions from
   push path). Land + test parity vs. client `pushSource`.
5. Modal break-insert buttons. Land + test.
6. Deploy; take the big first diff on the-wildfire.
