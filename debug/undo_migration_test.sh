#!/usr/bin/env bash
# Test for debug/undo_migration.sh.
#
# Builds a synthetic manuscript with three migrations and a few annotations
# in different states, then drives the script via piped input to confirm:
#   - migrations newer than the kept one are deleted
#   - the kept migration's data is untouched
#   - annotations get repointed to their pre-wipe sentence_id
#   - annotations created during a wiped migration are soft-deleted
#
# Talks to the dev DB on localhost:5433 (same as the Go integration tests).
# Skips if no DB is reachable.

set -uo pipefail
# We turn off -e because we want to keep going past the first failed
# assertion to surface multiple problems in one run.

DB_HOST=${MANUSCRIPT_STUDIO_TEST_DB_HOST:-localhost}
DB_PORT=${MANUSCRIPT_STUDIO_TEST_DB_PORT:-5433}
DB_NAME=${MANUSCRIPT_STUDIO_TEST_DB_NAME:-manuscript_studio_dev}
DB_USER=${MANUSCRIPT_STUDIO_TEST_DB_USER:-manuscript_dev}
DB_PASSWORD=${MANUSCRIPT_STUDIO_TEST_DB_PASSWORD:-manuscript_dev}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDO_SCRIPT="$SCRIPT_DIR/undo_migration.sh"

if [[ ! -x "$UNDO_SCRIPT" ]]; then
    echo "FAIL: $UNDO_SCRIPT not found or not executable" >&2
    exit 1
fi

# Build a temp config file pointing at the dev DB so undo_migration.sh
# reads our credentials. (The script reads ~/.config/manuscript-studio/config.yaml
# by default, which is the production one — we don't want to touch that.)
TMPCFG=$(mktemp /tmp/undo-test-config.XXXXXX.yaml)
cat > "$TMPCFG" <<EOF
database:
  host: "$DB_HOST"
  port: $DB_PORT
  name: "$DB_NAME"
  user: "$DB_USER"
  password: "$DB_PASSWORD"
EOF

trap 'rm -f "$TMPCFG"' EXIT

q() {
    # -At = tuples-only/unaligned. Strip psql's command tag so callers can
    # cleanly capture RETURNING values. `|| true` keeps grep's no-match
    # exit from tripping the test runner's set -e.
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
        -At -F $'\t' -v ON_ERROR_STOP=1 -c "$1" \
        | { grep -Ev '^(INSERT|UPDATE|DELETE|SELECT|COPY) [0-9]' || true; }
}

x() {
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
        -v ON_ERROR_STOP=1 -q -c "$1" >/dev/null
}

# Skip if DB unreachable.
if ! q "SELECT 1" >/dev/null 2>&1; then
    echo "SKIP: cannot reach test DB at $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
    exit 0
fi

# Use a unique repo path so we don't collide with other tests/data.
REPO="test://undo-mig-test-$$"

cleanup_data() {
    # Nukes everything tied to manuscripts whose repo_path starts with
    # 'test://' OR is empty. This catches leftovers from prior failed
    # runs (with a different $$-derived $REPO) and the orphan-row scenario
    # from Test 3.
    x "
        DELETE FROM annotation_version WHERE annotation_id IN (
            SELECT a.annotation_id FROM annotation a
            JOIN sentence s ON a.sentence_id = s.sentence_id
            JOIN migration m ON s.migration_id = m.migration_id
            JOIN manuscript man ON m.manuscript_id = man.manuscript_id
            WHERE man.repo_path LIKE 'test://%' OR man.repo_path = ''
        );
        DELETE FROM annotation WHERE sentence_id IN (
            SELECT s.sentence_id FROM sentence s
            JOIN migration m ON s.migration_id = m.migration_id
            JOIN manuscript man ON m.manuscript_id = man.manuscript_id
            WHERE man.repo_path LIKE 'test://%' OR man.repo_path = ''
        );
        DELETE FROM sentence WHERE migration_id IN (
            SELECT m.migration_id FROM migration m
            JOIN manuscript man ON m.manuscript_id = man.manuscript_id
            WHERE man.repo_path LIKE 'test://%' OR man.repo_path = ''
        );
        DELETE FROM migration WHERE manuscript_id IN (
            SELECT manuscript_id FROM manuscript
            WHERE repo_path LIKE 'test://%' OR repo_path = ''
        );
        DELETE FROM manuscript WHERE repo_path LIKE 'test://%' OR repo_path = '';
        DELETE FROM \"user\" WHERE username = 'undo_test_user';
    "
}

