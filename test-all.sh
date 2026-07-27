#!/bin/bash
# Run Manuscript Studio tests.
#
# Usage:
#   ./test-all.sh           # run everything: Go unit tests + all JS tests
#   ./test-all.sh fast      # Go unit tests + fast JS subset (~2.5 min)
#   ./test-all.sh slow      # Go unit tests + slow JS subset (~7 min)
#   ./test-all.sh js-only   # all JS tests, skip Go (server must be running)
#
# Assumes a dev server on http://localhost:5001 (start with `make dev`).
# When adding a new tests/*.js file, classify it below as fast or slow.

set -u

# Each list is the basename (no .js). test-utils.js is the shared helper and
# is never run as a test.
#
# fast = consistently ≤15s wall time on a warm dev box.
# slow = >15s, typically because of multi-stage browser flows or layouts that
#        require waiting on hover-out timeouts and animation settles.
FAST_TESTS=(
  test-wordcount
  test-rainbow-slice
  test-session-expiry-redirect
  test-never-mind-focus
  test-tag-api
  test-tag-authz
  test-xss-annotation
  alignment-test
  comprehensive-test
  detailed-alignment-test
  circle-alignment-test
  final-test
  test-complete-annotation
  test-typing-race-on-create
  test-autofocus-on-select
  smoke
  multi-note-ui-test
  test-priority-flag
  test-trash-deletion
  test-suggestion-stale-guard
  test-suggestion-modal-fixes
  test-structural-suggestion
  test-annotation-note-fixes
  test-placeholder-parse
  test-placeholder
  test-region-resolver
  test-home
  test-login-form
  test-anchor-glyph
  test-anchor-inline
  test-break-buttons
  test-canonicalize
  test-canon-render-pipeline
  test-cheatsheet
  test-responsive-layout
  test-mobile-scale-affordances
  test-sketch-navigate
  test-sketch-restore
  test-snippet-editor
  test-sketch-sibling-refresh
)

SLOW_TESTS=(
  test-scratchpad-canonize
  test-history-bars
  test-suggested-edits
  test-suggestion-scroll
  test-push-suggestions
  verify-fixes
  test-delete-and-recreate
  test-note-and-tags
  verify-rainbow-bars-update
  sticky-note-features
  test-tags-ui
  test-tags-comprehensive
  test-scrollable-notes
  ui-integration
  spacing-invariants-test
  test-rainbow-bars-final
  test-double-click-trash
  test-rainbow-bar-clicks
  test-rainbow-deletion
  test-inline-tag-input
  trash-icon-test
)

mode="${1:-all}"
case "$mode" in
  fast)    js_tests=("${FAST_TESTS[@]}");          run_go=1 ;;
  slow)    js_tests=("${SLOW_TESTS[@]}");          run_go=1 ;;
  all)     js_tests=("${FAST_TESTS[@]}" "${SLOW_TESTS[@]}"); run_go=1 ;;
  js-only) js_tests=("${FAST_TESTS[@]}" "${SLOW_TESTS[@]}"); run_go=0 ;;
  *)
    echo "Unknown mode: $mode"
    echo "Usage: $0 [fast|slow|all|js-only]"
    exit 2
    ;;
esac

# Parallel workers (per-worker fixture manuscripts + users — see
# tests/test-utils.js and tests/provision-workers.sh). MS_TEST_WORKERS=1
# gives the old sequential behavior.
WORKERS="${MS_TEST_WORKERS:-4}"

echo "========================================"
echo "Manuscript Studio Test Suite ($mode, ${WORKERS} workers)"
echo "========================================"
echo ""

if ! curl -s http://localhost:5001/health > /dev/null 2>&1; then
  echo "❌ ERROR: Server not running on http://localhost:5001"
  echo "   Start it with: make dev   (or: make dev-install)"
  exit 1
fi

if [ "$run_go" -eq 1 ]; then
  echo "1. Running Go unit tests..."
  echo "----------------------------"
  go test ./... || { echo "❌ Unit tests failed"; exit 1; }
  echo "✓ Unit tests passed"
  echo ""
fi

# Sanity check: every entry exists on disk.
for name in "${js_tests[@]}"; do
  if [ ! -f "tests/${name}.js" ]; then
    echo "❌ Missing test file: tests/${name}.js (referenced in test-all.sh)"
    exit 1
  fi
done

