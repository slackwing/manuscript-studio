# `old/` — archived code

One-shot tools that were run once against production data and aren't expected
to be re-run. Kept around for archaeology and as templates for future
backfills.

## What's in here

- `old/cmd/backfill-prev-sentence/` — populated `sentence.previous_sentence_id`
  for migrations created before the column existed (changeset 005). Run
  during the deploy that landed that schema. Subsequent migrations populate
  the column natively, so this should never need to run again.
- `old/cmd/backfill-raw-text/` — populated `sentence.text` with raw markdown
  + structural markers (the UNIFIED_DATA_SHAPE refactor) for migrations
  created before that storage shape existed. Run during the deploy that
  landed the change. Same caveat as above.

## When to delete

Once the schema constraints they backfill for have been in place for long
enough that no untouched DBs still need them. As of this writing both have
been applied to every known DB; deletion is safe but the cost of keeping
them is near-zero.
