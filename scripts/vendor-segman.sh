#!/usr/bin/env bash
#
# Vendor segman from github.com/slackwing/segman into manuscript-studio.
#
# Usage:
#   scripts/vendor-segman.sh                       # default ref=v1.0.0, source=~/src/segman
#   scripts/vendor-segman.sh --ref=v1.1.0
#   scripts/vendor-segman.sh --source=/some/clone
#
# Layout it produces:
#   internal/segman/segman.go        # vendored Go library (package segman)
#   internal/segman/UPSTREAM         # provenance stamp
#   web/js/segman.js                 # vendored JS library
#
# Notes:
#   - We pin to a tag (v1.0.0) by default rather than `main`, so vendor
#     refreshes are deliberate version moves rather than "whatever HEAD is."
#   - segman.Version is a const baked into segman.go at the upstream's build
#     time; we don't need a separate VERSION.json in this repo.
#   - go build ./... runs after the copy to catch any breakage immediately.

set -euo pipefail

REF="v1.0.0"
SOURCE="$HOME/src/segman"
for arg in "$@"; do
    case "$arg" in
        --ref=*)    REF="${arg#--ref=}" ;;
        --source=*) SOURCE="${arg#--source=}" ;;
        *) echo "unknown arg: $arg"; exit 2 ;;
    esac
done

if [ ! -d "$SOURCE/.git" ]; then
    echo "vendor-segman: $SOURCE is not a git clone" >&2
    exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

echo "== Vendoring segman from $SOURCE @ $REF =="

git -C "$SOURCE" fetch --quiet --tags origin
git -C "$SOURCE" checkout --quiet "$REF"

UPSTREAM_SHA=$(git -C "$SOURCE" rev-parse --short HEAD)
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

for f in go/segman.go js/segman.js; do
    if [ ! -f "$SOURCE/$f" ]; then
        echo "vendor-segman: missing expected file $SOURCE/$f" >&2
        exit 1
    fi
done

mkdir -p internal/segman web/js
rm -f internal/segman/segman.go web/js/segman.js

cp "$SOURCE/go/segman.go" internal/segman/segman.go
cp "$SOURCE/js/segman.js" web/js/segman.js

cat > internal/segman/UPSTREAM <<EOF
source: github.com/slackwing/segman
ref:    $REF
sha:    $UPSTREAM_SHA
at:     $NOW
EOF

echo "  copied internal/segman/segman.go"
echo "  copied web/js/segman.js"
echo "  stamped internal/segman/UPSTREAM (@ $UPSTREAM_SHA)"

echo "== Verifying build =="
go build ./... >/dev/null

echo "== Done. =="
echo "Vendored segman from $REF (sha $UPSTREAM_SHA)"
echo "Review: git diff internal/segman web/js/segman.js"
