# NOTES_PLAN.md — Notes everywhere

Status: **PHASES 1a–3 SHIPPED** (2026-07-28). annotation→note rename (prod data
preserved: 52 notes), nullable context columns, reusable note-api/note-widget,
scratchpad notes (highlight→colored note+anchor+float), and the landing Notes
section are all live and test-covered. Future: filters/sort on the Notes grid;
optional full core-widget/adapter unification of the manuscript margin; manuscript
notes (manuscript_id only) + free notes UI. Original plan + decisions below.

## Vision

Today "annotations" are sticky notes bound to a specific sentence in a specific
manuscript. We are generalizing them into **notes**: entities *owned by the
user* that can optionally be placed in a context.

A note has an optional `manuscript_id`, optional `sentence_id`, and optional
`scratchpad_id`:

- **sentence note** — manuscript_id + sentence_id set (today's annotation).
- **manuscript note** — manuscript_id only (a note about the whole book). *(future)*
- **scratchpad note** — scratchpad_id only (this project's phase 2).
- **free note** — nothing set (a plain note the user owns). *(future)*

The landing page gains a third section, **Notes**, showing recently-touched
notes as a grid. Filters/sort come later.

The same sophisticated sticky-note UI we have in the manuscript view is reused
everywhere (manuscript margin, scratchpad float, landing grid), via a
placement-agnostic core widget + thin placement adapters.

---

## Terminology

A note with a priority (P0–P3) — or marked **blocked** (a fifth,
mutually-exclusive priority-like state: "no further action for now") —
is a **TASK**. Tasks get two independent
affordances once a priority is assigned: the green checkmark **completes**
(`completed_at`), and the yellow star **scores points** — each scoring is
one `point_event` row (note_id, points 1–99, scored_at; soft-deletable), so
a task can be scored repeatedly while open, and stats/weekly sums fall out
of the events table. Every sketch (né snippet) also carries one note (`note.sketch_id`,
026/030), minted with it — undeletable, wearing the derived, unremovable
"sketch" chip.

## Locked decisions (from author)

1. **Rename in place**, don't rebuild. `annotation` → `note` across DB, Go, JS,
   tests. Keep the current behavior and keep all existing tests green.
2. **One `note` table** for all notes. `manuscript_id`, `sentence_id`,
   `scratchpad_id` all nullable, set per context. Migration carry-forward logic
   only touches rows `WHERE sentence_id IS NOT NULL`.
3. **Core widget + placement adapters.** Extract a placement-agnostic note
   widget (renders color/text/tags/priority/collapse↔expand, talks to the note
   API) from its positioning. Three adapters: manuscript margin, scratchpad
   float, landing card.
4. **Collapsed ↔ expanded mode** is a first-class feature of the widget: a
   collapsed "card" view (cut-off text) that expands on click. Used by the
   landing grid especially.
5. **Scratchpad anchor = the inline widget.** A scratchpad note stores
   `scratchpad_id` + `note_id`; the *anchor* (which text, where) lives entirely
   in the ProseMirror doc as an inline widget node carrying `note_id`. The doc
   is the source of truth for placement.
6. **Soft-delete** when the inline widget is undone/deleted — the note row is
   soft-deleted (recoverable), not hard-deleted or orphaned.
7. **6 color buttons always CREATE.** Clicking a color with text selected always
   mints a new note in that color + wraps the selection in the inline widget.
   Re-color later via the note's own picker. Buttons disabled when nothing is
   selected. No grey/never-mind for scratchpad notes — the color was chosen, so
   the note is real immediately.
8. **Sequencing:** rename → add columns → extract core → then scratchpad notes →
   then landing grid. Each step independently shippable and test-verified.

---

## Current architecture (as-explored)

### DB (all in the FROZEN `001-initial-schema.xml` + later changesets)
- `annotation` — head row. Columns: `annotation_id` PK, `sentence_id`
  VARCHAR(100) NOT NULL (no FK; sentences churn per migration), `user_id`,
  `color` (CHECK: yellow/green/blue/purple/red/orange), `note` TEXT, `priority`
  (CHECK none/P0..P3), `flagged`, `position` (fractional index), `created_at`,
  `updated_at`, `deleted_at` (soft-delete), `completed_at` (added by
  `004-annotation-completed.xml`). No unique constraint (multiple notes per
  sentence allowed).
- `annotation_version` — append-only history. `(annotation_id, version)` PK,
  full snapshot + migration-tracking columns: `sentence_id_history` JSONB,
  `migration_confidence`, `origin_sentence_id`, `origin_migration_id`,
  `origin_commit_hash`.
- `tag` — `(tag_name, migration_id)` unique; **tags are scoped per migration**.
- `annotation_tag` — junction.

### Go
- Models in `internal/models/models.go` (`Annotation`, `Tag`, `AnnotationTag`,
  `AnnotationVersion`).
- Handlers in `api/handlers/annotations.go` (`AnnotationHandlers`), routes in
  `api/server.go:258-268`.
- CRUD in `internal/database/queries.go` (`GetAnnotationsByCommit`,
  `CreateAnnotation`, `UpdateAnnotation`, `SoftDeleteAnnotation`,
  `CompleteAnnotation`, `ReorderAnnotation`, tag ops, `MigrateAnnotations`).
- **Migration carry-forward:** `internal/migrations/processor.go`
  `migrateAnnotations` → `DB.MigrateAnnotations` (`queries.go:1032`) repoints
  `sentence_id` in place (all-or-nothing tx) and records confidence + history in
  a new `annotation_version` row. This is the load-bearing logic that MUST keep
  working for sentence notes.

### Frontend
- `web/js/annotations.js` (`WriteSysAnnotations`, ~1216 lines). Tightly coupled
  to the manuscript: reads `WriteSysRenderer.currentAnnotations` (bulk cache),
  positions via page-gutter math (`SPACING`, `initAnnotationMargin`), drives
  rainbow bars, owns the grey/never-mind flow (`neverMindState`,
  `commitPendingNote`).
- Sticky element built by `createStickyNoteElement` (line 278): `.note-input`
  textarea, `.tags-list`, priority/flag chips, trash, complete-check, color
  circle + palette.
- Colors in `css/book.css :root`: `--highlight-{color}` (sentence bg),
  `--sticky-{color}` (note bg), `--chip-{color}` (+ text), `--outline-{color}`.

### Scratchpad editor (ProseMirror)
- `web/scratchpad/editor-core.mjs`. Schema: `coreNodes` (28-83), `marks` (85-88,
  only strong/em). Exported `schema` (97). NodeView template = `SnippetView`
  (256-774), registered in `nodeViews` map (1220-1224). Toolbar `items` array
  (1128-1156) + render loop; `markActive` (810-814); `insertBlockSafely`
  (791-800). Autosave rides the `doc` JSONB — **no server schema change needed
  for the inline anchor node or a highlight mark.**
- Landing page: `web/js/home.js` `WriteSysHome`, `section()` (74-84) +
  `manuscriptCard`/`scratchpadCard`; `/api/home` = `api/handlers/home.go`.

---

## The plan (phases)

### Phase 1a — Rename `annotation` → `note` (behavior-identical)

Goal: pure rename, every existing test still green, zero behavior change.

- **DB migration** (new changeset, NOT editing frozen 001): rename tables
  `annotation`→`note`, `annotation_version`→`note_version`,
  `annotation_tag`→`note_tag`; rename columns `annotation_id`→`note_id`
  (everywhere it appears, incl. FKs and `note_version`/`note_tag`); rename
  indexes/constraints (`chk_annotation_*`→`chk_note_*`, `idx_annotation_*`→
  `idx_note_*`, FKs). `tag` keeps its name. Verify `make db-reset db-migrate`.
- **Go:** rename types (`Annotation`→`Note`, etc.), files
  (`annotations.go`→`notes.go`), functions (`CreateAnnotation`→`CreateNote`…),
  routes (`/api/annotations/*`→`/api/notes/*`), and the migration function
  `MigrateAnnotations`→`MigrateNotes`. Keep signatures otherwise identical.
- **JS:** `WriteSysAnnotations`→`WriteSysNotes`, `annotations.js`→`notes.js`,
  all `/api/annotations/*` fetches → `/api/notes/*`. Update the bulk-load field
  `currentAnnotations`→`currentNotes` in renderer.js.
- **Tests:** rename references; keep every assertion. `test-utils`
  `cleanupTestAnnotations`→`cleanupTestNotes`. Run the full suite green.
- Cache-bust every touched web asset. Deploy. **Checkpoint: identical behavior.**

Risk: big mechanical diff. Mitigation: do it as a scripted rename + hand-verify,
land it alone, keep the commit reviewable.

### Phase 1b — Add nullable context columns

- New changeset: add `manuscript_id INTEGER NULL` and `scratchpad_id INTEGER NULL`
  (FKs to `manuscript`/`scratchpad`, `ON DELETE SET NULL`) to `note`; make
  `sentence_id` **nullable** (drop NOT NULL). Backfill `manuscript_id` for
  existing sentence notes from their sentence→migration→manuscript chain so the
  landing grid can show context without a runtime join.
- Adjust `CreateNote` to accept the optional context and to keep deriving
  origin/migration info only when `sentence_id` is present.
- `MigrateNotes` gains a `WHERE sentence_id IS NOT NULL` guard (only sentence
  notes carry forward). Add a test: a scratchpad note (no sentence_id) is
  untouched by a manuscript migration.
- **Checkpoint: sentence notes still migrate; other note kinds ignored.**

### Phase 1c — Extract the placement-agnostic core widget

Goal: same manuscript behavior, but the widget is now reusable. All manuscript
note tests stay green (this is the safety net).

- Create `web/notes/note-widget.js` (`WriteSysNoteWidget`): a factory that,
  given a note object + an API adapter + callbacks, renders the full sticky-note
  DOM (color circle + palette, textarea, tags, priority/flag, trash, complete)
  and wires all interactions — **no positioning, no manuscript cache, no rainbow
  bars.** It exposes a `collapsed`/`expanded` mode.
- `web/notes/note-api.js`: thin CRUD wrapper over `/api/notes/*` (create,
  update, delete, complete, reorder, tags) usable from any context.
- `web/js/notes.js` (the renamed manuscript file) becomes the **manuscript
  margin adapter**: it keeps the gutter math, the `currentNotes` cache, the
  rainbow-bar wiring, and the grey/never-mind flow, but delegates the actual
  note DOM/behavior to `note-widget.js`. The never-mind/grey state stays here
  (it's a manuscript-margin concern, not a core-widget one).
- Re-run ALL note/tag/rainbow/never-mind/xss tests. **Checkpoint: behavior
  identical, code now reusable.**

Note on the collapse/expand mode: the core widget renders a compact card (color
swatch + clipped text + tiny context line) that expands to the full sticky note
on click. The manuscript margin uses the always-expanded form (today's look);
the landing grid uses collapsed-by-default.

**BUILD DECISION (during 1c):** The manuscript margin's note flow (cache,
rainbow bars, grey/never-mind, gutter math) is deeply intertwined and fully
test-covered. Rewriting it into an adapter-over-core-widget carries high risk
for little immediate benefit. So 1c is scoped PRAGMATICALLY: (a) `note-api.js`
is a PURE CRUD wrapper over `/api/notes/*` (no cache/callbacks) that Phase 2 &
3 use directly; (b) a standalone `buildNoteElement(note, handlers)` renders the
sticky DOM (extracted so the scratchpad float + landing card reuse the EXACT
same markup/CSS) with a `collapsed` option; (c) the manuscript margin
(`notes.js`) is LEFT AS-IS and keeps its own working API+cache logic. Full
core-widget/adapter unification can happen later if the duplication bites; for
now the reusable pieces (api + buildNoteElement + CSS) are enough to build
scratchpad notes and the landing grid without destabilizing the margin. All
existing note tests stay green because notes.js is untouched.

### Phase 2 — Scratchpad notes

Depends on 1a–1c. No server schema change beyond phase 1b (anchor lives in the
doc JSONB; note content lives in the `note` table).

- **Schema (ProseMirror), in `editor-core.mjs`:**
  - Add a `highlight` **mark** with a `color` attr → renders
    `<span class="sn-hl sn-hl-{color}">` using the shared `--highlight-{color}`
    vars. (Add to `marks`, 85-88.)
  - Add a `noteAnchor` **inline atom node**: `{ inline:true, group:'inline',
    atom:true, attrs:{ noteId, color }, parseDOM/toDOM }` → renders the little
    rounded color square. (Modeled on `snippet`, 66-76.)
- **NodeView** `NoteAnchorView` (modeled on `SnippetView`): renders the square;
  clicking it opens/toggles the floating note for editing; hover shows an
  **undo** affordance that removes the anchor node AND its highlight mark over
  the range AND soft-deletes the note. Self-delete via `getPos()` + `tr.delete`.
- **Toolbar:** a right-aligned section of **6 colored square buttons** (own flex
  group, `margin-left:auto`). Disabled when the selection is empty. On click
  with a selection:
  1. `POST /api/notes` `{ color, scratchpad_id }` → get `note_id` (real note,
     immediately; no grey state).
  2. Wrap the selected range in the `highlight` mark (that color).
  3. Insert a `noteAnchor` inline node (with `note_id` + color) at the start of
     the range so the rendered result is: `▢ <space> <highlighted text>`.
  4. Open the floating note below the selection for editing.
- **Floating note UI = the core widget** (phase 1c), positioned below the
  highlighted range instead of in a gutter (scratchpad-float adapter). It starts
  already-colored. Clicking outside hides it; clicking the anchor square
  re-opens it. Reuses the same color picker, tags, priority — everything.
- **Inline widget appearance:** the highlighted text looks exactly like normal
  text but with the note's `--highlight-{color}` background; it is NOT editable
  (it's inside/adjacent to the atom anchor). Undo turns it back to plain text.
- **Lifecycle:** undo/delete the anchor → soft-delete the note (recoverable).
  Deleting the paragraph containing the anchor → same (the NodeView's destroy or
  a doc-diff sweep detects the removed anchor). *(Open item: how to detect an
  anchor removed by a bulk edit — see Open Questions.)*
- **No notes inside snippet widgets** — explicitly out of scope.
- Tests: create-note-from-selection, anchor square opens/closes the float,
  outside-click hides, undo restores plain text + soft-deletes, autosave
  round-trips the mark + anchor node, reload rehydrates.

### Phase 3 — Landing "Notes" section

- Extend `/api/home` (`home.go`) with a `notes` slice: recent non-deleted notes
  for the user, each with a small context descriptor (manuscript name + page, or
  scratchpad title, or "no context"), ordered by `updated_at` desc, limited to
  the recent N (like manuscripts/scratchpads).
- `home.js`: add `noteCard()` (the core widget in collapsed mode) and a
  `this.section('Notes', …)` after Scratchpads, plus a `?view=notes` full list.
- Click a note card → expand in place (collapse/expand mode); a secondary action
  opens it in context (manuscript scrolled to sentence / scratchpad opened).
- Filters/sort: **deferred** to a later phase (leave hooks).

---

## Open questions / risks to resolve during build

1. **Anchor removal detection.** When the inline anchor is removed by a *bulk*
   edit (select-all delete, paragraph delete) rather than the explicit undo
   button, ProseMirror may or may not fire the NodeView `destroy` reliably for
   soft-deleting the note. Likely need a doc-diff-on-save sweep: on each save,
   diff the set of `noteAnchor` node ids present vs. the notes the DB thinks are
   in this scratchpad, and soft-delete the missing ones. Decide in phase 2.
2. **Tag scoping for scratchpad notes.** Tags are currently scoped per
   `migration_id` (a manuscript concept). Scratchpad notes have no migration.
   Options: make tag scope nullable (user-global tags for scratchpad notes), or
   scope by scratchpad_id. Decide when phase 2 reaches tags — MVP could omit
   tags on scratchpad notes.
3. **Rainbow bars.** Manuscript-only feature; scratchpad notes don't get them.
   Keep the rainbow wiring in the manuscript adapter only. **Author note: may
   drop rainbow bars entirely after this refactor in favor of a different UI.**
   So: try FIRST to preserve them through the rename + extraction with all tests
   passing; but if the rainbow coupling makes the core-widget extraction
   painful, it's acceptable to rip rainbow bars out wholesale (and delete their
   tests) rather than contort the refactor around them. Preserve-first,
   remove-if-costly.
4. **Reorder / position.** `position` (fractional index) is meaningful for
   multiple notes on one sentence. For scratchpad notes, position within a
   single anchor's note list — probably a single note per anchor, so position is
   trivial. Confirm one-note-per-anchor in phase 2.
5. **Migration of the rename itself on prod.** The rename changeset runs via
   Liquibase on deploy (`remote-deploy.sh`). Prod has live annotation data
   (The Wildfire) — the rename must be a pure `RENAME`, preserving all rows.
   Verify against a prod DB snapshot before deploying phase 1a.

---

## Test strategy

- Phases 1a/1c are guarded by the EXISTING note test suite — the whole point of
  rename-then-extract is that these tests prove no behavior changed.
- Each new capability (nullable columns, scratchpad note create/anchor/undo,
  landing grid) gets its own test with teeth (proven to fail without the code),
  classified in `test-all.sh`.
- Go migration tests (`processor_test.go`) must still pass after the rename +
  the `WHERE sentence_id IS NOT NULL` guard.
- Real-device / visual checks via Playwright screenshots for the scratchpad
  float and landing cards (headless can't prove some layout, per AGENTS N12).
