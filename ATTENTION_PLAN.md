# ATTENTION_PLAN — the reader-attention envelope

Status: **shipped 2026-09-09** (same-day: plan → implementation → prod). Calibration ongoing by feel.

A completely novel feature with no common pattern to lean on — this doc is
the pattern. Read it before touching `web/js/attention.js` (future home of
the implementation), and keep its math section in lockstep with the code's
constants block.

## 1. Motivation

The author seeds the manuscript with markers (`&marker#picture`,
`&mark#twist`, …) at moments intended to *earn* reader attention (vivid
imagery, tension) or *spend* it (asides, digressions, difficulty). Each
marker slug carries a signed integer **attention value** (settings →
Markers). The feature answers: *how well am I keeping the reader's
attention over the course of a page?* — by plotting an attention-energy
curve directly on the page, behind the text, aligned with the very lines
where the markers sit.

## 2. The model (attention as energy)

- Reading progression is **time `t`, measured in WORDS** — not pixels, not
  lines. Attention decays with reading effort; headings and blank space
  cost nothing. (Resolved assumption: words beat lines because line width
  varies; beat pixels because pagination is presentation, not effort.)
- Each marker `i` at word-position `tᵢ` with value `vᵢ` contributes an
  **impulse kernel**, and the envelope is their superposition:

      a(t) = Σᵢ vᵢ · K(t − tᵢ)

      K(u) = 0                                      for u < 0
      K(u) = N · (1 − e^(−(u/ATTACK)³)) · e^(−u/DECAY)  for u ≥ 0

  where `N` normalizes the kernel peak to exactly 1 (numerically — no
  closed form), so a lone `#twist` (+15) *peaks* at 15. The
  cubic-exponential onset is C² at the marker — zero first and second
  derivative, true acceleration — replacing the original
  double-exponential whose rise had a kink at u=0 (2026-09-09 evening:
  "multiple levels of derivatives smooth"). `ATTACK` is the onset scale
  (peak ≈ 1.8×ATTACK words out), `DECAY` the exponential fade. Superposition gives
  the requested behavior for free: a second `#picture` adds +5 on top of
  whatever the first has decayed to.
- Negative values use the same kernel with negative amplitude — a
  `#digression` (−15) is a smooth dip that recovers.
- **Jading (habituation, 2026-09-09 evening):** a spike right after a
  spike lands weaker — divisive normalization over leaky per-sign pools
  (the textbook habituation model; hedonic adaptation). Before
  superposition, each marker's amplitude becomes
  `v̂ = v / (1 + J/JADE_SCALE)` where jadedness `J` decays
  `e^(−Δt/JADE_RECOVERY_WORDS)` between markers and grows by `|v̂|` after
  each. Positive and negative markers habituate INDEPENDENTLY (author
  decision); pools are global across slugs for now (stimulus-specific
  habituation is a someday). The maintained formula lives in the block
  comment atop `web/js/attention.js` — keep both in lockstep.
- Energy is **continuous across page breaks** (a page turn costs no words;
  revisit if that feels wrong).

### Tuning constants (the author calibrates by feel)

One constants block, one place, fat comment — `web/js/attention.js`:

    ATTENTION_ATTACK_WORDS = 7     // C² onset scale; peak ~13 words (~one line) out
    ATTENTION_DECAY_WORDS  = 120   // contribution falls to 1/e after this (calibrated down from 250)
    ATTENTION_FULL_SCALE   = 10    // a=+10 lands on the sheet's right edge (back from 25 post-jading)
    JADE_SCALE             = 10    // this much recent J halves the next spike
    JADE_RECOVERY_WORDS    = 300   // novelty regrowth time-constant

Also mirrored live on `window.WriteSysAttention.TUNING` so values can be
tweaked in the console mid-read (hold Tab, judge, tweak, re-hold) before
editing the source. Persisted settings knobs come later, if ever.

## 3. Data & API

- `marker_symbol` (045) gains `attention INTEGER NOT NULL DEFAULT 0`
  (changeset 047). A slug's row = `{symbol, attention}`.
- **Default-symbol change (resolved assumption, 2026-09-09):** the ※
  reference mark becomes the ONE default everywhere — an unconfigured
  marker slug renders ※ (exactly like a generic command), and a newly
  added settings row starts as ※ + attention 0 until edited. The diamond
  is demoted to an ordinary pickable shape. Storage: `symbol` value
  `'default'` = "render ※"; new rows insert `'default'`.
- API: `GET /api/marker-symbols` returns
  `{"markers": {slug: {"symbol": "...", "attention": n}}, "display": bool}`
  (the old flat `symbols` map is replaced — same-deploy frontend is the
  only consumer). `PUT /api/marker-symbols/{slug}` accepts partial
  `{"symbol"?, "attention"?}`; attention validated to a sane integer range
  (−99..99).
- Settings → Markers row grows a small integer input after the shape
  picker (default 0, negatives allowed). Terse UI: no caption; the number
  IS the affordance.

## 4. Pipeline (pre-generation, Paged.js-coupled)

Runs AFTER pagination settles (the same completion signal
`waitForPagination`/the Paged after-render hook the renderer already
uses), and re-runs on any re-render. Never during — the plot is a pure
function of the final page geometry.

1. **Harvest geometry.** Walk `.pagedjs_page`s in order. For each sentence
   fragment, `getClientRects()` → line boxes. Build the ordered line map:
   `(page, lineRect, wordCount)` — words per line apportioned from the
   sentence's known text across its line rects by rect width (approximate,
   fine at this granularity).
