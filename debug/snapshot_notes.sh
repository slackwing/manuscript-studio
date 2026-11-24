#!/usr/bin/env bash
# Snapshot the note tables (and the pad docs their placements come from) to
# CSV before a schema change — NOTE_PLACEMENTS_PLAN.md runs this before every
# deploy of that plan. Runs ON THE VM next to connect_db.sh:
#
#   bash debug/snapshot_notes.sh              # → ~/backups/notes-<UTC stamp>/
#
# or from a laptop, over the read-only psql recipe:
#
#   ssh … 'bash /var/www/manuscript-studio/manuscript-studio-src/debug/snapshot_notes.sh'
#
# Small data (hundreds of notes, a few thousand version rows); seconds.
# Restore is manual (psql \copy FROM) — this is a safety net, not a backup
# system. Prints the row count per table so the run can be checked at a glance.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# Run from a copy outside the checkout (scp'd to ~ before a deploy that
# hasn't pulled this file yet): fall back to the VM's installed source tree.
if [ ! -f "$HERE/connect_db.sh" ]; then
    HERE="/var/www/manuscript-studio/manuscript-studio-src/debug"
fi
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="${1:-$HOME/backups/notes-$STAMP}"
mkdir -p "$OUT"
chmod 700 "$OUT"

TABLES=(note note_version note_tag note_hide point_event note_sentence note_scratchpad scratchpad)

for t in "${TABLES[@]}"; do
    # A table that doesn't exist yet (pre-054) is skipped, not an error.
    exists=$(bash "$HERE/connect_db.sh" -Atq -c "SELECT to_regclass('public.$t') IS NOT NULL" 2>/dev/null || echo f)
    if [ "$exists" != "t" ]; then
        echo "  $t: (no such table, skipped)"
        continue
    fi
    bash "$HERE/connect_db.sh" -q -c "\\copy (SELECT * FROM $t) TO '$OUT/$t.csv' WITH (FORMAT csv, HEADER)"
    n=$(bash "$HERE/connect_db.sh" -Atq -c "SELECT count(*) FROM $t")
    echo "  $t: $n rows → $OUT/$t.csv"
done
echo "snapshot: $OUT"
