# Word-count rules (the cron and every live counter)

Spec'd 2026-09-05 (Slackwing). `internal/database/wordcount.go` points
here; change THIS file and the code together or not at all.

## The rules

1. **Per manuscript, plus its linked sketches.** A manuscript's count is
   the effective manuscript (rule 4) plus a contribution from every
   sketch GROUP linked to it (rule 2).
2. **A sketch group contributes its LONGEST eligible variation** — not
   the most recent. Placed ("canonized") variations are candidates like
   any other: if the group grew a longer variant after placement, the
   longer one is the contribution.
3. **Ineligible variation states: superseded, frozen, and accepted.**
   None of them count. A group whose variations are all ineligible
   contributes 0 (its words re-enter through the manuscript once
   accepting removed the sketch commands — rule 8).
4. **The manuscript side counts the EFFECTIVE text** — committed
   overlaid with the render-winner suggestion per sentence (accepted
   wins, else first non-rejected by People order; rejected and stale
   rows never substitute). Deletions subtract; pure additions add.
5. **Sketch-referenced zones delegate.** Text between `&sketch#slug{…}`
   and its paired `&end#slug` does NOT count in the manuscript — the
   group's rule-2 contribution stands in for that zone. This holds
   whether the sketch was generated FROM the manuscript or PLACED into
   it: the reference is the delegation, full stop.
6. **An unpaired sketch reference is INVALID.** Every `&sketch#slug`
   must find `&end#slug` (same slug) later in the document; the end
   command's slug is what makes pairing checkable. An unpaired ref does
   not delegate anything — its zone has no boundary — and should be
   surfaced as invalid, never silently absorbed.
7. **Accepting a sketch** (the placed-icon menu, with a confirm dialog)
   marks the placed variation `accepted` (greenish), and removes the
   `&sketch`/`&end` commands from the manuscript — the zone's words
   return to the manuscript side; the group, now all-ineligible,
   contributes 0. No double counting in either direction, ever.

## UI corollaries

- The margin affordance for a sketch-referenced zone is the PLACED icon
  (one icon regardless of which direction the sketch came from), and
  clicking it opens a menu: **Open sketch** (the pad, as a pinned tab),
  **Select sketch** (selects the zone through `&end`, like
  shift-selecting sentences), **Accept sketch** (confirm dialog first).

## History

- Pre-2026-09-05 behavior (superseded): representative = most recently
  updated non-superseded variation; frozen counted; canonized groups
  excluded wholesale; sketch zones counted double (manuscript AND, for
  unplaced groups, the sketch side); effective used "latest suggestion
  by updated_at" with no verdict/stale filtering.
