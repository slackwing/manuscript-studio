# Suggestion review lifecycle rules

Status: **implemented 2026-08-28** (extends PERMISSIONS_PLAN §4 v3.x).
The problem these rules solve: an *unrelated* migration (a deploy, an
external commit) used to sweep suggestion state along carelessly — verdicts
could be half-finished, an "accepted" could silently stop describing
reality, and no-op pruning deleted rows the group still needed for context.

## Definitions

- **Group** — all `suggested_change` rows on one sentence, stale included.
- **Fully reviewed** — every row in the group carries a verdict
  (accepted/rejected). At most one acceptance per sentence (v3.2 409).
- **Applied** — the suggestion's text is already present in the committed
  document under `NormalizeText`: it matches its own sentence, or its
  sentence joined with up to 3 neighbors each side (a multi-sentence
  suggestion re-segments when applied).

## Rule 1 — pending sentences don't push

`push-suggestions` applies exactly the accepted set, and **only on fully
reviewed sentences**. A sentence with any unreviewed suggested edit is
still pending: none of its edits commit, whoever accepted what.

## Rule 2 — pending groups migrate whole

At any migration, a group with any unreviewed row carries forward intact —
statuses ride along, rows arrive stale when their sentence's text changed
(fuzzy pairing), **even rows whose text matches the new committed text**.
Matching rows render diff-less; the suggestion underline is the affordance
that a group lives there. (This retires the old no-op pruner: unreviewed
applied rows are no longer deleted. The re-minting loop that pruner broke
is prevented by Rule 1 instead.)

## Rule 3 — consummation retires the group

If a group is fully reviewed AND its accepted row is applied, the whole
group (acceptance and rejections alike) is deleted at that migration. The
verdicts live on in `suggestion_review_event` (the settings page's
"Suggested edits" history).

## Rule 4 — broken acceptances reset

If an accepted row arrives STALE (its sentence's text changed underneath
it) and it is NOT applied, the acceptance no longer describes reality: it
resets to unreviewed and the reset is logged to history as an
`unaccepted` event with reviewer `migration` (amber ✓̸ in the settings
table). Rejections are never reset — a rejection judges the edit, not the
committed text.

## Rule 5 — rejections need no extra rules

Rejected rows simply ride their group: hidden from the manuscript render,
reachable in the modal rail, carried by Rules 2, retired by Rule 3. An
all-rejected fully-reviewed group has no consummation event, so it carries
until its rows are edited (which resets them to pending) or deleted.

## Counters

- ✓✗ button: `reviewed sentences / sentences carrying suggestions`
  (sentence-level, matching Rule 1's gate).
- Push button variants count **pushable** acceptances only (fresh,
  accepted, fully-reviewed sentence).

## Where

- Settle pass: `SettleSuggestionsForMigration` (internal/database/
  suggestions.go), runs after the carry in every migration.
- Push gate: `HandlePushSuggestions` (api/handlers/suggestions.go).
- Counters: `reviewedSentences` / `acceptedCount` (web/js/suggestions.js).
