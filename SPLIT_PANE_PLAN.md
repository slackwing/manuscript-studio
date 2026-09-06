# Split-pane view — plan

Status: implemented (2026-09-06)

Manuscript and scratchpad side by side: the shell (home.html) can split its
panel area down the middle into a LEFT and RIGHT pane, each with its own tab
bar. The editor-group model (VS Code): a split button at the right end of the
tab strip moves the focused tab into a new right pane; tabs drag between the
two bars; moving/closing the last right tab collapses the split.

## 1. Why this is cheap here

Every pin is already a kept-alive same-origin **iframe panel** (tabs.js).
An iframe is its own viewport, so ALL the existing mobile-mode machinery —
`@media (max-width: 1239px)` in book.css, `matchMedia`/`innerWidth` checks in
notes.js/suggestions.js/renderer.js — fires **per pane** for free when the
pane is narrower than the breakpoint. No container queries, no changes to the
framed pages. (Reality check: a 50/50 split on a 1920px screen puts BOTH
panes in mobile mode — desktop needs 1240px. That's why the divider is
draggable: 1240 + 640 fits on 1920.)

The one exception is **Home**: it's the shell page itself, not an iframe, so
its responsiveness stays viewport-based. Accepted — the card grid is
auto-fill and reflows by width anyway. Home therefore **lives in the left
pane only** and is not draggable.

## 2. Decisions (user-confirmed)

1. Two tab bars when split, one per pane.
2. Split moves the FOCUSED tab right; the left pane shows its next-most-
   recent tab. Split button is **disabled** unless there are ≥ 2 pins AND
   the focused tab is a pin (Home never splits; the left pane must fall
   back to a real tab, not Home).
3. No duplicate tabs — a document is one pin in exactly one pane.
4. Divider is draggable (min pane width 480px, double-click resets 50/50).
5. Layout survives reload.
6. Per-pane mobile mode (free — §1).
7. Focus indication kept light: the active tab of the UNFOCUSED pane
   dims slightly; no borders, no glows.
8. Whole-window narrowing does NOT auto-collapse the split — two narrow
   panes degrade gracefully into mobile mode.

## 3. State model

`ms_pinned_tabs` (localStorage) stays the single ordered source of what's
open — UNCHANGED shape. Global order = left-bar pins then right-bar pins.

New localStorage key **`ms_split`** — the shared layout:

```json
{ "right": ["s7877"], "dividerPct": 50 }
```

Split is active iff `right` is non-empty. `right` holds pin keys
(`m42`/`s7`); anything not listed is left-pane. Synced across browser tabs
via the existing `storage` listener; a `reconcile()` prunes keys whose pins
vanished (right emptying = split closes).

Per-BROWSER-TAB state (two browser tabs may focus different documents, so
this must NOT be shared): `leftActive` / `rightActive` / `focused` live in
memory + **sessionStorage** (`ms_split_session`) so a reload of the same
browser tab restores them. The URL hash `#tab=<key>` keeps meaning "the
focused pane's active tab" (link compat). An in-memory MRU list picks the
"next most recent" fallback when a pane's active tab leaves it.

## 4. Layout — panels never reparent

Reparenting an iframe RELOADS it. So panels all stay in the one
`#ms-tab-panels` host forever; pane assignment is pure CSS:

- JS sets `--split-x` (e.g. `50vw`) on the root and `.split` on the host.
- The visible left panel gets `width: var(--split-x)`; the visible right
  panel gets `left: var(--split-x)`. Moving a tab across = class flip.
- **Home showing in the left pane**: the host can't overlay the landing
  page, so when `leftActive == null` the host ALSO gets `.home-left`,
  shrinking it to the right region (`left: var(--split-x)`), and the right
  panel fills the host. The landing page underneath is constrained to the
  left region (`html.ms-split .home-main { margin-right: … }`).
- Divider: a fixed 7px-wide grab strip at `var(--split-x)` (1px visual
  line), created by tabs.js in the shell. Pointer-capture drag; while
  dragging, panels get `pointer-events: none` so the iframes don't swallow
  the pointer. Release persists `dividerPct`.

## 5. Tab strip

`#ms-tabs` gains `.split`: two `.ms-tabbar` children (left width
`var(--split-x)`, right flex). Unsplit renders one bar — same DOM depth, so
existing `#ms-tabs .ms-tab` selectors (and test-tabs.js) keep working. The
split button (`#ms-split-btn`, house icon set `splitPane`) sits at the far
right of the strip, shell-only, hidden when split, disabled per §2.2.

Drag & drop: native HTML5, the people.js pattern (live `insertBefore` on
midpoint-X during `dragover`). Pins are `draggable`; Home isn't. Both bars
accept drops (reorder within a bar; move across bars). On drop, the new
`ms_pinned_tabs` order and `right` set are read back FROM THE DOM. Dropping
the last right tab on the left bar empties `right` → split collapses.
In-bar reorder also works unsplit (falls out of the same code).

## 6. Focus

`focused: 'left'|'right'`. Set by: clicking a tab (that bar), pointerdown
inside a panel (same-origin `contentWindow.addEventListener` attached on
panel load), clicking the landing page (left). Externally-opened tabs
(cards, global search, `openManuscript`/`openPad`) land in the focused
pane. Visual: `.ms-tabbar.unfocused .ms-tab.active` softens color only —
no layout shift (bold stays).

## 7. Edge cases

- Close right-active tab → next right pin by MRU; last one → split closes.
- Close left-active tab → MRU left fallback → Home.
- Another browser tab unpins/moves tabs → `storage` event → reconcile.
- Standalone book page / settings: flat bar as today; no split UI (the
  shell owns panels; split state simply doesn't render there).
- Duplicate open: `pin()` already no-ops; `activate` focuses the existing
  tab in whichever pane it lives.
- Scratchpad modal: `activate` still closes a windowed pad first.

## 8. Tests (tests/test-split-pane.js)

Shell e2e in the test-tabs.js style: seed 1 manuscript + 2 API-created pads;
assert (a) split-button eligibility per §2.2, (b) split → two bars, two live
panels, no reload (sentinels), left shows next-most-recent, (c) per-pane
mobile mode: at 1600px viewport each ~800px iframe reports
`matchMedia('(max-width:1239px)').matches`, (d) drag across bars moves
without reload; dragging the last right tab left collapses the split,
(e) reload restores split + divider, (f) divider drag updates `--split-x`
and persists, (g) × on the last right tab collapses the split. Cleanup
wipes both localStorage keys. Classified in test-all.sh.
