# NOTE_UI_PLAN — the UI for free-standing notes

Status: **SHIPPED 2026-11-25** (phases 1–4; each phase ran its tests and a
screenshot locally before its deploy). Follows NOTE_PLACEMENTS_PLAN.md (shipped
2026-11-24): a note has no home; where it appears is rows in
`note_sentence` / `note_scratchpad`; a note can sit on N sentences, in N
pads, or nowhere. This plan gives the author ways to USE that.

## 1. What the owner asked for (2026-11-25)

1. **Pad: colour buttons work with nothing selected.** Today a colour
   button needs a selection and turns it into a *text note* (an atomic
   highlighted run). With no selection it should insert a **sticky note as
   a block** at the caret — the real sticky note, drawn inline in the pad,
   left-aligned, the caret moving to the line after it. Same component as
   everywhere else.
2. **Pad: a 7th button, an ↗ arrow, right of the six colours.** Opens a
   picker of *recent sticky notes the user has access to, wherever they
   were created*. No selection → the picked note is inserted as a block;
   a selection → the picked note is applied to the text as a text note.
3. **Defaults:** reconcile default text — set only where a note is first
   created. In the manuscript the default is the sentence (or part of it).
   A bare block note in a pad has no clear default.
4. **Manuscript: the grey new-note card gets a right-aligned ↗ chip**
   (left chips are "n/a" and "+ tag"). Opens the same picker; the pick is
   attached to the sentence — tagging a sentence with a note from a pad, or
   from elsewhere in the manuscript.

## 2. Decisions

- **One widget.** Every rendering of a note — margin, pad float, landing
  card, and now the pad BLOCK — is `WriteSysNoteWidget.buildNoteElement`.
  No forks; location differences are handlers/flags.
- **Pad block = a new PM node `noteBlock`** (`group: block, atom,
  selectable, draggable`, attrs `{noteId}`), stored in the doc like
  `noteRef`. The pad save mirrors BOTH node types into `note_scratchpad`
  (server `noteIDsInDoc` learns `noteBlock`). Removing the block (Backspace
  on the node selection, cut, undo) closes the placement on save; only the
  widget's trash deletes the note — the same rule text notes have had since
  phase 2. Completing a block note removes the block (as completing a text
  note removes its ref).
- **Block look:** the sticky note at its natural width, left-aligned, with
  the pad's paragraph rhythm above and below. Insertion splits the
  paragraph at the caret when needed and leaves the caret in a paragraph
  after the block.