setup_scenario() {
    cleanup_data
    x "INSERT INTO \"user\" (username, password_hash, role) VALUES ('undo_test_user', 'x', 'author') ON CONFLICT DO NOTHING;"
    x "INSERT INTO manuscript (repo_path, file_path) VALUES ('$REPO', 'm.md');"

    local mid
    mid=$(q "SELECT manuscript_id FROM manuscript WHERE repo_path = '$REPO'")

    # Migration 1: bootstrap, two sentences, status='done'.
    local m1_sent_ids='["S1A","S1B"]'
    local m1
    m1=$(q "INSERT INTO migration (manuscript_id, commit_hash, segmenter, branch_name, sentence_count, additions_count, deletions_count, changes_count, sentence_id_array, status, started_at, finished_at) VALUES ($mid, 'commit1', 'segman-1.0.0', 'main', 2, 2, 0, 0, '$m1_sent_ids'::jsonb, 'done', NOW(), NOW()) RETURNING migration_id")
    x "INSERT INTO sentence (sentence_id, migration_id, commit_hash, text, word_count, ordinal) VALUES
        ('S1A', $m1, 'commit1', 'sentence one', 2, 0),
        ('S1B', $m1, 'commit1', 'sentence two', 2, 1);"

    # An annotation created during migration 1 on sentence S1A.
    local ann1
    ann1=$(q "INSERT INTO annotation (sentence_id, user_id, color, priority, flagged, position) VALUES ('S1A', 'undo_test_user', 'yellow', 'none', false, '0|x') RETURNING annotation_id")
    x "INSERT INTO annotation_version (annotation_id, version, sentence_id, color, note, priority, flagged, sentence_id_history, migration_confidence, origin_sentence_id, origin_migration_id, origin_commit_hash, created_by) VALUES
        ($ann1, 1, 'S1A', 'yellow', NULL, 'none', false, '[\"S1A\"]'::jsonb, NULL, 'S1A', $m1, 'commit1', 'undo_test_user');"

    # Migration 2: status='done' with proper annotation migration. Sentence
    # text is the same (so unchanged sentence — but new sentence_ids because
    # commit_hash changed). Annotation's sentence_id should be S2A now.
    local m2_sent_ids='["S2A","S2B"]'
    local m2
    m2=$(q "INSERT INTO migration (manuscript_id, commit_hash, segmenter, branch_name, sentence_count, additions_count, deletions_count, changes_count, sentence_id_array, status, started_at, finished_at) VALUES ($mid, 'commit2', 'segman-1.0.0', 'main', 2, 0, 0, 0, '$m2_sent_ids'::jsonb, 'done', NOW(), NOW()) RETURNING migration_id")
    x "INSERT INTO sentence (sentence_id, migration_id, commit_hash, text, word_count, ordinal) VALUES
        ('S2A', $m2, 'commit2', 'sentence one', 2, 0),
        ('S2B', $m2, 'commit2', 'sentence two', 2, 1);"
    # The annotation moved to S2A as part of migration 2.
    x "UPDATE annotation SET sentence_id = 'S2A' WHERE annotation_id = $ann1;"
    x "INSERT INTO annotation_version (annotation_id, version, sentence_id, color, note, priority, flagged, sentence_id_history, migration_confidence, origin_sentence_id, origin_migration_id, origin_commit_hash, created_by) VALUES
        ($ann1, 2, 'S2A', 'yellow', NULL, 'none', false, '[\"S1A\",\"S2A\"]'::jsonb, 1.0, 'S1A', $m2, 'commit1', 'undo_test_user');"

    # While viewing migration 2, the user adds a NEW annotation on S2B.
    # This annotation has no v1 in any earlier migration — it's an orphan
    # if migration 2 is wiped.
    local ann2
    ann2=$(q "INSERT INTO annotation (sentence_id, user_id, color, priority, flagged, position) VALUES ('S2B', 'undo_test_user', 'green', 'none', false, '1|x') RETURNING annotation_id")
    x "INSERT INTO annotation_version (annotation_id, version, sentence_id, color, note, priority, flagged, sentence_id_history, migration_confidence, origin_sentence_id, origin_migration_id, origin_commit_hash, created_by) VALUES
        ($ann2, 1, 'S2B', 'green', NULL, 'none', false, '[\"S2B\"]'::jsonb, NULL, 'S2B', $m2, 'commit2', 'undo_test_user');"

    # Migration 3: status='done', another no-op. Annotation moves to S3A.
    local m3_sent_ids='["S3A","S3B"]'
    local m3
    m3=$(q "INSERT INTO migration (manuscript_id, commit_hash, segmenter, branch_name, sentence_count, additions_count, deletions_count, changes_count, sentence_id_array, status, started_at, finished_at) VALUES ($mid, 'commit3', 'segman-1.0.0', 'main', 2, 0, 0, 0, '$m3_sent_ids'::jsonb, 'done', NOW(), NOW()) RETURNING migration_id")
    x "INSERT INTO sentence (sentence_id, migration_id, commit_hash, text, word_count, ordinal) VALUES
        ('S3A', $m3, 'commit3', 'sentence one', 2, 0),
        ('S3B', $m3, 'commit3', 'sentence two', 2, 1);"
    x "UPDATE annotation SET sentence_id = 'S3A' WHERE annotation_id = $ann1;"
    x "UPDATE annotation SET sentence_id = 'S3B' WHERE annotation_id = $ann2;"
    x "INSERT INTO annotation_version (annotation_id, version, sentence_id, color, note, priority, flagged, sentence_id_history, migration_confidence, origin_sentence_id, origin_migration_id, origin_commit_hash, created_by) VALUES
        ($ann1, 3, 'S3A', 'yellow', NULL, 'none', false, '[\"S1A\",\"S2A\",\"S3A\"]'::jsonb, 1.0, 'S1A', $m3, 'commit1', 'undo_test_user'),
        ($ann2, 2, 'S3B', 'green',  NULL, 'none', false, '[\"S2B\",\"S3B\"]'::jsonb, 1.0, 'S2B', $m3, 'commit2', 'undo_test_user');"

    # Echo IDs for assertions.
    echo "MID=$mid M1=$m1 M2=$m2 M3=$m3 ANN1=$ann1 ANN2=$ann2"
}

