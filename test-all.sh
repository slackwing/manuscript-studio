#!/bin/bash
# Run all Manuscript Studio tests.
#
# Runs the gatekeeper tests in order:
#   1. Go unit tests
#   2. Every tests/*.js script (browser-driven via Playwright, plus pure unit
#      tests like rainbow-slice). test-utils.js is skipped — it's a helper, not
#      a test.
#
# Assumes a dev server on http://localhost:5001 (start with `make dev`).

set -u

echo "========================================"
echo "Manuscript Studio Complete Test Suite"
echo "========================================"
echo ""

if ! curl -s http://localhost:5001/health > /dev/null 2>&1; then
  echo "❌ ERROR: Server not running on http://localhost:5001"
  echo "   Start it with: make dev   (or: make dev-install)"
  exit 1
fi

echo "1. Running Go unit tests..."
echo "----------------------------"
go test ./... || { echo "❌ Unit tests failed"; exit 1; }
echo "✓ Unit tests passed"
echo ""

echo "2. Running JS test scripts..."
echo "-----------------------------"

passed=()
failed=()

for f in tests/*.js; do
  name=$(basename "$f" .js)
  [ "$name" = "test-utils" ] && continue

  echo ""
  echo "▶ $name"
  if timeout 120 node "$f"; then
    passed+=("$name")
    echo "✓ $name"
  else
    failed+=("$name")
    echo "✗ $name"
  fi
done

echo ""
echo "========================================"
echo "Summary: ${#passed[@]} passed, ${#failed[@]} failed"
echo "========================================"

if [ ${#failed[@]} -gt 0 ]; then
  echo ""
  echo "Failed tests:"
  for n in "${failed[@]}"; do echo "  - $n"; done
  exit 1
fi

echo ""
echo "✅ ALL TESTS PASSED!"
