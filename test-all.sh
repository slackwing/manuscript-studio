#!/bin/bash
# Run all Manuscript Studio tests.
#
# Ported from 14.writesys/test-all.sh. Runs the gatekeeper tests in order:
#   1. Go unit tests
#   2. UI integration (catches overflow / layout / Paged.js regressions)
# Feature tests in tests/test-*.js are intentionally NOT run here — they are
# ad-hoc and mixed quality. Run individual ones with `node tests/<name>.js`.

set -e

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

echo "2. Running UI integration tests..."
echo "-----------------------------------"
node tests/ui-integration.js || { echo "❌ UI integration tests failed"; exit 1; }
echo ""

echo "========================================"
echo "✅ ALL TESTS PASSED!"
echo "========================================"
echo ""
echo "Test artifacts:"
echo "  - tests/screenshots/ui-integration.png"
echo "  - tests/screenshots/smoke.png"
echo ""
