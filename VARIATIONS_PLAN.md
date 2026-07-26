# VARIATIONS_PLAN — snippets rearchitected as variation groups

**Status: implemented (2026-07-26).** Decisions below were
made by the author in conversation and must not drift; *(impl)* marks
engineering choices under those decisions. Supersedes the snippet model in
SCRATCHPAD_PLAN.md §6 (the scratchpad surface itself is unchanged).

## 1. Concepts (decisions)

- A **snippet** is an abstract group — almost no data of its own. It exists
  to relate variations and to carry group-level facts (global ID, canon
  pointer, manuscript link).
- A **variation** is the real content object: text, frozen flag,
  timestamps. A fresh snippet insert creates a snippet group + variation A.
- Variations are named by **letters** (A, B, C, …) derived from an INTEGER
  ordinal (1 = A). Hard cap 26 for now (creation refused past Z); the
  integer type future-proofs AA/AB (or numerals) without a schema change.
- **Based-on**: inserting a snippet widget asks **New or Variation**. If
  Variation: search/select an existing variation — default ordering by
  variation `updated_at` (most recent first). The new variation starts as a
  **copy of the source's text**, records the source as its **parent**, and
  the flow asks whether to **freeze the source**.
- **Frozen**: a frozen variation cannot be edited; unfreezing is one click.
  UI: a snowflake toggle that renders depressed while frozen.
- **Tabs** (parent/child topology — NOT all variations see all others):
  a widget for variation X shows: parent tab (with a parent icon) if any,
  X itself, X's children, and — if the group has one — the **Canon** tab
  (blue) which appears on EVERY variation of the group. Letters on tabs;
  overflow collapses into a dropdown.
- **Canon**: at most one variation per snippet is canon. Canonizing creates
  a **hidden canon variation** (special: no letter, permanently frozen) and
  inserts the text into the manuscript as ordinary free text wrapped in
  commands. Canonizing does NOT freeze other variations — the author keeps
  experimenting; canon and freeze share code (a canon variation IS a frozen
  variation with a pointer).
- **One home widget**: a variation lives where it was created; other
  scratchpads reach it via tabs (read-only context). Deleting its widget
  orphans the variation — the row stays, still reachable via parent/child
  tabs.
- **Manuscript link moves to the GROUP** *(impl, consistent with "one
  snippet, one destiny")*: `linkedManuscriptId` semantics from the previous
  round apply to the snippet, not per-variation; the chip renders on every
  variation of the group; canonize auto-links the group.

## 2. Canon source of truth (decision: derive from the manuscript)

- The manuscript remains the single source of truth for canon text. The
  canon tab live-resolves the region from the effective manuscript
  (committed + pending suggestions) — the existing Live-view machinery.
- The canon variation row stores only:
  - the **pointer** = (manuscript_id, snippet global ID) — NOT a sentence
    ID (sentence IDs churn every migration; the per-migration
    `command_slug` index turns the snippet ID into the anchor sentence in
    one lookup);
  - the **snapshot**: text at canonize time, immutable — rendered by the
    Snapshot tab and used as fallback when the region is broken
    (missing/mismatched commands), same strictness as before.
- The manuscript text is plain authorial text; the ONLY tie to the snippet
  system is the wrapping command pair.

## 3. `&snippet` command (segman v2.4.0)

- `&snippet#<snippet-id>{label}` opens a canon region; the existing
  `&end#<snippet-id>` closes it (end already matches by slug).
- The snippet ID is **globally unique across users**, slug-shaped:
  *(impl)* 10 lowercase base36 chars, generated server-side at group
  creation — short enough that the `.manuscript` file stays readable.
- `{label}` is required for outline presence: canonized regions keep
  appearing in the outline via their label, like anchors today.
- Segman: new keyword (block iff sole line content, RULE 10 atomicity,
  scenarios via 03-add-scenario tooling, SPECS, version bump).
  manuscript-studio: parse kind, render anchor-like (blue while suggested),
  outline entry from {label}, canonicalize house form, `command_slug`
  indexes the ID, validation.

## 4. Storage (Liquibase 015)

- Variation text moves OUT of scratchpad doc JSON — content is shared
  across scratchpads (tabs, freezing, sorting), so it must be rows:
  - `snippet(snippet_id VARCHAR(16) PK — the global base36 ID, user_id,
    linked_manuscript_id NULL, linked_manuscript_name, canon_variation_id
    NULL, created_at)`
  - `variation(variation_id SERIAL PK, snippet_id FK, ordinal INT NULL —
    NULL for the canon variation, UNIQUE(snippet_id, ordinal),
    parent_variation_id NULL FK, text TEXT, frozen BOOL DEFAULT false,
    created_at, updated_at)`
  - canon variation additionally uses `text` as the immutable snapshot.
  - *(impl)* `variation_revision(revision_id, variation_id, text,
    saved_at)` — autosave history, house pattern.
- The PM `snippet` node's attrs shrink to `{variationId}` — a placement
  marker; everything else is queried. `scratchpad_block` (010's derived
  index) is superseded and dropped.
- Edits autosave per-variation (`PUT /api/variations/{id}`, debounced,
  409 when frozen) — scratchpad doc autosave no longer carries text.

## 5. API

- `POST /api/snippets` `{mode: "new"}` → snippet + variation A.
- `POST /api/snippets` `{mode: "variation", source_variation_id,
  freeze_source}` → next ordinal (409 past 26), text copied, parent set,
  source optionally frozen.
- `GET /api/variations?sort=updated&q=…` — the Based-on picker.
- `GET /api/variations/{id}` → variation + group context (parent,
  children, canon, link) in one payload for the widget.
- `PUT /api/variations/{id}` `{text}`; `POST /api/variations/{id}/freeze`
  `{frozen}`.
- `POST /api/variations/{id}/canonize` `{manuscript_id, label,
  migration_id}` — creates the canon variation (frozen, snapshot), sets
  `canon_variation_id`, auto-links the group; the suggestion itself stays
  the client-side step 1 (existing PUT suggestion flow), now wrapping in
  `&snippet#id{label}` … `&end#id`.
- Auth: snippet rows are user-owned (edit); canon regions are visible to
  anyone with manuscript access via the book, as ordinary text.

## 6. Wordcount history impact

- `words_snippets` is variation-aware (confirmed 2026-07-26): a
  **canonized** group counts ONLY via the manuscript (`words_effective`) —
  its sibling variations contribute nothing. A **linked, non-canonized**
  group contributes exactly ONE representative: its most recently updated
  variation (siblings are alternatives of the same passage; summing them
  would inflate progress).

## 7. Migration of existing data

- None needed: the author deleted all existing snippets (2026-07-26).
  Legacy `book_content`/attr-text snippet nodes are simply no longer
  understood; the editor drops unknown legacy nodes on load.

## 8. Small locked details

- Widget dialog copy: "New snippet" / "Based on…" (never "pick a snippet"
  when picking a variation).
- *(impl)* The canon tab renders the live region with a small in-body
  live ⇄ as-canonized toggle (replaces the old top-level Snapshot tab).