# Sanity check: every tests/*.js (other than shared infra) is classified.
declare -A classified
for name in "${FAST_TESTS[@]}" "${SLOW_TESTS[@]}"; do classified[$name]=1; done
for f in tests/*.js; do
  name=$(basename "$f" .js)
  case "$name" in test-utils|pw-server|pw-shared|reset-fixture) continue ;; esac
  if [ -z "${classified[$name]:-}" ]; then
    echo "❌ tests/${name}.js is not classified as fast or slow in test-all.sh"
    exit 1
  fi
done

# Sanity check: no new second-plus unconditional sleeps — wait on a
# condition instead (test-utils.waitForPagination & friends). Grandfathered
# offenders live in tests/.sleep-allowlist (one "file:count" per line).
sleep_fail=0
while IFS= read -r f; do
  n=$(grep -cE "waitForTimeout\(\s*[0-9]{4,}" "$f" || true)
  [ "$n" -eq 0 ] && continue
  allowed=$(grep -E "^$(basename "$f"):" tests/.sleep-allowlist 2>/dev/null | cut -d: -f2)
  if [ -z "$allowed" ] || [ "$n" -gt "$allowed" ]; then
    echo "❌ $(basename "$f") has $n waitForTimeout(>=1000ms) calls (allowlisted: ${allowed:-0})."
    echo "   Wait on a condition instead (waitForPagination / waitForSelector / waitForFunction)."
    sleep_fail=1
  fi
done < <(ls tests/*.js | grep -v test-utils)
[ "$sleep_fail" -eq 1 ] && exit 1

echo "2. Preparing fixtures + shared browser..."
echo "-----------------------------"
bash tests/provision-workers.sh "$WORKERS"

WS_FILE=$(mktemp)
node tests/pw-server.js > "$WS_FILE" &
PW_PID=$!
trap 'kill $PW_PID 2>/dev/null' EXIT
for i in $(seq 1 50); do
  grep -q "^ws" "$WS_FILE" && break
  sleep 0.2
done
export MS_TEST_WS=$(head -1 "$WS_FILE")
export NODE_OPTIONS="--require $PWD/tests/pw-shared.js${NODE_OPTIONS:+ $NODE_OPTIONS}"
if [ -z "$MS_TEST_WS" ]; then
  echo "❌ shared browser failed to start"; exit 1
fi

# Nuclear reset once per worker, in parallel.
reset_pids=()
for w in $(seq 1 "$WORKERS"); do
  MS_TEST_WORKER=$w node tests/reset-fixture.js > /dev/null 2>&1 &
  reset_pids+=($!)
done
for p in "${reset_pids[@]}"; do wait "$p" || { echo "❌ fixture reset failed (worker)"; exit 1; }; done
echo "  fixtures reset (${WORKERS} workers)"
echo ""

echo "3. Running JS test scripts (${#js_tests[@]} files, ${WORKERS} workers)..."
echo "-----------------------------"

RUNDIR=$(mktemp -d)
suite_start=$(date +%s)

run_worker() {
  local w=$1; shift
  local names=("$@")
  for name in "${names[@]}"; do
    local start end status
    start=$(date +%s)
    if MS_TEST_WORKER=$w timeout 180 node "tests/${name}.js" > "$RUNDIR/${name}.log" 2>&1; then
      status=pass
    else
      status=fail
    fi
    end=$(date +%s)
    echo "${name}|${status}|$((end-start))|${w}" >> "$RUNDIR/results"
    echo "  [w${w}] ${status}: ${name} ($((end-start))s)"
  done
}

# Round-robin distribution keeps each worker's mix of fast/slow balanced.
declare -a bucket
for i in "${!js_tests[@]}"; do
  w=$(( (i % WORKERS) + 1 ))
  bucket[$w]="${bucket[$w]:-} ${js_tests[$i]}"
done

worker_pids=()
for w in $(seq 1 "$WORKERS"); do
  # shellcheck disable=SC2086
  run_worker "$w" ${bucket[$w]:-} &
  worker_pids+=($!)
done
for p in "${worker_pids[@]}"; do wait "$p"; done

suite_end=$(date +%s)

passed=()
failed=()
for name in "${js_tests[@]}"; do
  line=$(grep "^${name}|" "$RUNDIR/results" || true)
  if [ -z "$line" ]; then failed+=("$name"); continue; fi
  if [ "$(echo "$line" | cut -d'|' -f2)" = "pass" ]; then
    passed+=("$name")
  else
    failed+=("$name")
  fi
done

echo ""
echo "========================================"
echo "Summary: ${#passed[@]} passed, ${#failed[@]} failed ($((suite_end-suite_start))s total, ${WORKERS} workers)"
echo "========================================"

if [ ${#failed[@]} -gt 0 ]; then
  echo ""
  echo "Failed tests:"
  for n in "${failed[@]}"; do
    echo "  - $n"
    tail -12 "$RUNDIR/${n}.log" 2>/dev/null | sed 's/^/      /'
  done
  exit 1
fi

echo ""
echo "✅ ALL TESTS PASSED!"
