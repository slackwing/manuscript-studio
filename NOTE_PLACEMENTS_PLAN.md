# NOTE_PLACEMENTS_PLAN.md — a note is a note; placements are rows

Status: **ALL PHASES SHIPPED** (2026-11-24; 057 dropped the legacy columns in prod the same evening). Supersedes NOTES_PLAN.md locked
decision 2 ("one home per note, carry-forward only WHERE sentence_id IS NOT
NULL") by the owner's call on 2026-11-24.

## The idea (owner, 2026-11-24)

> I don't know why a note is "owned" by a sentence or a scratchpad. That model
> can't support putting the note on multiple scratchpads, and I don't see why
> multiple sentences couldn't all be represented by the same note. I imagine a
> junction table of sentences to notes, and another of scratchpads to notes.
> And honestly, a note can just exist as a note, can't it?

Today the same task gets created twice — once in a pad, once on a sentence —
with the two sticky notes pointing at each other by hand.

## The model

| Table | Holds | Change |
|---|---|---|
| `note` | the thing: owner, color, body, task fields, completed, pinned, deleted, `manuscript_id`, `sketch_id` | `sentence_id` / `scratchpad_id` / `position` become legacy, dropped in phase 4 |
| `note_sentence` | one row per sentence PLACEMENT: note_id, sentence_id, position, origin sentence/migration/commit, `sentence_id_history`, `migration_confidence` | new |
| `note_scratchpad` | one row per pad a note appears in: note_id, scratchpad_id, created_at, `removed_at` | new; an INDEX of the pad docs, rebuilt from the doc on every save |

- **A note needs no placement.** A free note is a row in `note` and nothing
  else. It shows on the landing grid ("no context"), can be a task, can be
  pinned to a manuscript's daily board if `manuscript_id` is set.
- **`manuscript_id` stays on the note** and keeps today's meaning: "this task
  is about this book" — it drives the daily board, pinning, points'
  `from_daily` and the card's manuscript name. It is stamped from the first
  sentence placement (as today) and can be set/cleared explicitly. It is not
  a placement.
- **The pad doc stays the source of truth for pad placement** (NOTES_PLAN
  decision 5): a `noteRef` atom `{noteId, text}` IS the placement.
  `note_scratchpad` exists so the server can answer "which pads hold this
  note" without scanning JSONB; it is maintained server-side by diffing the
  doc on every pad save, which also retires the client-side "delete the note
  when its last anchor leaves" rule (the open question in NOTES_PLAN §Open
  Questions #1). `removed_at` keeps a completed note's pad context after its
  anchor is gone (today 5 prod notes are exactly that).
- **Sketch notes** (`sketch_id`, 1:1, undeletable) stay as they are. They can
  additionally receive placements later; nothing here depends on it.
- **Position** moves to `note_sentence` (order within one margin stack). A
  pad's order is doc order; pads never used position.
- **Versions.** `note_version` becomes CONTENT history only (appended by
  UpdateNote). Carry-forward lineage (history, confidence, origin) lives on
  the placement row and is repointed per placement. Today `note_version`
  conflates both: 3,589 rows for 121 live sentence notes, ~18 per note, almost
  all migration copies.

### Semantics decided here (UI comes later; these are the backend rules)

1. **Detach ≠ delete.** Removing a placement (an anchor leaves a pad doc; a
   future "take this note off this sentence" control) never deletes the note.
   A note whose last placement goes becomes a free note.
2. **Trash deletes the note** (margin trash, pad float trash, settings) —
   explicit, as today. The margin's "never mind" (an auto-created empty note
   the user backs out of) still deletes, because it created that note.
3. **Complete** changes no placements server-side. The pad UI keeps removing
   the anchor on complete; the placement row gets `removed_at`, so the card
   still says which pad it came from.
4. **Deleting a pad** removes its placements (`removed_at`); the notes
   survive as free notes or on their other placements. **Behavior change:**
   today `SoftDeleteScratchpad` soft-deletes every note homed there.
5. **Visibility follows placements.** A sentence placement makes the note
   visible, to viewers with `see-others-notes`, in that manuscript — exactly
   today's rule, per placement. Pads stay private. Owners always see their
   notes. Per-note authorization: owner, or (non-owner) access to the
   manuscript of the sentence the note is being viewed from.
6. **A note on two sentences of one book appears in both margins** — the book
   payload carries one row per placement with that placement's `sentence_id`,
   so the margin code keeps working unchanged. Focus tints only the sentence
   you're looking at.
7. **Default body** (the grey placeholder derived from the sentence) comes
   from the EARLIEST live sentence placement.
8. **Carry-forward per placement.** Each `note_sentence` row follows its own
   sentence through a migration (same matcher, same confidence, same stale
   tag). Two placements of one note whose sentences MERGE collapse into one
   row (the higher confidence wins). A placement whose sentence has no
   successor keeps today's fallback behavior (nearest mapped target,
   confidence 0, "stale" tag).
