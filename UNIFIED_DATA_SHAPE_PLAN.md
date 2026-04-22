# Plan: Unified data shape (raw markdown + structural markers)

Status: planned, not yet built.
Prerequisite for: `PUSH_FEATURE_PLAN.md`.
Owner notes: this captures a design discussion between Slackwing and Claude.

---

## Why

Two motivations:

1. **The DB should mirror the manuscript file.** Today, sentences are
   stored stripped of inline markdown (`*italic*`, `**bold**`) and
   stripped of all structural whitespace (`\n`, `\t`). The frontend
   reconstructs paragraph structure from a separately-fetched
   `currentManuscript` source string. The DB is a partial mirror; the
   file is the privileged source of truth. This bothered the user from
   the start.
2. **Suggestions can't restructure prose.** A user editing a suggestion
   in the modal can't add a paragraph break (`\n\t`), start a new
   section (`\n\n`), or merge a paragraph into the previous (by
   removing the leading marker), because that information was thrown
   away at segmentation time. The modal can only show stripped text.

Goal: `sentence.text` carries enough structural information that a
manuscript file is reconstructible from the sentence list (plus the
header rule below). Suggestions become full source-level edits.

---

## Storage rule

Every `sentence.text` is exactly one of:

- `Plain content.` — a continuation sentence (mid-paragraph), or the
  first non-header sentence in any context (manuscript start, after a
  header, etc.).
- `\n\tIndented content.` — explicit paragraph break with indent. The
  user wants a fresh indented paragraph here.
- `\n\nNew section content.` — explicit section break (no header).
  Visually a blank-line gap in the rendered manuscript.
- `# Heading text` (or `##`, `###`, etc.) — a header sentence. Always
  its own structural element. No leading whitespace marker.

Inline markdown (`*italic*`, `**bold**`) is preserved as-is in the
text. Sentence_id stability is unaffected because `GenerateSentenceID`
calls `normalizeText()` internally, which strips formatting before
hashing.

### What's NOT allowed