assert_eq() {
    local label="$1" want="$2" got="$3"
    if [[ "$got" == "$want" ]]; then
        printf "  ✓ %s\n" "$label"
    else
        printf "  ✗ %s — want %q, got %q\n" "$label" "$want" "$got"
        FAIL=1
    fi
}

FAIL=0

# Belt-and-suspenders: clear any leftover test data from a prior failed run
# before we start, so test 1 isn't poisoned.
cleanup_data

# ---- Helper: drive undo_migration.sh with a stdin script ----
# Echoes its stdin to the script with MANUSCRIPT_STUDIO_CONFIG_FILE pointing
# at the test config. Captures output to /tmp for assertions / debugging.
LOG=/tmp/undo-test-out.log
run_undo() {
    MANUSCRIPT_STUDIO_CONFIG_FILE="$TMPCFG" "$UNDO_SCRIPT" >"$LOG" 2>&1
}

# ============================================================
# Test 1: roll back from migration 3 (done) to migration 1 (done)
# Wipes M2 (done) and M3 (done). Verifies the full annotation cascade.
# ============================================================
echo "=== Test 1: rollback across done migrations ==="
ids=$(setup_scenario)
eval "$ids" # MID, M1, M2, M3, ANN1, ANN2

expected_token=$(basename "$REPO")
run_undo <<EOF
1
$M1
$expected_token
EOF
exit_code=$?

