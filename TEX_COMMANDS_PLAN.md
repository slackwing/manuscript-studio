# `&`-Command Plan — structural commands, slugs, outline, references

Status: **design agreed, not started.** This document is the spec + phasing
for replacing Markdown `#` headers with an `&`-command family, adding a
static-slug system, a document outline, and cross-references.

Owner-facing summary: authors stop writing `# Heading` and start writing
`&chapter#slug{label}{description}`. Commands are first-class in Manuscript
Studio the same way `#` headers already are: a block command is its own
sentence, and it migrates / gets annotated / suggested-on like any sentence.

---

## 1. The command grammar

Single sigil: **`&`** (deliberately not TeX — we don't want TeX semantics
implied). A static slug is written as **`#slug`** immediately after the
keyword (reminiscent of a URL fragment / an id, and it keeps us clear of
TeX's `[]{}`). Args are `{…}`. A command is recognized when, and only when,
`&` is immediately followed by an **exact known keyword** and then either the
`#slug` marker or an **opening `{`**. Everything else is literal prose.

```
&title{The Wildfire}
&part#p1{I.}{The Gathering}
&chapter#p1c1{1.}{Smoke on the ridge}
&anchor#origin{where it all begins}
&reference#origin{callback to the opening}
```

| Command | Form | Notes |
|---|---|---|
| `&title{name}` | name | Document title. Own sentence. No slug (one per doc). |
| `&part#slug{label}{desc?}` | optional `#slug`, label, optional description | Block. Sluggable. |
| `&chapter#slug{label}{desc?}` | optional `#slug`, label, optional description | Block. Sluggable. |
| `&anchor#slug{desc?}` | optional `#slug`, optional description | **No label.** Block *or* inline (see §2). |
| `&reference#slug{notes?}` | `#slug` (target), optional notes | **Inline only.** Points at another slug. |

`label` is what the author wants shown as the heading text — they type the
number themselves (`I.`, `1.`, `1.a`); **we do no auto-numbering**. Two
"Chapter I." in different parts is fine and expected; uniqueness is **not**
enforced (the hash suffix keeps slugs distinct).

### Slug charset

A `#slug` must match **`[a-z0-9-]+`** (lowercase letters, digits, dashes
only) — same shape as a derived reference slug, so static and auto slugs are
indistinguishable to a reference. Anything else is a validation error at the
MS layer (segman only needs to boundary the command; MS validates the slug
text). This also disambiguates `&chapter#p1c1{…}` (command) from a stray `#`
in prose.

### Literal `&` in prose

Because a command requires `&` + exact-keyword + (`#slug` or `{`), ordinary
prose ampersands are never mistaken for commands and need **no escaping**:

- `Smith & Sons` → `&` + space → literal
- `R&D` → `&` + `D` → literal
- `&chapter of accidents befell them` → `&chapter` but no `#`/`{` → literal

The only pathological case (a sentence literally starting `&chapter{` or
`&chapter#`) does not occur in real prose; we accept it rather than add an
escape mechanism.

---

## 2. Block vs inline — the boundary rule (this is what segman implements)

A command is **block** (its own sentence) or **inline** (a span inside a host
sentence) purely by **position on its physical line**:

- `&title`, `&part`, `&chapter` — **always block.** Always their own line,
  always their own sentence.
- `&anchor` — **block iff it is the sole non-whitespace content of its line**
  (leading indent and trailing spaces don't count as content); **inline
  otherwise.**
- `&reference` — **always inline** (it appears within prose).

The consequence the author cares about, stated plainly:

```
&chapter#c1{I.}{Smoke} &anchor#origin{where it begins}
        → ONE sentence: the anchor shares the chapter's line, so it's
          part of that sentence (an anchor "for this chapter").

&chapter#c1{I.}{Smoke}
&anchor#origin{where it begins}
        → TWO sentences: the anchor is alone on its line → its own block.
```

This is a single consistent rule ("anchor is block iff alone on its line,
else inline"), applied whether the other content on the line is prose or
another command. No special heading-fusion logic is needed.

**Precise definition of "alone on its line":** after trimming leading and
trailing ASCII whitespace, the line consists of exactly one `&anchor…`
command token and nothing else → block. Any other non-whitespace character
before or after → inline.

**Inline anchor target:** an inline anchor is part of its host sentence's
text, so it rides the old→new sentence pairing on edit automatically (no
separate row to remap). A `&reference` to it resolves to the **host
sentence** — sub-sentence (exact-word) precision is explicitly deferred.

---

## 3. Slugs — two kinds, only one is stored

The slug is an **alternate reference key**; it never overrides the sentence
ID. There is a per-migration `slug → sentence_id` index.

- **Static slug** `&chapter#p1c1{…}` — author-owned string. **Stored** in
  the slug index. When the chapter's text is edited it gets a new
  sentence_id (content-addressed), and the migration **re-points the slug to
  the new sentence_id** using the existing old→new pairing machinery. The
  slug string is stable by the author's hand; only its target moves. This is
  what lets cross-references survive editing.
- **Auto slug** `&chapter{…}` (no `#slug`) — derived from content via the
  existing first-three-words-alphanumeric-lowercase + hash utility
  (`GenerateSentenceID`'s prefix logic). **Computed on read, never stored,
  never remapped.** A reference to an auto-slug is inherently fragile: reword
  the heading and the derived slug changes. Authors are steered toward static
  slugs for anything on the receiving end of a `&reference`.

Design rule: the migration's slug-index update logic only ever touches
**static** slugs. Auto-slugs are a display/convenience affordance.

---

## 4. Reference integrity

References are **never** a migration failure. On migration:

- Resolve each `&reference#slug` against the slug index.
- Unresolved (dangling) references are collected into
  `MigrationResult.UnresolvedReferences []string` and **logged as warnings**.
- The migration still completes `done`.
- The UI renders a dangling reference as a **broken-link marker** (inert /
  flagged), not a crash.

---

## 5. The outline (server-side)

New endpoint, e.g. `GET /api/migrations/{id}/outline`, returns a tree built
from the block commands in ordinal order:

```jsonc
{
  "title": { "slug": "...", "label": "The Wildfire" },
  "parts": [
    {
      "slug": "p1", "label": "I.", "description": "The Gathering",
      "sentence_id": "...",
      "chapters": [
        {
          "slug": "p1c1", "label": "1.", "description": "Smoke on the ridge",
          "sentence_id": "...",
          "anchors": [
            { "slug": "origin", "description": "where it begins", "sentence_id": "..." }
          ]
        }
      ]
    }
  ],
  "anchors_top": [ /* anchors not under any chapter/part */ ]
}
```

- Hierarchy: **Part → Chapter → Anchor**. An anchor attaches to the most
  recently opened structural node (chapter, else part, else document root).
- Each node carries `{slug, label, description, sentence_id}`; **anchors have
  no label** (`{slug, description, sentence_id}`).
- The endpoint returns structure; the **frontend owns presentation** (whether
  to show "I. The Gathering" on one line or two is a CSS/layout decision, not
  fixed here).
- Server-side chosen over client-side so the slug index is queryable for
  reference autocomplete and dangling-reference detection.

---

## 6. segman changes — versioning (separate repo, kept separate)

segman learns the **boundary-affecting keyword behavior** (it now knows the
command vocabulary — accepted coupling, since `&anchor` being position-
dependent can't be decided by a generic marker alone). segman decides
**boundaries only**; Manuscript Studio still owns **meaning** (parsing fields,
slug index, outline, references). Adding a future command is therefore a
segman bump + re-vendor (cheap now — see §7).

- **segman 1.2.0 — additive.** segman recognizes `&title/&part/&chapter`
  (always boundaried) and `&anchor` (boundaried iff alone on its line),
  *in addition to* the existing `#` headers. Existing manuscripts segment
  **identically** → minor bump. SPECS.md gains the `&`-command rules;
  scenarios.jsonl gains cases (block part/chapter, block anchor alone,
  inline anchor sharing a line, literal-`&` prose, `&`-without-delimiter).
- **segman 2.0.0 — breaking.** When `#` headers are **deprecated/removed**, a
  manuscript that used `#` now segments differently → major bump.

All three ports (Go/JS/Rust) implement the same rules; `run-tests` must stay
green in all three at each bump (per segman AGENTS.md).

### 6.1 Scenario coverage is the cross-port contract (do not skip)

`tests/scenarios.jsonl` is the **language-agnostic contract** that keeps the
Go, JS, and Rust ports segmenting identically. Every new boundary rule MUST
land as scenarios, and `./run-tests` must pass **in all three languages**
before a version bump. A rule with no scenario is a rule that will silently
drift between ports. Per segman AGENTS.md, scenarios are added deliberately
via `tools/scenario-building/03-add-scenario` (the human owns
`scenarios.jsonl` — never hand-edit it), and SPECS.md + scenarios.jsonl move
together (a new rule updates both).

Scenario format is `{"id", "context", "expected"}` where `expected` is one
segment the segmenter must produce from `context` (a spot-check assertion).

**Required Phase-1 (1.2.0) scenarios — at minimum one per rule, ideally the
"expected" probing the *newly boundaried* segment:**

| Rule under test | `context` (illustrative) | `expected` asserts |
|---|---|---|
| `&title` is its own segment | `&title{The Wildfire}\n\n&part#p1{I.}{The Gathering}` | `&title{The Wildfire}` |
| `&part` block, before+after boundary | prose `\n&part#p1{I.}{...}\n` prose | `&part#p1{I.}{...}` |
| `&chapter` block | `&part#p1{I.}\n&chapter#c1{1.}{Smoke}` | `&chapter#c1{1.}{Smoke}` |
| `&chapter` with `{desc}` optional 3rd arg | `&chapter#c1{1.}{Smoke on the ridge}` | whole command |
| `&chapter` with NO static slug | `&chapter{1.}{Smoke}` | whole command (auto-slug is MS-side) |
| `&anchor` **alone** on line → block | prose `\n&anchor#origin{here}\n` prose | `&anchor#origin{here}` |
| `&anchor` **indented but alone** → block | `\n    &anchor#origin{here}\n` | `&anchor#origin{here}` |
| `&anchor` **sharing a line** → inline (NOT its own segment) | `The fire &anchor#x{} spread across the ridge.` | the **whole sentence** incl. the anchor |
| `&chapter … &anchor` same line → ONE segment | `&chapter#c1{I.}{Smoke} &anchor#o{begins}` | the whole line as one segment |
| `&reference` inline never boundaries | `See &reference#origin{the note} for more.` | the whole sentence incl. the reference |
| literal `&` in prose (space) | `Smith & Sons founded the press.` | the whole sentence (no split at `&`) |
| literal `&` (no delimiter after keyword) | `A &chapter of accidents befell them.` | the whole sentence (not a command) |
| literal `R&D` | `Their R&D budget doubled.` | the whole sentence |
| `#` header still works (additive, unchanged) | keep existing 001/017/018/057 green | (regression) |

**Phase-5 (2.0.0) scenarios:** flip the `#`-header scenarios to their new
behavior (a `#` line is no longer boundaried as a header), and add scenarios
proving `#` is now treated as literal prose. Existing header scenarios become
the evidence of the breaking change.

Workflow at each segman change: add scenarios via the tool → implement the
rule in the failing port(s) → `./run-tests` until green in Go **and** JS
**and** Rust → bump version via `tools/scripts/bump-version.sh` → commit +
tag + push → re-vendor into MS (`scripts/vendor-segman.sh --ref=vX.Y.Z`).

---

## 7. Manuscript Studio touchpoints (checklist)

The current `#`-header special-casing lives in exactly these places; each
gains `&`-command handling alongside it, then loses `#` at deprecation:

- `internal/sentence/validate.go` — `headerPattern`, `MarkerSection/Paragraph`,
  `ValidateSentenceText`. Add: recognize block-command storage shapes; a new
  validator for command field syntax.
- `internal/sentence/reconstruct.go` — `IsHeaderText`, `Reconstruct`. The
  parse→reconstruct round-trip must stay byte-equal for `&`-command source.
- `internal/sentence/tokenizer.go` — `isHeaderSegment`, `classifyMarker`,
  `TokenizeWithMarkers`. Recognize command segments; block commands emit as
  their own sentence like headers do.
- `internal/sentence/id.go` — `GenerateSentenceID`. Its first-three-words
  prefix logic becomes the shared **auto-slug** utility (extract, don't
  duplicate). Confirm the "no alphanumeric words → `heading` prefix" branch
  still makes sense for command sentences.
- `web/js/renderer.js` — `renderSentencesToHTML` (`/^(#+)\s+(.*)$/` →
  `<h*>`). Add: render block commands (`&part/&chapter/&title`) and inline
  spans (`&anchor/&reference`); broken-reference marker.
- **New:** command parser (fields), slug index (schema + queries),
  outline endpoint, reference resolution, outline UI (left margin),
  reference rendering/linking.

### New schema (Liquibase, per AGENTS.md §3 — new numbered changeset)

- A `slug` table (or columns): `(migration_id, slug, sentence_id)` for static
  slugs, remapped on migration. Frozen `001` untouched; add `007-slugs.xml`
  (or next free number) and wire into `db.changelog-master.xml`.

### New `MigrationResult` field

- `UnresolvedReferences []string` (§4), surfaced in the migration API result.

---

## 8. Phasing

1. **Phase 1 — parse & render `&` commands (additive).**
   segman **1.2.0**: add the §6.1 scenarios FIRST, implement the boundary
   rules in all three ports, `./run-tests` green in Go+JS+Rust — that
   scenario suite is the gate, not a follow-up. Re-vendor. MS: command
   parser, validator, reconstruct round-trip, renderer for block commands.
   `#` headers still work. Auto-slugs only; no static-slug storage, no
   references, no outline yet. Verify with the existing migration/
   segmenter-change re-migration path (already built).
2. **Phase 2 — static slugs + slug index.**
   Schema changeset, slug extraction on migration, old→new slug remapping,
   `#slug` parsing. Still no references/outline surfaced.
3. **Phase 3 — outline endpoint + left-margin UI.**
   `GET …/outline`, Part→Chapter→Anchor tree, frontend nav.
4. **Phase 4 — references.**
   `&reference#slug` inline parsing, resolution against the index,
   `UnresolvedReferences` warnings, broken-link UI, host-sentence scroll.
   (Inline `&anchor` word-marking ships here too.)
5. **Phase 5 — deprecate `#` headers.**
   Migrate remaining manuscripts to `&` commands. segman **2.0.0** drops `#`
   header segmentation. Remove `#` special-casing from the §7 touchpoints.
   Re-vendor; the segmenter-version change auto-re-migrates.

Each phase is independently shippable and independently testable (Go unit +
Playwright, per AGENTS.md N2/N10). segman bumps only at Phase 1 (1.2.0) and
Phase 5 (2.0.0) unless a new command is added.

---

## 9. Open items (deliberately deferred, not blocking)

- Sub-sentence (exact-word) reference targeting — Phase 4 ships host-sentence
  targeting; word-precision is a possible later enhancement (fragile offsets).
- Reference autocomplete UI (the server-side slug index makes it possible).
- Whether `&title` should appear in the outline as a root node or be treated
  specially — cosmetic, decide during Phase 3.
