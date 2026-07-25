# HOME_PLAN — landing page, global top bar, scratchpad modal

**Status: implementing (2026-07-25).** Agreed design; extends
SCRATCHPAD_PLAN.md (whose deferred "Evernote-style homepage" this is).

## Decisions (author's calls)

1. **Landing page after login** (`home.html`, always — login never jumps
   straight into a manuscript): recent manuscript cards + recent scratchpad
   cards, Evernote-style, sleek/modern. "See all →" per section switches the
   same page to a scrollable all-cards grid (`?view=manuscripts|scratchpads`).
2. **Global top bar** (shared component, both pages): home icon + the
   "manuscript studio" wordmark — BOTH click through to the landing page —
   then a **search box**. Search v1 finds manuscripts and scratchpads by
   name/title (server FTS later). Selecting a manuscript opens it; selecting
   a scratchpad opens **the modal** — over the landing page or over an open
   manuscript alike. No more Scratchpads button; no more manuscript
   dropdown (picker deleted; its test replaced by a search test).
3. **Scratchpads are modal-only.** `scratchpad.html` (page + sidebar list)
   dies; one editor component + one singleton modal manager host it
   everywhere. Only ONE scratchpad modal open at a time — by construction.
   Modal has an expand-to-full-viewport toggle; the open pad rides the URL
   (`#scratchpad=N`) so reload restores it. PM bundle lazy-loads on first
   open (dynamic import) — the book page pays nothing until summoned.
4. **The top bar no longer owns manuscript-specific chrome.** The updated
   label, info icon, and GitHub push button move to a compact strip above
   the outline in the left margin (`#manuscript-chrome`). Cheatsheet icon
   stays global-ish (manuscript page only for now).
5. **Recency = last opened by YOU**: `manuscript_opened(user_id,
   manuscript_id, last_opened_at)` (Liquibase 011), stamped when a
   manuscript loads. Scratchpad recency is `updated_at` (already tracked).

## Backend

- Changeset 011: `manuscript_opened`, PK (user_id, manuscript_id).
- `POST /api/manuscripts/{id}/opened` — upsert stamp (fire-and-forget from
  the book page).
- `GET /api/home` — one fetch for cards AND the search index:
  `manuscripts: [{manuscript_id, name, last_opened_at?, processed_at?,
  sentence_count?}]` (accessible only; last-opened first, then activity),
  `scratchpads: [{scratchpad_id, title, updated_at, snippet, block_count,
  canonized_count}]` (snippet + counts derived from the doc JSON in Go).

## Frontend

- `js/topbar.js` + `css/chrome.css`: the shared bar (home, wordmark,
  search+dropdown, spacer, page-extras slot, logout).
- `home.html` + `js/home.js` + `css/home.css`: sections/grids of cards; "+
  New scratchpad" in the scratchpads section (creates → opens modal).
- `scratchpad/editor-core.mjs`: the editor extracted from the old page
  shell into `createScratchpadEditor(els, id)` (instance-scoped state,
  autosave, destroy-flush). `scratchpad/modal.mjs` + tiny classic loader
  `js/scratchpad-modal.js`: singleton modal (title, toolbar, editor, save
  status, expand, close), injects scratchpad.css, hash restore.
- `index.html`: slim header (topbar root + cheatsheet), `#manuscript-chrome`
  strip above the outline; picker removed; renderer redirects to home when
  no manuscript_id, stamps /opened, and the info tooltip reads the
  manuscript name from the session instead of the picker.
- `login.html` → `home.html`. `scratchpad.html` → redirect stub
  (`?scratchpad_id=N` becomes `home.html#scratchpad=N`).

## Tests

Delete `test-manuscript-picker` (approved). New `test-home.js`: cards,
search→manuscript nav, search→modal, single-modal invariant, hash restore.
`test-scratchpad-canonize.js` reworked to the home+modal flow.
