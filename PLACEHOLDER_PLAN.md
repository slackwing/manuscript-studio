# PLACEHOLDER_PLAN — the `&placeholder` command

**Status: implemented (2026-07-25).** This document is the design record for
the `&placeholder` command and the argument-vocabulary standardization that
came with it. Grammar/parser foundations live in TEX_COMMANDS_PLAN.md; this
plan builds on them.

## 1. Purpose

Reserve believable space for prose that hasn't been written yet, sized by a
guess about how long it will be. The reserved region renders as a hatched
silhouette — never any visible words — so the book paginates and reads at
true length while unwritten parts stay unmistakably unwritten.

## 2. Command

```
&placeholder#slug{unit}{size?}{label?}{details?}
```

- **unit** (required): `sentences` or `paragraphs`.
- **size** (optional, default `m`): t-shirt size. The two scales are
  deliberately asymmetric:

  | size | xs | s | m | l | xl | xxl | xxxl |
  |------|----|---|---|---|----|-----|------|
  | sentences  | 1 | 2 | 3 | 5 | 10 | 20 | 40 |
  | paragraphs | 1 | 2 | 3 | 5 | 8  | 13 | 21 |

  Each filler sentence is about the length of lorem ipsum's first sentence;
  each filler paragraph is 3–5 such sentences (seeded variation).
- **label** (optional): what shows in the outline.
- **details** (optional): overlaid on the placeholder region in a small sans
  chip — what the placeholder is supposed to become.

**Size detection is by value, not position**: an arg that exactly matches a
size keyword is the size; anything else is the label. A label that IS
literally a size keyword ("s") forces the default by writing the size
explicitly: `{sentences}{m}{s}`. Parsers: Go `ParsePlaceholder`
(internal/sentence/command.go), JS `placeholderSpec` (web/js/command.js) —
keep in lockstep.

**Mis-syntax prints as literal prose** — bad unit, too many args, or a
`paragraphs` form riding mid-line. No error state; the raw command text just
shows in the book, which is itself the signal to fix it.

## 3. Argument vocabulary standardization

Across all commands, brace args now use fixed names:

- **{text}** — renders in the book (a heading's visible text).
- **{label}** — shows in the outline.
- **{details}** — auxiliary metadata; a placeholder overlays it on the
  region, an anchor's is parsed but unrendered (reserved).

Under the old vocabulary, part/chapter args were called {label}{description}.
The rename is doc-level only — args are positional, so no stored manuscript
changes: `&part{text}{label}`, `&chapter{text}{label}`,
`&anchor{label}{details?}`, `&placeholder{unit}{size?}{label}{details?}`.

## 4. Segmentation (segman v2.2.0)

- `placeholder` joined the command keywords. Block **iff sole non-whitespace
  content of its line** — the same rule as `&anchor`. A `sentences`-unit
  placeholder normally rides inline at the end of a paragraph; a
  `paragraphs`-unit placeholder must be alone on its line.
- **RULE 10 (new)**: a recognized command token is atomic — no sentence
  boundary may land strictly inside it. Without this, sentence punctuation
  inside `{details}` ("They finally meet. Keep it wordless.") split the token
  across two sentence rows and both halves degraded to prose. Also fixes the
  same latent bug for `&reference` notes.
- Vendored here via `scripts/vendor-segman.sh --ref=v2.2.0`; scenarios
  079–081 in the segman repo cover both rules.

## 5. Outline

A placeholder is a **subtype of anchor** in the outline: it attaches to the
most recent chapter/part exactly like an anchor and renders indistinguishably
(its {label} where an anchor shows its {label}; `#slug` fallback). Inline
(mid-line) placeholders don't appear — the outline is structural, same rule
as inline anchors. Mis-syntaxed placeholders stay out. Placeholder slugs
enter the slug index like any block command's, so `&reference` can
forward-reference a scene that doesn't exist yet.

## 6. Rendering (web/js/placeholder.js + book.css `.ph`)

Invisible lorem filler (`color: transparent`, `user-select: none`,
`aria-hidden`) justifies and wraps exactly like prose, painted with a
diagonal hatch that merges into one mid-line-to-mid-line silhouette. The
filler is seeded by slug (else label, else signature) so a given placeholder
renders identically across sessions, but siblings don't look like copies.

The hatch is phase-aligned **by construction** — every number is a multiple
of the 6.4px SVG tile:

| quantity | value | tiles |
|----------|-------|-------|
| tile | 6.4px | 1 |
| line-height | 12pt × 1.6 = 25.6px | 4 |
| paragraph indent | 2em = 32px | 5 |

plus two runtime passes (`WriteSysPlaceholder.layoutPass()`, hooked where the
rainbow side-bars re-measure — pagedjs-config afterRendered and renderer
re-renders):

1. **Row bridge** (`tunePad`): vertical padding = (line-height − measured
   content-box height)/2, measured from the *rendered* font (Linux
   substitutes Georgia; `&meta{font}` can change it), set as `--ph-pad`.
   With `box-decoration-break: clone`, rows butt-joint on an exact shared
   edge — no overlap, no gaps, no double-paint.
2. **Phase nudge** (`nudge`): an inline placeholder's first fragment starts
   mid-line at arbitrary x; a ≤3.2px spacer margin shifts its start onto a
   tile boundary, invisible inside justified word-spacing. Iterates because
   the nudge itself reflows justification.

**Constraint**: don't change book font-size/line-height/indent off tile
multiples, or hatch rows will visibly jog (comment sits on `.ph` in
book.css).

**Details chip**: inline form suppresses it until hover (anchored above the
region's first fragment); block form overlays it persistently, centered.
Head line is `#slug — label`, body is details, Helvetica 10px.

**Known trade-offs (accepted)**: a block placeholder split across pages puts
its overlay chip on the fragment that contains it (DOM order: last); print
styles may drop the hatch background (browser "print backgrounds" setting);
a stroked-outline variant (true border around the silhouette) needs a
measured-SVG geometry pass — deferred until wanted.

## 7. History

Rendering was prototyped CSS-only on a mock book page (2026-07-25 artifact
"placeholder-hatch-demo"): background-attachment:fixed was rejected (breaks
under transformed ancestors — the artifact viewer, likely paged.js too),
CSS-gradient hatches rejected for uneven antialiasing (fractional period),
and the tile/clone/measured-pad/nudge recipe above survived visual review.