(( exit_code != 0 )) && { echo "  ✗ undo exited $exit_code"; FAIL=1; }
assert_eq "M1 kept"           "1"   "$(q "SELECT COUNT(*) FROM migration WHERE migration_id = $M1")"
assert_eq "M2 deleted"        "0"   "$(q "SELECT COUNT(*) FROM migration WHERE migration_id = $M2")"
assert_eq "M3 deleted"        "0"   "$(q "SELECT COUNT(*) FROM migration WHERE migration_id = $M3")"
assert_eq "M1 sentences kept" "2"   "$(q "SELECT COUNT(*) FROM sentence WHERE migration_id = $M1")"
assert_eq "M2/M3 sentences gone" "0" "$(q "SELECT COUNT(*) FROM sentence WHERE migration_id IN ($M2, $M3)")"
assert_eq "ANN1 repointed"    "S1A" "$(q "SELECT sentence_id FROM annotation WHERE annotation_id = $ANN1")"
assert_eq "ANN1 versions = 1" "1"   "$(q "SELECT COUNT(*) FROM annotation_version WHERE annotation_id = $ANN1")"
assert_eq "ANN2 soft-deleted" "t"   "$(q "SELECT deleted_at IS NOT NULL FROM annotation WHERE annotation_id = $ANN2")"

cleanup_data

# ============================================================
# Test 2: rollback wipes a mix of done + error rows
# Setup: M1=done with annotation, M2=error (no data), M3=done that
# moved the annotation. Rolling back to M1 should delete M2 and M3,
# rewind the annotation, and leave M1 intact.
# ============================================================
echo ""
echo "=== Test 2: rollback past error rows ==="
cleanup_data
x "INSERT INTO \"user\" (username, password_hash, role) VALUES ('undo_test_user', 'x', 'author') ON CONFLICT DO NOTHING;"
x "INSERT INTO manuscript (repo_path, file_path) VALUES ('$REPO', 'm.md');"
mid=$(q "SELECT manuscript_id FROM manuscript WHERE repo_path = '$REPO'")

# M1: done, with one annotation.
m1=$(q "INSERT INTO migration (manuscript_id, commit_hash, segmenter, branch_name, sentence_count, additions_count, deletions_count, changes_count, sentence_id_array, status, started_at, finished_at) VALUES ($mid, 'commitA', 'segman-1.0.0', 'main', 1, 1, 0, 0, '[\"S1\"]'::jsonb, 'done', NOW(), NOW()) RETURNING migration_id")
x "INSERT INTO sentence (sentence_id, migration_id, commit_hash, text, word_count, ordinal) VALUES ('S1', $m1, 'commitA', 'one sentence', 2, 0);"
ann1=$(q "INSERT INTO annotation (sentence_id, user_id, color, priority, flagged, position) VALUES ('S1', 'undo_test_user', 'yellow', 'none', false, '0|x') RETURNING annotation_id")
x "INSERT INTO annotation_version (annotation_id, version, sentence_id, color, note, priority, flagged, sentence_id_history, migration_confidence, origin_sentence_id, origin_migration_id, origin_commit_hash, created_by) VALUES ($ann1, 1, 'S1', 'yellow', NULL, 'none', false, '[\"S1\"]'::jsonb, NULL, 'S1', $m1, 'commitA', 'undo_test_user');"

# M2: error, no sentences (the broken-config case).
m2=$(q "INSERT INTO migration (manuscript_id, commit_hash, segmenter, status, started_at, finished_at, error) VALUES ($mid, 'commitB', 'segman-1.0.0', 'error', NOW(), NOW(), 'simulated failure') RETURNING migration_id")

# M3: done, moved the annotation to S3.
m3=$(q "INSERT INTO migration (manuscript_id, commit_hash, segmenter, branch_name, sentence_count, additions_count, deletions_count, changes_count, sentence_id_array, status, started_at, finished_at) VALUES ($mid, 'commitC', 'segman-1.0.0', 'main', 1, 0, 0, 0, '[\"S3\"]'::jsonb, 'done', NOW(), NOW()) RETURNING migration_id")
x "INSERT INTO sentence (sentence_id, migration_id, commit_hash, text, word_count, ordinal) VALUES ('S3', $m3, 'commitC', 'one sentence', 2, 0);"
x "UPDATE annotation SET sentence_id = 'S3' WHERE annotation_id = $ann1;"
x "INSERT INTO annotation_version (annotation_id, version, sentence_id, color, note, priority, flagged, sentence_id_history, migration_confidence, origin_sentence_id, origin_migration_id, origin_commit_hash, created_by) VALUES ($ann1, 2, 'S3', 'yellow', NULL, 'none', false, '[\"S1\",\"S3\"]'::jsonb, 1.0, 'S1', $m3, 'commitA', 'undo_test_user');"