9. **Copy/paste of a noteRef between pads** creates a second placement on
   save — now a feature, not a hazard. Cut/paste inside a pad no longer risks
   deleting the note (the client delete-on-unmount rule is gone).

## What the research found (2026-11-24; agents' inventories, verified)

**Production data (read-only audit, 2026-11-24):** 348 notes, 252 live: 121
on sentences, 39 on pads, 92 sketch notes, 0 dual-homed, 0 homeless; every
live sentence note sits on its manuscript's latest done migration; 3,589
`note_version` rows, head sentence == latest version for every note; no
duplicate positions; 19 live pads, 35 `noteRef` atoms resolving to 35 live
notes; 5 pad notes without an anchor (all completed); 1 anchor to a deleted
note (#149 in pad 16); legacy `noteAnchor` shape only in 11 old
`scratchpad_revision` rows (write-only history); two users (andrew, admin).
Liquibase is at changeset 55 (053-api-token).

**Code that assumes one home** (file:line on origin/main e46a5ce):

- Readers keyed on `note.sentence_id`: `GetNotesByCommit`/`GetAllNotesByCommit`
  (inner join → the book payload, `internal/database/notes.go:81-169`),
  `GetNotesBySentence`/`GetAllNotesBySentence` (173, 298),
  `GetActiveNotesForSentences` (803, the migration's gather),
  `refreshSentenceNoteDefaults`/`BackfillNoteDefaults` (note_defaults.go:22,
  80), `ReorderNote` (873), access helpers `requireOwnedNote` /
  `requireNoteWithAction` (api/handlers/notes.go:73-139),
  `HandleScoreNotePoints` (728), `homeNoteSelect` (home_notes.go:54-89:
  `COALESCE(n.scratchpad_id, sketch home pad)`, `LEFT JOIN scratchpad ON
  n.scratchpad_id`), `SoftDeleteScratchpad` cascade (scratchpads.go:146),
  `CreateNote`/`CreateScratchpadNote` MAX(position) scoped per column.
- Writers: `CreateNote` (version 1 + manuscript stamp), `CreateScratchpadNote`
  (no version), `UpdateNote` (rewrites sentence_id; needs ≥1 version),
  `UpdateScratchpadNote` (guard `scratchpad_id IS NOT NULL OR sketch_id IS NOT
  NULL`, no RowsAffected check), `MigrateNotes` (notes.go:598: needs a version
  row, guard `sentence_id IS NOT NULL`, all-or-nothing), `SetNoteManuscript`.
- Handler branches: create (scratchpad wins, else sentence required, else
  400 — free notes impossible), update (versionless path for pad/sketch),
  delete (sketch refused), points (manuscript from sentence else
  manuscript_id).
- Frontend: the book never fetches per sentence — notes ride in
  `GET api/migrations/{id}/manuscript` and are filtered by `sentence_id` in
  `web/js/notes.js:231,298,80` and `renderer.js:1626` (bars). The pad
  (`web/scratchpad/pad-notes.mjs:341-360`) deletes the note on the server
  when its last anchor in THAT pad unmounts, with suppression flags for
  teardown/complete. Home cards read `context`, `scratchpad_id`,
  `manuscript_id`, `sentence_id` (`home.js:228-293, 437-454`). The widget
  never reads sentence_id/scratchpad_id. 14 JS tests seed notes with raw SQL
  on the home columns; ~30 more read/delete by them; `cleanupTestNotes`
  deletes by the sentence path.
- Migration processor (`internal/migrations/processor.go:155-379`): plan =
  matcher (exact 1.0 / word-Levenshtein ≥0.40) + fall-forward gaps at
  confidence 0 + suggestion-driven overrides ≥0.8; notes gathered OUTSIDE the
  tx, repointed in one tx BEFORE suggestions settle and `MarkMigrationDone`
  (a later failure strands them on an errored migration — pre-existing,
  noted, not fixed here); stale tag best-effort after commit.
- Deploy (`install.sh`): Liquibase runs while the OLD container serves; swap
  is seconds; a failed changeset leaves the old container up but earlier
  changesets committed; no backup step; no usable `rollback` blocks; the
  GitHub webhook and `ResegmentOnSegmenterChange` at boot can both run
  `MigrateNotes` during a deploy window; margin note saves have no retry
  (pads do).

## Phases — each shippable, tests green, deployed with `./remote-deploy.sh`

Legend: ⏸ = stop and wait for the owner's "continue" before this step.

### Phase 0 — groundwork (no prod change)
- [x] Read-only prod audit (above). Keep `scratchpad/prod-notes-audit*.sql` in
  the session for re-runs.
- [x] `debug/snapshot_notes.sh`: `\copy` of `note`, `note_version`,
  `note_tag`, `note_hide`, `point_event`, `note_sentence`, `note_scratchpad`,
  `scratchpad` (docs) to timestamped CSVs on the VM (`~/backups/notes-<ts>/`),
  run before every deploy of this plan. Small data; seconds.
- [x] Rehearsal (2026-11-24): the WHOLE prod DB copied into a scratch
  Postgres (COPY per table over ssh — the VM's pg_dump is v13 against a
  PG18 server), Liquibase at 053, then 054+055 applied: 193 sentence
  placements (121 live), origin == version 1 and history == latest version
  for every row, 63 pad rows (35 live, 5 completed closed, 1 dangling
  anchor); the branch server's boot reconcile against it: +0/+0, 19 pads
  synced, counts unchanged. Partial copies mislead (055 failed on the
  `origin_migration_id` FK with an empty `migration` table) — always copy
  everything.

### Phase 1 — additive schema, backfill, dual-write (deploy #1)
Readers untouched; nothing visible changes.
- [x] `054-note-placements.xml`: create `note_sentence` + `note_scratchpad`
  (+ indexes). DDL only — short lock.
- [x] `055-note-placements-backfill.xml`: `INSERT … SELECT … ON CONFLICT DO
  NOTHING` from the legacy columns; `note_sentence` origin from version 1,
  history/confidence from the latest version; `note_scratchpad.removed_at`
  = NULL when a live pad doc references the note, else `note.updated_at`.
  Idempotent; re-runnable as SQL by hand.
- [x] `ReconcileNotePlacements()` at boot (and callable): the same inserts
  plus the doc-derived pad rows — closes the window where the old container
  wrote notes after Liquibase committed, and any rollback window.
- [x] Dual-write: `CreateNote` → `note_sentence`; `CreateScratchpadNote` →
  `note_scratchpad`; `MigrateNotes` → repoint `note_sentence` rows too
  (history/confidence on the row); `SoftDeleteScratchpad` → `removed_at`;
  `ReorderNote` → placement positions; pad `HandleUpdate` → diff `noteRef`
  ids against live `note_scratchpad` rows (insert / set / clear
  `removed_at`), best-effort — a diff failure is logged and never fails the
  save.
- [x] Tests: Go — parity after every write (junction == legacy columns),
  doc-diff cases (add, remove, re-add, deleted note, legacy noteAnchor shape
  ignored), reconcile idempotent, processor integration: placements move
  with notes, merge dedupe. JS — `test-utils` gains `seedNote()` writing both
  shapes; `cleanupTestNotes` and the Go nuke helpers delete via the junction
  too (cascade from `note` covers the rest).
- [x] Deploy #1 after `snapshot_notes.sh`. Not a data-loss step. Verify
  `/readyz`, container logs for "placements reconcile", and parity counts via
  `connect_db.sh`. (Shipped 2026-11-24, 76cc5d2: 054/055 ran, 193 sentence
  + 63 pad rows, parity 193/193 and 63/63, reconcile +0/+0.)

### Phase 2 — readers, carry-forward and semantics on the junction (deploy #2)
Legacy columns still written (= the PRIMARY placement: the earliest sentence
the note was placed on; NULL when none), no longer read.
- [x] `056-note-placements-readers.xml`: `note_version.sentence_id`,
  `origin_sentence_id`, `origin_commit_hash` nullable; sentence FK → `ON
  DELETE SET NULL` (was RESTRICT, which blocked migration undo). Plus a
  TRANSITIONAL TRIGGER `trg_note_legacy_home_mirror`: an INSERT with a
  legacy `sentence_id`/`scratchpad_id`, or an UPDATE of `sentence_id`,
  mirrors into the junction — covers the phase-1 container in the deploy
  window, a rollback, and the suite's raw-SQL fixtures (nothing can drift
  the index while both shapes coexist). Dropped with the columns in phase 4.
- [x] Readers → junction: `noteColumns` derives sentence/position/pad from
  the primary placement for single-note readers; `placementColumns` for the
  per-placement list readers (book payload: one row per placement;
  per-sentence lists; the migration gather); note defaults from the
  primary placement; home/daily context = first live pad (deleted pads
  never) + primary sentence; access helpers check the manuscripts of a
  note's placements (owner: any one; non-owner: `action` on any one, else
  `manuscript_id`); points resolve the manuscript the same way; reorder
  takes the placement's sentence (`sentence_id` in the body, "" = primary).