2. **Harvest markers.** Marker spans exist in the DOM even when their
   glyphs are hidden (`.cmd-diamond-marker` or the invisible `.inline-cmd`
   with `data-kind="marker"|"mark"` — visibility gating never removes the
   span), each with `data-slug`. Marker `tᵢ` = cumulative words at its
   line, interpolated by its x-offset within the line.
   **Suggested edits** (2026-09-10): the envelope follows the EFFECTIVE
   text — the rendered suggestion per sentence (accepted, else the
   People-order winner; the top person in the People tab). A suggested
   marker rides in the diff as `.cmd-diamond-added` / `-removed` (or an
   invisible `.inline-cmd` for eyes without manage-suggestions) wearing
   the same `data-kind`/`data-slug` plus `data-diff`; the harvest selects
   on `data-kind` alone and skips `data-diff="removed"` — the struck
   marker is on the page but is not read.
3. **Sample.** Per page, for y from first-line-top to last-line-bottom in
   ~3px steps: invert y→t through a MONOTONE CUBIC (Fritsch–Carlson)
   through the line centers — C¹, never time-reversing. (The first
   piecewise-linear map froze t in the leading between lines, printing a
   flat shelf at every line gap; smoothness deliberately outranks strict
   "gaps cost nothing" — 2026-09-09 evening.) Then compute `a(t)` (kernel
   cutoff at 6×DECAY keeps it O(markers-in-window)).
4. **Emit SVG.** Per page, one absolutely-positioned SVG with rotated
   axes — t downward, attention rightward. `a=0` at the SHEET's left
   edge; `ATTENTION_FULL_SCALE` (+10; briefly 25 pre-jading) at the sheet's right edge; negative
   attention spills OFF the sheet into the gray backdrop gutter left of
   the page (author-confirmed 2026-09-09: "the left margin of the
   website", not the sheet's inner margin) — the SVG canvas extends one
   sheet-width left and right of the sheet (negative-x viewBox) to hold
   the spill. Two area fills between the curve and the a=0 axis:
   `max(a,0)` light green, `min(a,0)` light red, both translucent, plus a
   thin stroke of the curve itself. Clipped vertically to
   [first-line-top, last-line-bottom].
5. **Cache.** SVGs stay in the DOM, hidden; regeneration replaces them.

## 5. Rendering & interaction

- **Hold Tab to peek.** `keydown`/`keyup` on the book document only (each
  book tab is its own iframe, so "manuscript is focused" is free —
  keystrokes land in the focused pane's document). Ignored when the event
  target is an input/textarea/contenteditable or a modal is open.
  `preventDefault` stops focus-cycling. Release hides.
- **Behind the text.** `.pagedjs_page` gets `position:relative; z-index:0`
  (its own stacking context); the overlay SVG child sits at `z-index:-1` —
  above the sheet's white background, below all in-flow text. This is the
  documented CSS mechanism; do not "simplify" it to a positive z-index
  overlay with opacity, which would wash the prose.
- Toggle = a `html.attention-held` class; SVGs are `display:none` without it.
- **Stats-pane button = a TOGGLE** (2026-09-11; was press-and-hold): a
  click pins the envelope on — Tab keyup and window blur leave a pinned
  envelope alone, and a re-render restores it (`_rebuild` re-adds the
  class when `pinned`); a second click releases. Gate denial or an empty
  harvest drops the pin. `aria-pressed` on the button paints the on-state.

## 5b. Visibility (see-attention + the alpha-reader role)

- New action **`see-attention`** gates the whole feature: the Tab-hold
  listener and the overlay generation only arm when the session's actions
  for the manuscript include it (same `WriteSysActions.has` gate as
  see-markers; server-side the action rides roles.json as ever).
- Granted to **author, editor**, and a NEW role **`alpha-reader`** —
  copied from beta-reader (see-manuscript, see-outline, see-others-notes,
  see-others-edits) **plus `see-attention`**: the trusted early reader who
  helps calibrate the attention envelope without editing powers.
  Seniority slot: between editor and beta-reader.
- The People pane, invites, and role management pick the new role up from
  roles.json automatically (it is the single source of truth); admins can
  grant it via the existing manage-role plumbing — add
  `manage-role-alpha-reader` to admin's and author's bundles.

## 6. Author's initial calibration (configure at ship time, user andrew)

    #picture +5   #sconce +5   #vivid +10   #beacon +10   #pressure +8
    #twist  +15   #weird −5    #hard −5     #aside −8     #digression −15

(Normal users add their own; unconfigured = 0. Existing shape mappings —
#weird/#digression → triangle-down — keep their shapes, gain values.)

## 7. Testing plan

- Go: attention column CRUD; partial PUT semantics.
- Kernel math: pure-function unit tests (node, no browser) — peak equals
  v, superposition adds, negative dips, cutoff correctness.
- Playwright: paginate a fixture with known markers → overlay SVG exists
  per page, hidden by default; holding Tab reveals; path's fill polygons
  sign-split; first/last-line clipping; marker y-alignment within
  tolerance; z-order (text still selectable/on top).
- Settings: attention input persists, negatives allowed, defaults 0.

## 8. Phases

1. Schema + API + settings input (+ default-symbol change to ※).
2. attention.js: kernel + line map + SVG emit + Tab interaction.
3. Ship, configure §6 on prod, then calibrate DECAY/ATTACK by feel —
   author reports reading impressions, constants move, repeat.

## 9. Open questions (non-blocking, defaulted)

- Page-turn cost: currently 0 words. Could add a PAGE_TURN_WORDS constant.
- Sentence-final vs mid-sentence marker t: interpolated by x-offset now;
  could snap to sentence start if the interpolation feels jittery.
- Multi-column/mobile-scaled pages: v1 targets the desktop book layout;
  the scaled mobile sheet inherits the SVG (it scales with the page), but
  Tab-hold on mobile has no keyboard — future gesture, out of scope.
  (Resolved 2026-09-11: the stats-pane toggle button.)
