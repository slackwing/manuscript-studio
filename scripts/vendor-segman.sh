#!/usr/bin/env bash
#
# Vendor segman from github.com/slackwing/segman into manuscript-studio.
#
# Usage:
#   scripts/vendor-segman.sh                       # default ref=main, source=~/src/segman
#   scripts/vendor-segman.sh --ref=v1.0.0
#   scripts/vendor-segman.sh --source=/some/clone
#
# Layout it produces:
#   internal/segman/segman.go        # Go library
#   internal/segman/VERSION.json     # source-of-truth for SegmenterVersion
#   internal/segman/UPSTREAM         # human-readable provenance stamp
#   web/js/segman.js                 # JS library
#
# Verifies `go build ./...` after the copy. Exits non-zero on any error.

set -euo pipefail

REF="main"
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

# Fetch + checkout the requested ref. Doing this in the source clone (not a
# temp clone) keeps things fast; the user's local clone is the staging area.
git -C "$SOURCE" fetch --quiet origin
git -C "$SOURCE" checkout --quiet "$REF"

UPSTREAM_SHA=$(git -C "$SOURCE" rev-parse --short HEAD)
UPSTREAM_REF=$(git -C "$SOURCE" rev-parse --abbrev-ref HEAD)
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Sanity-check the source has what we expect.
for f in exports/lib/segman-go/segman.go exports/lib/segman-js/segman.js VERSION.json; do
    if [ ! -f "$SOURCE/$f" ]; then
        echo "vendor-segman: missing expected file $SOURCE/$f" >&2
        exit 1
    fi
done

# Wipe + re-create the destination dirs so removed-upstream files don't linger.
mkdir -p internal/segman web/js
rm -f internal/segman/segman.go internal/segman/VERSION.json web/js/segman.js

cp "$SOURCE/exports/lib/segman-go/segman.go" internal/segman/segman.go
cp "$SOURCE/VERSION.json"                    internal/segman/VERSION.json
cp "$SOURCE/exports/lib/segman-js/segman.js" web/js/segman.js

# The upstream Go package is currently named `senseg` (legacy from a
# prior rename). manuscript-studio wants `segman`. Until segman is
# properly renamed upstream (Phase 6 work, see PERSONAL_VENDORING_PLAN.md),
# rewrite at vendor time. Keep this until upstream catches up so we can
# delete this block.
sed -i 's/^package senseg$/package segman/' internal/segman/segman.go

# The upstream segman.go has its own Version() that runtime-reads
# ../../VERSION.json — that path doesn't exist inside manuscript-studio,
# so the function returns "unknown". We don't call it; the source-of-
# truth for our build is internal/segman/version.go (not vendored,
# hand-written) which go:embeds VERSION.json. Leaving the upstream
# Version() in place as dead code rather than trying to surgically
# remove it from a vendored file.

cat > internal/segman/UPSTREAM <<EOF
source: github.com/slackwing/segman
ref:    $REF
sha:    $UPSTREAM_SHA
branch: $UPSTREAM_REF
at:     $NOW
EOF

echo "  copied internal/segman/segman.go"
echo "  copied internal/segman/VERSION.json"
echo "  copied web/js/segman.js"
echo "  stamped internal/segman/UPSTREAM (@ $UPSTREAM_SHA)"

echo "== Verifying build =="
go build ./... >/dev/null

echo "== Done. =="
echo "Vendored segman from $UPSTREAM_REF @ $UPSTREAM_SHA"
echo "Review: git diff internal/segman web/js/segman.js"