- [x] Carry-forward per placement (`NoteMigrationItem.OldSentenceID`);
  insert-then-delete repoint merges placements that land together; the
  stale tag once per note; migrations write NO `note_version` rows any
  more — `note_version` is content history (one row per edit, for every
  kind of note; `UpdateNote` is the single update path, the versionless
  `UpdateScratchpadNote` is gone).
- [x] API: `POST /api/notes` with neither sentence nor pad → free note
  (optional `manuscript_id`, access-checked); `PUT|DELETE
  /api/notes/{id}/sentences/{sid}`; `GET /api/notes/{id}/placements`.
  `SoftDeleteScratchpad` closes placements and leaves the notes alive.
- [x] Frontend: the pad's NodeView `destroy()` no longer deletes (an anchor
  leaving the doc closes the placement on save); the trash
  (`deleteNoteViaDoc`) deletes explicitly; the teardown/suppress flags are
  retired. No margin or home changes needed (one row per placement; the
  server composes the context).
- [x] Tests: Go — free/attach/detach/placements/manuscripts-for-note, pad
  delete leaves notes, content-version semantics, carry per placement
  (follow both, merge, free note untouched); JS — `test-note-placements`
  (API: both shapes, save mirroring, two margins, attach/detach, free note
  lifecycle, pad delete); `test-scratchpad-notes` re-pinned to the new
  rules. Raw-SQL fixtures keep working through the trigger.
