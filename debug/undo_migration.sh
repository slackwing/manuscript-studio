#!/usr/bin/env bash
# Manuscript Studio — interactively wipe migrations newer than a chosen one.
#
# Use case: a migration ran with broken code and produced wrong/empty
# annotation state. You want to roll the manuscript back to an earlier
# migration so a fresh /admin/sync starts from clean slate.
#
# Walks you through:
#   1. Pick the manuscript (from those that have any migrations)
#   2. Show the last 10 migrations with status / commit / counts / time
#   3. Pick the migration to KEEP (everything newer is wiped)
#   4. Show what will be deleted, require typing the manuscript name to confirm
#   5. Roll back: roll annotation pointers to the kept version, delete
#      newer annotation_version rows, delete newer sentences, delete the
#      newer migration rows. All in one transaction.
#
# This cannot be undone.

set -euo pipefail

CONFIG_FILE="${MANUSCRIPT_STUDIO_CONFIG_FILE:-$HOME/.config/manuscript-studio/config.yaml}"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Config not found at $CONFIG_FILE" >&2
    echo "Set MANUSCRIPT_STUDIO_CONFIG_FILE to override." >&2
    exit 1
fi

get_config() {
    grep "^[[:space:]]*$1:" "$CONFIG_FILE" | head -1 | sed "s/.*$1:[[:space:]]*[\"']*\([^\"']*\)[\"']*/\1/"
}

DB_HOST=$(get_config "host")
DB_PORT=$(get_config "port")
DB_NAME=$(get_config "name")
DB_USER=$(get_config "user")
DB_PASSWORD=$(get_config "password")

# Run a SQL query, return tab-separated rows. Strips the command tag
# ("INSERT 0 1" etc.) that psql prints for write statements, in case the
# caller embeds RETURNING in a query.
psql_q() {
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
        -At -F $'\t' -v ON_ERROR_STOP=1 -c "$1" \
        | grep -Ev '^(INSERT|UPDATE|DELETE|SELECT|COPY) [0-9]'
}

echo "=========================================="
echo "  Manuscript Studio — undo_migration.sh"
echo "  DB: $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
echo "=========================================="
echo ""

# ---------- Step 1: Pick a manuscript ----------