- Trailing whitespace (other than what's natural inside the content).
- Newlines anywhere except as a leading `\n\t` or `\n\n` marker.
- A leading marker on a header sentence.
- Multiple consecutive markers (e.g. `\n\n\n\t`).

Validation must reject any `INSERT` / `UPDATE` to `sentence.text` that
violates these. Crash-loud beats silent corruption.

---

## Reconstruction algorithm (DB → manuscript file)

```
For sentence in sentences (in ordinal order):
    if sentence is a header:
        emit "\n" if last emitted char isn't already a newline
        emit sentence.text
        emit "\n"
    else:
        emit sentence.text  (its leading \n\t / \n\n provides any break)
        if next sentence exists and isn't a new-paragraph/section:
            emit " "  (single space between continuation sentences)
```

Round-trip property: parse a manuscript file → segment with the new
tokenizer → reconstruct → byte-equal to the original. We test this as
a hard contract (see "Round-trip test" below).

The very first sentence of a manuscript has no leading marker; the
manuscript-start position is implicit.

---

## Tokenization (the new "second pass")

Segman is vendored — DO NOT EDIT (see AGENTS.md N8). It already
detects sentence boundaries correctly even in the presence of `\n\t`
and `\n\n`, but it then strips that whitespace from each output
segment. We need to recover the structural information without
modifying segman.

### Algorithm

```
segments = segman.Segment(source)
For i, segment in enumerate(segments):
    if segment matches /^#+\s/:
        sentences.append(segment)  # header, no marker
        continue
    # Find this segment's content in the original source, advancing
    # past prior segments. Allow whitespace flexibility because segman
    # collapsed internal whitespace.
    region = locate_segment_in_source(segment, source, cursor)
    leading_whitespace = source[prev_cursor:region.start]
    marker = classify_marker(leading_whitespace)
    sentences.append(marker + segment)
    cursor = region.end
```

### `classify_marker(whitespace_run)`

- Contains `\n\n` (two or more consecutive newlines, ignoring spaces
  between) → `\n\n`
- Contains exactly one `\n` followed by `\t` (allowing surrounding
  spaces) → `\n\t`
- Otherwise (single `\n`, single space, etc.) → no marker

If the run is at position 0 (manuscript start) → no marker regardless.

If the previous element was a header → no marker UNLESS the user
explicitly put `\t` after the header's blank line (the "explicit
indent after heading" case Slackwing flagged):

- `# Heading\n\nFirst sentence.` → header + `First sentence.` (no marker)
- `# Heading\n\n\tFirst sentence.` → header + `\n\tFirst sentence.`
  (preserve user intent)

### `locate_segment_in_source`

Segment text = segman's whitespace-collapsed form (e.g. `"A B C."`).
Source has `"A\n\tB  C."`. We need to find where `A`...`C.` lives in
the source.

Approach: walk source characters from `cursor`, matching segment
characters in order, allowing source whitespace runs to match a single
segment space. Standard "fuzzy whitespace match" — ~30 lines.

Returns the substring's start/end positions.

---

## Validation

`internal/sentence/validate.go` — `ValidateSentenceText(text) error`.
Rejects any text that doesn't fit the storage rule:

- Header text matches `^#+\s.*$` and contains no `\n` or `\t`.
- Non-header text has at most ONE leading marker (`\n\t` or `\n\n`),
  and the rest contains no `\n` or `\t`.

Called from every code path that writes a `sentence` row:
- `CreateSentences` in `internal/database/queries.go`
- `SetPreviousSentenceID` (no — only updates a different column, skip)
- The new backfill CLI

NOT called for suggestion text — suggestions can have markers anywhere
mid-content (user expressing "split here"). Mid-content markers
naturally become leading markers on the next migration after the
suggestion is applied.

---

## API change

`GET /api/migrations/{migration_id}/manuscript` currently returns:
```json
{ "commit_hash": "...", "markdown": "raw source", "sentences": [...], "annotations": [...] }
```

After this change, drop `markdown`. The frontend reconstructs structure
from sentences alone — single source of truth, smaller payload, no risk
of source/DB drift.

The backend reconstruction function (`internal/sentence/reconstruct.go`)
exists for the backfill verification anyway; reusing it server-side for
debug endpoints is trivial if needed.

---

## Frontend changes

### `parseManuscript()` removed; replaced with `renderSentences()`

Today: walks lines of `currentManuscript`, emits `<p>`, `<h*>`, etc.
After: walks the sentence list, groups them into paragraphs based on
leading markers.

```
For sentence in sentences:
    if header:
        flush current paragraph
        emit <h${level}>${stripped}</h*>
    elif sentence starts with \n\n:
        flush current paragraph
        start new paragraph (no indent class)
        append sentence text (without leading marker)
    elif sentence starts with \n\t:
        flush current paragraph
        start new <p class="indented">
        append sentence text (without leading marker)
    else:
        if no current paragraph: start <p>
        append sentence text (with separating space if needed)
flush
```

### `wrapSentences()` simplified

No more substring search through source HTML. The sentence list IS the
structure. Each sentence renders directly into a `<span class="sentence"
data-sentence-id="...">${text}</span>` inside its containing `<p>` /
`<h*>`. Vastly simpler than today's positional matching.

### Glyph rule

The user never sees raw `\n\t` or `\n\n` in any UI. Conversion happens
at the boundary:

- **Display-time** (anywhere we put sentence text into the DOM —
  textarea, popup, span content): replace `\n\t` → `¶` (U+00B6) and
  `\n\n` → `§` (U+00A7).
- **Input-time** (when the user saves a suggestion modal): replace
  `¶` → `\n\t` and `§` → `\n\n`. AND accept escape-style input —
  the literal 4-character sequence `\n\t` (backslash-n-backslash-t)
  → `\n\t`, and literal `\n\n` → `\n\n`. Users without easy glyph
  input can type the escapes.

Storage form is always real newline + real tab. Glyphs are a UI
affordance only.

Two utility functions in `web/js/text-markers.js` (or wherever it
lands): `toGlyphs(text)` and `fromGlyphs(text)`. Both ~5 lines, both
pure.

### Sentence span content

The DOM span shows sentence text with leading marker stripped (so
`<span>The fox jumped.</span>`, not `<span>\n\tThe fox jumped.</span>`).
The leading marker only affects which `<p>` the span lives inside.

For inline diff (suggestions.js): the diff compares storage-form text,
then converts to glyph form for display. So a suggestion that adds a
paragraph break shows `<strong>¶</strong>` inline.

---

## Backfill

`cmd/backfill-raw-text/main.go` — new CLI mirroring
`cmd/backfill-prev-sentence/`.

```
backfill-raw-text --manuscript=NAME [--dry-run]
```

For each `done` migration of the named manuscript, in chronological
order:

1. Read source at that commit via `git show ${commit_hash}:${file_path}`
   from the local clone. (NOT `git checkout` — leaves working tree
   alone.)
2. Re-tokenize with the new "second pass" algorithm. Produces a list of
   raw-text sentences.
3. Load existing `sentence` rows for that migration, ordered by ordinal.
4. If counts don't match: bail loudly, do not partial-update.
5. For each row, `UPDATE sentence SET text = $new_text WHERE
   sentence_id = $id`. The sentence_id stays the same because
   `normalizeText` (used by ID hashing) strips formatting either way.

Idempotent: re-running gives identical results.

Dry-run flag prints what would change without writing.

Failure modes:
- Historical commit not in local repo (force-push erased it). Skip with
  warning.
- File doesn't exist at that commit. Skip with warning.
- Segment count mismatch (old strip rules vs new rules disagree on
  count). Bail loudly per migration; record which one and let the user
  investigate. Don't update partial.

Production rollout:
1. Deploy this code change.
2. Run backfill for each manuscript on prod (`--dry-run` first to spot
   any count mismatches).
3. Verify a sample of rows by hand.

Sentence_ids unchanged → no FK cascades → no annotation/suggestion
breakage → safe to run on a live system. Only the `text` column
changes.

---

## Round-trip test

`internal/sentence/reconstruct_test.go`:

```go
For each manuscript in testdata/manuscripts/*.manuscript:
    source = read file
    sentences = TokenizeWithMarkers(source)
    reconstructed = Reconstruct(sentences)
    require source == reconstructed
```

Test corpus needs to cover:
- Indented + non-indented paragraphs
- Single + double `\n\n` between paragraphs
- Headers at multiple levels
- Headers with and without trailing content
- File ending with a newline vs no newline
- Inline `*italic*` and `**bold**`
- Smartquotes in source (we don't normalize them at the segmenter level)
- Sentence-end punctuation that segman is sensitive to (`.`, `!`, `?`,
  `..."`, etc.)

Failing this test = data shape design is wrong. Don't ship a code
change that breaks it.

---

## Affected tests

- `internal/sentence/matcher_test.go` — text fixtures may need
  updating; the matcher itself doesn't change behavior because it
  normalizes at compare time.
- `internal/sentence/id_test.go` — sentence_id calculation unchanged,
  but worth adding a test confirming "raw text and stripped text
  produce the same id."
- `internal/migrations/processor_integration_test.go` — fixtures use
  hand-crafted strings; these need updating to the new format.
- `tests/test-suggested-edits.js` — the textarea pre-fill assertion
  may need to handle glyphs.

---

## Implementation order

1. Storage rule + validation (`internal/sentence/validate.go`).
2. Reconstruction (`internal/sentence/reconstruct.go`) + round-trip
   test against `testdata/manuscripts/*.manuscript`.
3. New tokenizer pass (`internal/sentence/tokenizer.go` modifications).
   Round-trip test passes end-to-end.
4. Migration processor uses the new tokenizer. Existing integration
   tests updated.
5. Backfill CLI + tested on dev manuscript.
6. Frontend glyph utilities (`web/js/text-markers.js`).
7. Frontend `renderSentences()` replaces `parseManuscript()`.
8. `wrapSentences()` simplified.
9. API: drop `markdown` field from `/api/migrations/{id}/manuscript`.
10. Update suggestion modal to use glyph conversion.
11. Update history popup to use glyph conversion.
12. Run backfill on prod.

Each step has a test or visual verification. No big-bang merge — each
phase commits independently and the prior commit stays functional.

---

## Risk register

- **Backfill segment-count mismatch.** If the new tokenizer disagrees
  with the old one about how many sentences a historical commit
  contains, we can't safely update those rows. Mitigation: bail loudly,
  document the manuscript+commit, investigate by hand. Not blocking —
  the rest of the manuscript backfills fine.
- **Round-trip test fails on a real manuscript.** Some edge case in the
  source we didn't think of. Mitigation: fix the tokenizer/reconstruct
  pair until the test passes; don't ship without it.
- **Glyph collision** if user's prose actually contains `¶` or `§`.
  Mitigation: accept literal — they round-trip as themselves only after
  fromGlyphs. The user-facing weirdness is "I typed §, it became a
  section break." Document. Rare.
- **Frontend re-render performance.** Today's `parseManuscript` walks
  source string once. New `renderSentences` walks the sentence list
  (725 items for the test manuscript). Should be no slower; sentences
  are an array of plain strings.
- **Paged.js doesn't like multi-paragraph spans.** If a suggestion
  introduces a `\n\t` mid-sentence and we render it inline as `<br>`,
  Paged.js may get confused about page-break opportunities. Mitigation:
  the inline diff render uses a glyph, NOT a real newline — Paged.js
  sees plain text. The split into two sentences only happens after the
  next migration.

---

## Open questions resolved

| Question | Resolution |
|---|---|
| Store raw markdown? | Yes. Sentence IDs stable because hash uses normalizeText. |
| Store `\n\t` and `\n\n`? | Yes — leading marker on the sentence after a paragraph/section break. |
| Store other whitespace (trailing, multiple `\n`s)? | No. Validation rejects. |
| Headers as marked sentences or special rows? | Same `sentence` table. Header sentences have `# `-prefixed text and no leading marker. |
| Edit segman to preserve whitespace? | No. Vendored library, untouchable. Second pass lines up segman's output against source. |
| Drop the `markdown` API field? | Yes. Single source of truth. |
| Display whitespace markers in UI? | Glyphs (`¶` for `\n\t`, `§` for `\n\n`) everywhere. Convert at boundary. |
| Allow user to type escape-style `\n\t`? | Yes — convert literal 4-char `\n\t` and `\n\n` to real chars on save. |
| Validate suggestion text shape? | No. Suggestions can have markers anywhere; on apply + next migration they become leading markers naturally. |
| Backfill historical migrations? | Yes. CLI uses `git show <commit>:<path>` per historical commit. |
| First sentence of manuscript marker? | No marker. Implicit start-of-document position. |
