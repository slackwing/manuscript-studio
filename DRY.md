# DRY audit — remaining duplication and consolidation targets

Why duplication crept in: most features here were built margin-first or
widget-first and then RE-built on the next surface (margin → float → landing
card → pad → modal), each time copying the previous surface's code instead of
extracting it, because "it's just a chip / just a save call." The unifications
so far (shared note component, edit-pane, manuscript-chip, scroll hold) each
started as a user-visible inconsistency. This file lists what's left, ranked.

## Done (for reference — the pattern to follow)
- `js/chrome.js` — ONE top bar (#controls) for home/settings/reader. The
  three hand-copies had drifted (the reader lost the settings gear); pages
  keep an empty shell div and a `data-extras` slot names page-specific
  right-side controls (reader's cheatsheet toggle).
- `notes/note-widget.js` — ONE note component (margin/float/landing card).
- `js/edit-pane.js` — ONE monospace editor + autosaver (snippet sketches,
  suggest-edit modal): debounce, retry ladder, dirty/flush, tab overlay.
- `js/manuscript-chip.js` — ONE linked-manuscript chip + ONE picker + one
  manuscript-list cache (snippet widgets, pad title bar, note cards).
- `holdScroll` — ONE scroll-preservation mechanism per scroll host.
- Backend: `manuscriptDisplayName`, `fillNoteManuscriptNames` shared.

## High value / low risk
1. **escapeHtml ×9.** `replace(/&/g …)` exists in text-markers, placeholder,
   global-search, edit-pane, home.js, import-scratchpad, renderer,
   scratch-render, editor-core. One `WriteSysUtil.escHTML` ends the drift risk
   (two of the nine already differ on whether they escape quotes).
2. **CSRF + API-call helper ×8.** `sessionStorage.getItem('csrf_token')` and
   hand-rolled `fetch(…, X-CSRF-Token)` appear in auth.js, session-guard,
   note-api, home.js, import-scratchpad, renderer, modal.mjs, editor-core.
   auth.js's `fetchJSON/authenticatedFetch` is the intended shared helper —
   half the app bypasses it. Everything should route through it (or a thin
   `apiCall(method, url, body)` built on it) so error shape (.status), CSRF
   and 401-guard behavior stay uniform.
   (✓ partial 2026-08-17: the pad subsystem's four CSRF getters — editor-core,
   modal.mjs ×2, import-scratchpad — route through auth.js `getCSRFToken()`,
   and `variationApi` is single-wrapper on `apiCall`.)
3. **The doc-save retry ladder in `createScratchpadEditor`.** ✓ DONE
   (2026-08-17, Area-1 fix branch): the doc autosave is a `createAutosaver`
   instance (`setStatus` override maps the pane's ''/'saving…' onto the
   pad's Saved/Saving…/Unsaved vocabulary); the hand-rolled
   saveNow/scheduleRetry/countdown machine and `appendReloginLink` are
   deleted — the shared saver's own 401 link serves the doc too. This also
   fixed the in-flight-typing data-loss bug (the shared chase).

## Medium value
4. **Search-and-pick popover pattern ×3.** The manuscript picker
   (manuscript-chip), the Snippet ▾ "Related to…"/"Restore…" pickers
   (editor-core), and global-search all hand-roll "input + debounced filter +
   button list + outside-click close + Enter/Escape". A `buildPickerPop()`
   would leave each with only its data source and row renderer.
   (✓ partial 2026-08-17: the two editor-core pickers share one
   `buildPickerPop` — with Escape scoped to the popover; manuscript-chip and
   global-search still hand-rolled.)
5. **Modal shells ×4.** spm-overlay (pad), #suggestion-modal, session-guard,
   note float: each re-implements overlay + Escape + outside-click +
   close-guard wiring. The guard semantics are subtly different on purpose
   (pad refuses to close unsaved; suggest-edit flushes; guard modal is
   dismissible) — a shared shell should take a `beforeClose` hook rather than
   flags.
6. **Leather/gilt styling ×3.** The bookbinding gradient + gold edge exists in
   manuscript-chip.js (injected), scratchpad.css (.sn-rail-canon + canon
   widget theme), and login.html. Extract CSS variables
   (`--leather-gradient`, `--gilt-border`, `--gilt-text`) into a shared
   sheet so "canon brown" is one decision.
7. **Debounce.** ~6 hand-rolled `clearTimeout/setTimeout` debounces (search
   inputs, title save, glyph conversion). Trivial `debounce(fn, ms)` util.

## Low value / structural notes
8. **Three API wrappers by domain** (note-api.js, sketchApi in editor-core,
   raw fetches in home.js/import-scratchpad). After #2 they become thin
   domain layers over one transport — fine to keep as domain files then.
9. **Letter/status formatting** (`letterOf`, state names, fmtDeleted's date
   format) — small, but should live beside the shared components they serve.
10. **Backend handlers** are in decent shape post-020/021/022 (shared
    display-name resolution, shared fill helpers, single state enum). The
    freeze-all + canonize flows both walk a snippet's sketches — acceptable.

## Working rule going forward
When a feature reaches its SECOND surface, extract the component then — not
on the third. The extraction is always cheapest at two call sites, and every
one of the divergences above (blue vs leather chip, two pickers, three save
ladders) started at exactly that moment.

## Icons (resolved 2026-08-03)

`web/js/icons.js` (`window.WriteSysIcons`) is the ONE source for house SVG
icons — `trash(size)`, `trashStroke(size)`, `link(size)`. It loads as a plain
script before every consumer; scratchpad modules read it off `window` (same
document). Previously the trash can was pasted in three places (home.js,
editor-core.mjs ×2 variants) and the link glyph in two — and a fourth trash
(an emoji, then a novel SVG) almost shipped in range-delete. Add new icons to
icons.js; never inline an icon at a call site, never use emoji glyphs for UI
(platform emoji fonts render clipped/off-center).