- **The picker is one component** (`web/notes/note-picker.js`): a search
  popover (the pad's picker-pop pattern) listing recent notes — colour,
  body or default text, where it lives (pad title · manuscript · nowhere),
  owner when not mine — newest first, search by text. Backed by a new
  `GET /api/notes/recent?q=&limit=` = live notes I own ∪ live notes placed
  on manuscripts I hold a role on, minus notes I've hidden. The picker
  excludes notes already placed where the pick would go.
- **Picking into a pad:** no selection → `noteBlock{noteId}`; a selection →
  `noteRef{noteId, text: snapshot}` (the selected words become that note's
  text run). The save makes the pad placement. Someone else's note placed
  in my pad renders with its text locked (lockBody), as the margin does.
- **Picking onto a sentence:** `PUT /api/notes/{id}/sentences/{sid}`
  (phase-2 API), then the margin reloads its notes for that sentence. The
  ↗ chip sits on BOTH grey cards (first and subsequent), right-aligned in
  the chip row.
- **Defaults:** `default_body` is set by the context a note is BORN in and
  never rewritten by a later placement (`refreshSentenceNoteDefaults` only
  touches notes whose content version 1 carries a sentence). Sentence-born: the sentence's
  `{fill-ins}`, else its first words (052 — already so, kept current while
  the note's primary sentence changes). Pad text note: its body IS the
  snapshot (no default needed). Pad block note: none — the widget's
  "Write a note…" placeholder. An imported note keeps what it had.
- **Detach vs delete in the margin (the gap the model opened):** a note on
  several placements must be removable from ONE sentence without dying.
  The margin's trash on a note with >1 placement becomes "remove from this
  sentence" (`DELETE /api/notes/{id}/sentences/{sid}`); on its last
  placement it deletes, as today. The tooltip says which.

## 3. Phases

### Phase 1 — pad block notes (deploy #1) — SHIPPED 2026-11-25
- schema `noteBlock`; `NoteBlockView` mounting the shared widget (handlers
  mirror the float's: save text, recolor → every view of the note, dims,
  delete via doc, complete → remove block, tags, link); registry so a
  recolor from the float updates blocks and refs alike.
- colour bar: no longer disabled on an empty selection; empty →
  `CreateScratchpadNote` (body null) + insert block + caret after.
- server: `noteIDsInDoc` reads `noteBlock`; the reconcile too (same fn).
- CSS: `.sn-note-block` (left-aligned block, widget width).
- tests: `tests/test-pad-block-notes.js` — click a colour with nothing
  selected → block inserted at the caret, caret on the next line, the block
  IS a `.sticky-note` (shared classes), text typed in it saves; reload keeps
  it; save → `note_scratchpad` row; Backspace removes the block → placement
  closed on save, note alive; trash → note deleted. Screenshot.

### Phase 2 — the picker and the pad's ↗ (deploy #2) — SHIPPED 2026-11-25
- API `GET /api/notes/recent` (+ Go test: visibility set, search, order).
- `note-picker.js`; the 7th button; insert as block / apply to selection.
- tests: API; e2e — pick a manuscript note into a pad as a block and as a
  text note; placements rows; a note I can't see is not listed. Screenshot.

### Phase 3 — the margin's ↗ chip and detach (deployed with phase 2)
- grey cards' right-aligned ↗ chip → picker → attach → margin refresh.
- margin trash: detach when multi-placed, delete when last.
- tests: e2e — attach a pad-born note to a sentence; it shows in the margin
  with its text; trash there detaches (note still in the pad); trash in
  the pad's block of a sentence-only note deletes. Screenshot.

### Phase 4 — docs — SHIPPED with phases 2+3
- ARCHITECTURE.md (frontend note contexts), NOTES_PLAN pointer, DEFERRED
  ("placing notes from the UI" retired), memory.

## 4. Out of scope (noted)
- A free note born on the landing page (no pad, no sentence) — the model
  allows it; no surface yet.
- Showing a note's other placements on the widget (a "·2" chip, a hop
  list) — useful once notes travel; later.
- Reordering a note's placements / choosing the primary.

## 5. As built (2026-11-25)

- Pad: `noteBlock` node + `NoteBlockView` (pad-notes.mjs) on the shared
  widget; `insertNoteBlock` splits the paragraph and parks the caret below;
  the float and the block share `noteWidgetHandlers`. Colour bar: six
  colours (text note with a selection, block without) + the ↗
  `.sn-note-pickbtn`. Server `noteIDsInDoc` reads `noteBlock`.
- Picker: `web/notes/note-picker.js` (`WriteSysNotePicker.open`), fed by
  `GET /api/notes/recent` (`ListRecentNotesForUser`: mine ∪ others' on my
  manuscripts, minus hidden; newest first; `q` search; `owner` in rows).
- Margin: `.attach-chip` on both grey cards → `attachExistingNote` (PUT
  sentences, then re-reads the sentence's notes); `removeOrDeleteNote`
  (placements count > 1 → DELETE the sentence placement, else delete);
  the trash's title says "Remove from this sentence" when the book shows
  the note on several sentences.
- Tests: test-pad-block-notes, test-note-picker-pad, test-note-attach-
  margin (all FAST), TestListRecentNotesForUser, noteIDsInDoc noteBlock.
  Gotcha found: two test runs on the shared dev DB wipe each other's pads
  (cleanupTestNotes hard-deletes every pad of user `test`) — never run
  DB-touching tests or probes in parallel.

## 6. Last 3 (2026-11-25)

The ↗ picker's feed (`GET /api/notes/recent`) leads with the viewer's
**last 3** notes — the ones they most recently focused, created or
updated — newest touch first, then everything else newest-updated first.
`note_touch (username, note_id, touched_at)` (changeset 058) holds at most
3 rows per viewer (`TouchNote` prunes on write). Focus is reported by the
shared widget (`POST /api/notes/{id}/touch`, any pointerdown on a saved
card or focus in its text, once per note per 20 s); create and update
touch server-side. Per viewer: your focusing moves nothing for anyone else.

## 7. The note modal (2026-11-25)

A note card on the landing, the daily board or a board no longer "opens in
context" — with placements a note has no single source. It opens
`WriteSysNoteModal` (`web/notes/note-modal.js`): the page greys out, the
FULL note (the shared widget, editable through the note API) sits centred,
and under it one card per placement — a manuscript card per sentence
(`GET /api/notes/{id}/placements` now carries the sentence `text`, whether
it is in the `current` version, and the `manuscript_name`), a pad card per
scratchpad — tiled in a forming square (`cols = ⌈√n⌉`: 4 → 2×2, 5 → 3+2).
Hovering a manuscript card shows the sentence as the book sets it
(scratch-render's shadow-root pipeline — book.css typography, white paper,
a shadow), as if snipped from the page; clicking goes to that sentence
(`#note-sentence=`); a pad card opens the pad at the note. Escape / the
backdrop close it and the page behind re-renders (`note-modal-closed`).
The Notes "+" births a free note and opens it here. The inline-editable
free-note card (§6) is gone — one editor, the modal.