run_undo <<EOF
1
$m1
$expected_token
EOF
exit_code=$?

(( exit_code != 0 )) && { echo "  ✗ undo exited $exit_code"; FAIL=1; }
assert_eq "M1 kept"               "1"   "$(q "SELECT COUNT(*) FROM migration WHERE migration_id = $m1")"
assert_eq "M2 (error) deleted"    "0"   "$(q "SELECT COUNT(*) FROM migration WHERE migration_id = $m2")"
assert_eq "M3 (done) deleted"     "0"   "$(q "SELECT COUNT(*) FROM migration WHERE migration_id = $m3")"
assert_eq "M3 sentence S3 gone"   "0"   "$(q "SELECT COUNT(*) FROM sentence WHERE sentence_id = 'S3'")"
assert_eq "annotation back at S1" "S1"  "$(q "SELECT sentence_id FROM annotation WHERE annotation_id = $ann1")"
assert_eq "annotation versions = 1" "1" "$(q "SELECT COUNT(*) FROM annotation_version WHERE annotation_id = $ann1")"

cleanup_data

# ============================================================
# Test 3: orphan manuscript (empty repo_path) is hidden from the menu
# Simulates the prod bug where startMigration created a manuscript row
# with empty repo_path before the empty-URL guard was added. The script's
# manuscript-list query should filter it out.
# ============================================================
echo ""
echo "=== Test 3: orphan manuscript with empty repo_path is hidden ==="
cleanup_data
x "INSERT INTO \"user\" (username, password_hash, role) VALUES ('undo_test_user', 'x', 'author') ON CONFLICT DO NOTHING;"
# Real manuscript:
x "INSERT INTO manuscript (repo_path, file_path) VALUES ('$REPO', 'm.md');"
real_mid=$(q "SELECT manuscript_id FROM manuscript WHERE repo_path = '$REPO'")
real_m1=$(q "INSERT INTO migration (manuscript_id, commit_hash, segmenter, branch_name, sentence_count, additions_count, deletions_count, changes_count, sentence_id_array, status, started_at, finished_at) VALUES ($real_mid, 'commitA', 'segman-1.0.0', 'main', 0, 0, 0, 0, '[]'::jsonb, 'done', NOW(), NOW()) RETURNING migration_id")
# Orphan: empty repo_path with a stuck migration row.
x "INSERT INTO manuscript (repo_path, file_path) VALUES ('', 'orphan.md');"
orphan_mid=$(q "SELECT manuscript_id FROM manuscript WHERE repo_path = ''")
x "INSERT INTO migration (manuscript_id, commit_hash, segmenter, status, started_at, finished_at, error) VALUES ($orphan_mid, 'commitX', 'segman-1.0.0', 'error', NOW(), NOW(), 'broken url');"

# Quit immediately by sending invalid menu input — we just want to see
# what the menu lists.
run_undo <<EOF
99
EOF

# The menu output should mention the real manuscript exactly once and not
# the orphan at all.
real_count=$(grep -c "id=$real_mid" "$LOG" || true)
orphan_count=$(grep -c "id=$orphan_mid" "$LOG" || true)
assert_eq "real manuscript listed once"   "1" "$real_count"
assert_eq "orphan manuscript hidden"      "0" "$orphan_count"

# Tidy up the orphan ourselves so cleanup_data doesn't trip over it.
x "DELETE FROM migration WHERE manuscript_id = $orphan_mid;"
x "DELETE FROM manuscript WHERE manuscript_id = $orphan_mid;"
cleanup_data

# ============================================================
echo ""
if (( FAIL )); then
    echo "FAIL"
    [[ -f $LOG ]] && cat "$LOG" | sed 's/^/    /'
    rm -f "$LOG"
    exit 1
fi
rm -f "$LOG"
echo "PASS"