- [x] ~~⏸ Before deploy #2~~ The owner lifted the pause ("I'm not working on
  the book at all, power through the phases", 2026-11-24) — phases 2 and 3
  shipped as ONE deploy (see phase 3), after `snapshot_notes.sh`.

### Phase 3 — stop writing legacy columns (deployed WITH phase 2)
- [x] Remove the dual-writes (`CreateNote`, `CreateScratchpadNote`,
  `CreateFreeNote`, sketch notes, `MigrateNotes`, `ReorderNote`, attach /
  detach — `syncLegacyPrimarySentence` is gone; 056 also makes
  `note.position` nullable so the still-present column tolerates it), the
  legacy-column reads in tests (`seedNote()` in `test-utils` writes a note
  row + its placement; the nuke helpers delete via `note_sentence`; the Go
  helpers read the primary placement), the raw-SQL seeds; `undo_migration.sh`
  + its test retired (stale since the `annotation` rename; a rewrite can
  come back when it is needed). `ReconcileNotePlacements` is pad-doc
  mirroring only.
- [x] ~~One deploy cycle of soak~~ replaced, at the owner's "power through",
  by the full prod-copy rehearsal: the final binary against the copy with
  the columns present (every write path over HTTP as `andrew`: create
  sentence / pad / free note, attach, reorder, update, detach, complete,
  trash — and 542 captured payloads), then 057, then the same captures again
  byte-identical.

### Phase 4 — contract (deploy #4)
- [x] `057-note-placements-drop-legacy.xml`: a guarded `DO` block (raises —
  and the changeset rolls back, the old container keeps serving — if any
  legacy home lacks its placement row), then drops the mirror trigger and
  `note.sentence_id`, `note.scratchpad_id`, `note.position` (their indexes
  and the pad FK go with the columns). Snapshot first. Rehearsed on the prod
  copy: guard 0/0, payloads identical before and after. Shipped
  2026-11-24 after a fresh `snapshot_notes.sh`; the full local suite on the
  post-057 schema was green except the five tests that cannot run on the
  scratch stack (dev-repo paths, bare origin, >6 seeded pads).
- [x] Found on the way (test-settings): phase 2's single update path turned
  the pad float's two back-to-back PUTs (task-type patch, then the type's
  recolor) into whole-row read-modify-writes that clobbered each other.
  `PatchNote` applies only the named fields in one statement
  (`TestPatchNote_ConcurrentFieldPatchesBothLand`).
- [x] Docs: ARCHITECTURE.md data model + migration notes, NOTES_PLAN.md
  pointer, DEFERRED.md (placing notes from the UI), install.sh tool list.

## Rollback story
- Phase 1: nothing reads the new tables; a bad deploy rolls the container
  back and the tables sit unused. `ReconcileNotePlacements` repairs drift on
  the next boot.
- Phases 2+3 (one deploy): the legacy columns stay but are no longer
  written, so a rollback to the phase-1 image shows notes created in between
  without a margin home until the phase-2/3 image comes back (nothing is
  lost: the placement rows are there). The window was empty by arrangement
  (owner away). A junction bug shows as notes missing from a view, not data
  loss; the snapshot CSVs cover the rest.
- Phase 4 is the only irreversible step: the columns can be re-added from
  the snapshot CSVs (`note.csv` has them) if a rollback to a pre-057 image
  were ever needed; no image after phase 1 reads them.

## Out of scope (noted for later)
- UI for placing an existing note (pad→sentence, sentence→pad, free→anywhere)
  and the card context design for N placements — **now NOTE_UI_PLAN.md
  (2026-11-25).**
- The processor's stranding hazard (notes committed before `MarkMigrationDone`).
- Sketch notes as placements.