manuscripts=$(psql_q "
    SELECT m.manuscript_id, m.repo_path, m.file_path, COUNT(mig.migration_id)
    FROM manuscript m
    LEFT JOIN migration mig ON mig.manuscript_id = m.manuscript_id
    GROUP BY m.manuscript_id, m.repo_path, m.file_path
    HAVING COUNT(mig.migration_id) > 0
    ORDER BY m.manuscript_id
")

if [[ -z "$manuscripts" ]]; then
    echo "No manuscripts with migrations found. Nothing to do."
    exit 0
fi

echo "Manuscripts:"
i=0
declare -a m_ids m_repos m_files
while IFS=$'\t' read -r mid repo file count; do
    i=$((i+1))
    m_ids[$i]=$mid
    m_repos[$i]=$repo
    m_files[$i]=$file
    printf "  %d) [id=%s] %s :: %s  (%s migration%s)\n" "$i" "$mid" "$repo" "$file" "$count" "$([ "$count" = "1" ] || echo s)"
done <<< "$manuscripts"

echo ""
read -rp "Pick manuscript [1-$i]: " pick
if ! [[ "$pick" =~ ^[0-9]+$ ]] || (( pick < 1 || pick > i )); then
    echo "Invalid pick." >&2
    exit 1
fi

manuscript_id=${m_ids[$pick]}
manuscript_label="${m_repos[$pick]}::${m_files[$pick]}"
echo "Selected: $manuscript_label (id=$manuscript_id)"
echo ""

# ---------- Step 2: Show last 10 migrations ----------

migrations=$(psql_q "
    SELECT migration_id, status, commit_hash,
           COALESCE(branch_name, ''),
           COALESCE(sentence_count::text, ''),
           COALESCE(annotations_per_migration.cnt::text, '0'),
           started_at, finished_at,
           COALESCE(LEFT(error, 80), '')
    FROM migration
    LEFT JOIN (
        SELECT s.migration_id, COUNT(av.*) AS cnt
        FROM sentence s
        JOIN annotation_version av ON av.sentence_id = s.sentence_id
        GROUP BY s.migration_id
    ) AS annotations_per_migration USING (migration_id)
    WHERE manuscript_id = $manuscript_id
    ORDER BY migration_id DESC
    LIMIT 10
")

if [[ -z "$migrations" ]]; then
    echo "Manuscript has no migrations? Bailing." >&2
    exit 1
fi

echo "Last 10 migrations (newest first):"
printf "  %-6s  %-8s  %-12s  %-12s  %-9s  %-12s  %s\n" \
    "ID" "STATUS" "COMMIT" "BRANCH" "SENTENCES" "ANN_VERSIONS" "FINISHED"
echo "  ----  --------  ------------  ------------  ---------  ------------  --------------------"
declare -a mig_ids
while IFS=$'\t' read -r mid status commit branch sentcount anncount started finished err; do
    mig_ids+=("$mid")
    short_commit=${commit:0:10}
    short_finished=${finished:0:19}
    [[ -z "$short_finished" ]] && short_finished="(unfinished)"
    printf "  %-6s  %-8s  %-12s  %-12s  %-9s  %-12s  %s\n" \
        "$mid" "$status" "$short_commit" "${branch:0:12}" "$sentcount" "$anncount" "$short_finished"
    if [[ -n "$err" ]]; then
        printf "          error: %s\n" "$err"
    fi
done <<< "$migrations"
echo ""

# ---------- Step 3: Pick the migration to KEEP ----------

read -rp "Roll back to (and INCLUDING) which migration ID? Everything newer will be wiped: " keep_id
if ! [[ "$keep_id" =~ ^[0-9]+$ ]]; then
    echo "Invalid id." >&2
    exit 1
fi

# Verify keep_id belongs to this manuscript and is at status='done' (else
# the rollback target itself is broken and we shouldn't be rolling to it).
keep_status=$(psql_q "SELECT status FROM migration WHERE migration_id = $keep_id AND manuscript_id = $manuscript_id")
if [[ -z "$keep_status" ]]; then
    echo "Migration $keep_id does not belong to manuscript $manuscript_id." >&2
    exit 1
fi
if [[ "$keep_status" != "done" ]]; then
    echo "Migration $keep_id has status '$keep_status' — it's not a clean rollback target." >&2
    read -rp "Continue anyway? [y/N]: " yn
    [[ "$yn" =~ ^[yY] ]] || exit 1
fi

# What gets wiped: every migration with id > keep_id for this manuscript.
to_wipe=$(psql_q "
    SELECT migration_id, status, commit_hash
    FROM migration
    WHERE manuscript_id = $manuscript_id AND migration_id > $keep_id
    ORDER BY migration_id
")

if [[ -z "$to_wipe" ]]; then
    echo "No migrations newer than $keep_id. Nothing to wipe."
    exit 0
fi

# ---------- Step 4: Confirm ----------

echo ""
echo "About to WIPE the following migrations (and all their sentence/annotation_version rows):"
while IFS=$'\t' read -r mid status commit; do
    echo "  - migration $mid (status=$status, commit=${commit:0:10})"
done <<< "$to_wipe"

# Count what's actually being touched.
wipe_ids_csv=$(echo "$to_wipe" | cut -f1 | paste -sd,)
sent_count=$(psql_q "SELECT COUNT(*) FROM sentence WHERE migration_id IN ($wipe_ids_csv)")
av_count=$(psql_q "
    SELECT COUNT(*) FROM annotation_version
    WHERE origin_migration_id IN ($wipe_ids_csv)
       OR sentence_id IN (SELECT sentence_id FROM sentence WHERE migration_id IN ($wipe_ids_csv))
")
ann_to_repoint=$(psql_q "
    SELECT COUNT(DISTINCT a.annotation_id)
    FROM annotation a
    WHERE a.sentence_id IN (SELECT sentence_id FROM sentence WHERE migration_id IN ($wipe_ids_csv))
")

# Annotations whose ONLY version rows live in the wiped migrations have no
# pre-wipe sentence to roll back to. They were created by the user while
# viewing a migration that's about to disappear. We have to soft-delete
# them (or keep them but soft-delete is honest — the sentence they were
# attached to no longer exists in any kept migration).
orphan_anns=$(psql_q "
    SELECT a.annotation_id
    FROM annotation a
    WHERE a.deleted_at IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM annotation_version av
          WHERE av.annotation_id = a.annotation_id
            AND (av.origin_migration_id IS NULL OR av.origin_migration_id NOT IN ($wipe_ids_csv))
      )
")
orphan_ann_csv=""
orphan_ann_count=0
if [[ -n "$orphan_anns" ]]; then
    orphan_ann_csv=$(echo "$orphan_anns" | paste -sd,)
    orphan_ann_count=$(echo "$orphan_anns" | wc -l)
fi

echo ""
echo "Impact:"
echo "  - $sent_count sentence row(s) deleted"
echo "  - $av_count annotation_version row(s) deleted"
echo "  - $ann_to_repoint annotation row(s) repointed to their kept version"
if (( orphan_ann_count > 0 )); then
    echo "  - $orphan_ann_count annotation(s) will be SOFT-DELETED — they were created"
    echo "    in a wiped migration with no surviving version to roll back to:"
    echo "    annotation_id IN ($orphan_ann_csv)"
fi
echo ""
echo "  This CANNOT be undone."
echo ""

# Confirm by typing the manuscript repo_path basename — easy to copy/paste,
# hard to type by accident.
expected_token=$(basename "${m_repos[$pick]}")
read -rp "Type '$expected_token' to confirm: " typed
if [[ "$typed" != "$expected_token" ]]; then
    echo "Mismatch. Aborting."
    exit 1
fi

# ---------- Step 5: Execute (one transaction) ----------

echo ""
echo "Wiping..."

# Build the statement. Order matters because of FK RESTRICT on
# annotation_version.sentence_id and annotation.sentence_id.
soft_delete_orphans=""
if (( orphan_ann_count > 0 )); then
    soft_delete_orphans="UPDATE annotation SET deleted_at = NOW() WHERE annotation_id IN ($orphan_ann_csv);"
fi

sql=$(cat <<EOF
BEGIN;

-- Step 1: roll annotation.sentence_id pointers back to the latest surviving version.
-- For each annotation that was ever moved by a wiped migration, find its
-- highest-version annotation_version row that wasn't created by a wiped
-- migration, and copy that row's sentence_id back onto the annotation.
UPDATE annotation a
SET sentence_id = av.sentence_id, updated_at = NOW()
FROM annotation_version av
WHERE av.annotation_id = a.annotation_id
  AND av.version = (
      SELECT MAX(version) FROM annotation_version av2
      WHERE av2.annotation_id = a.annotation_id
        AND (av2.origin_migration_id IS NULL OR av2.origin_migration_id NOT IN ($wipe_ids_csv))
  )
  AND a.annotation_id IN (
      SELECT DISTINCT annotation_id FROM annotation_version
      WHERE origin_migration_id IN ($wipe_ids_csv)
  );

-- Step 2: soft-delete annotations that have no surviving version row.
-- These were created by the user while viewing a wiped migration — there's
-- no pre-wipe sentence to roll them back to.
$soft_delete_orphans

-- Step 3: delete annotation_version rows that either came from wiped
-- migrations or reference soon-to-be-deleted sentences.
DELETE FROM annotation_version
WHERE origin_migration_id IN ($wipe_ids_csv)
   OR sentence_id IN (SELECT sentence_id FROM sentence WHERE migration_id IN ($wipe_ids_csv));

-- Step 4: tag rows belong to migrations.
DELETE FROM annotation_tag WHERE tag_id IN (
    SELECT tag_id FROM tag WHERE migration_id IN ($wipe_ids_csv)
);
DELETE FROM tag WHERE migration_id IN ($wipe_ids_csv);

-- Step 5: delete sentences from wiped migrations.
DELETE FROM sentence WHERE migration_id IN ($wipe_ids_csv);

-- Step 6: delete the migration rows themselves.
DELETE FROM migration WHERE migration_id IN ($wipe_ids_csv);

COMMIT;
EOF
)

PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -q <<<"$sql"

echo "Done."
echo ""
echo "Manuscript $manuscript_label is now at migration $keep_id."
echo "Trigger /admin/sync (or push to the tracked branch) to migrate forward again."
