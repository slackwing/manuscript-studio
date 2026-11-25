# Boards (2026-11-25) — as built

Andrew's ask: *"new concept alongside manuscripts, scratchpads, and notes:
boards. should appear below scratchpads, above notes in the home page. a
board opens in a new tab and is a collection of notes just like daily
tasks … the top of the board should show the same exact component used to
configure daily tasks in settings, except show it on the board itself. the
user can configure what notes they'd like to see here … so i can look at
all notes tagged X or all 'would hone' notes … and save that view as a
board. one additional need unique to board is a manuscript picker:
multiple manuscripts can be picked, or none (meaning all are eligible).
build this into the component so that a boolean toggles this off in the
manuscript settings where it's not needed."*

## Model

- `board` (059): `board_id, user_id, name, manuscript_ids int[] (empty =
  all), created_at, updated_at, deleted_at` — soft-deleted like pads.
- Rules reuse `daily_rule` with a nullable `board_id`: NULL = the user's
  daily-task rules (unchanged); set = that board's rules. Same selectors
  (`task_type, priority, impact, color, blocked, tags`) and the same cap
  column `max_per_day` (a board reads it as "at most N notes through this
  rule", -1 = unlimited, the board default). `daily_rule_tag` unchanged.
- A board's notes (`ListBoardNotes` → `ApplyBoardRules`): the viewer's live,
  uncompleted notes whose manuscript (stamped `manuscript_id`, else the book
  of the primary sentence placement) is in `manuscript_ids` (or any, when
  empty); no rules → all of them; else a note shows when ANY rule matches
  it (a rule ANDs its selectors, as on the daily board) and that rule has
  quota. Newest-updated first. No pins, no date seeding, no 16 cap.

## API

`GET/POST /api/boards`, `GET/PUT/DELETE /api/boards/{id}`,
`GET/POST /api/boards/{id}/rules`, `DELETE /api/boards/{id}/rules/{rule_id}`
(`api/handlers/boards.go`). `GET /api/boards/{id}` returns `{board, rules,
notes, manuscripts}` — the page's one fetch; `manuscripts` is the picker's
list (the viewer's manuscripts). `GET /api/home` carries `boards` (with
`note_count`) for the landing section.

## UI

- **Shared editor** `web/notes/rules-editor.js` (`WriteSysRulesEditor.mount`):
  the criteria chip-row (note-widget.js `buildCriteriaRow`) + cap + Add,
  the saved rules as chip rows with ×, an optional **manuscript picker**
  (toggle chips; none on = all). `forDaily()` binds it to `api/daily-rules`
  (settings page, picker off); `forBoard(id)` to the board's rules (picker
  on, default cap ∞).
- **Board page** = a landing VIEW, `home.html?view=board&board_id=N`
  (home.js): the name (an input, saves on change, renames the tab), Delete,
  the editor, then the notes grid (the same cards as the landing — free
  notes editable in place). Opened as a **tab** (tabs.js type `board`, key
  `b<id>`, like a pad's named tab); standalone links route to the shell.
- **Landing**: a Boards section between Scratchpads and Notes — a card per
  board (name, rule chips, note count, ×) and a ghost "+" that creates a
  board and opens its tab.

## Later

- Daily tasks as a special per-manuscript board (Andrew's hunch): the
  model already allows it — a board with `manuscript_ids = [m]`, the daily
  rules as its rules, plus the pins/seed/16 policy as a board *kind*.
