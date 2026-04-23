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
  test-manuscript-picker
  test-rainbow-slice
  test-session-expiry-redirect
  test-never-mind-focus
  test-tag-api
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
)

SLOW_TESTS=(
  test-history-bars
  test-suggested-edits
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

echo "========================================"
echo "Manuscript Studio Test Suite ($mode)"
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

# Sanity check: every tests/*.js (other than test-utils) is classified.
declare -A classified
for name in "${FAST_TESTS[@]}" "${SLOW_TESTS[@]}"; do classified[$name]=1; done
for f in tests/*.js; do
  name=$(basename "$f" .js)
  [ "$name" = "test-utils" ] && continue
  if [ -z "${classified[$name]:-}" ]; then
    echo "❌ tests/${name}.js is not classified as fast or slow in test-all.sh"
    exit 1
  fi
done

echo "2. Running JS test scripts (${#js_tests[@]} files)..."
echo "-----------------------------"

passed=()
failed=()
suite_start=$(date +%s)

for name in "${js_tests[@]}"; do
  echo ""
  echo "▶ $name"
  start=$(date +%s)
  if timeout 120 node "tests/${name}.js"; then
    end=$(date +%s)
    passed+=("$name")
    printf "✓ %s (%ds)\n" "$name" "$((end-start))"
  else
    end=$(date +%s)
    failed+=("$name")
    printf "✗ %s (%ds)\n" "$name" "$((end-start))"
  fi
done

suite_end=$(date +%s)
echo ""
echo "========================================"
echo "Summary: ${#passed[@]} passed, ${#failed[@]} failed ($((suite_end-suite_start))s total)"
echo "========================================"

if [ ${#failed[@]} -gt 0 ]; then
  echo ""
  echo "Failed tests:"
  for n in "${failed[@]}"; do echo "  - $n"; done
  exit 1
fi

echo ""
echo "✅ ALL TESTS PASSED!"
