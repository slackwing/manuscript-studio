#!/usr/bin/env bash
#
# Vendor utilities from github.com/slackwing/tuft into manuscript-studio.
#
# Usage:
#   scripts/vendor-tuft.sh                       # default ref=main, source=~/src/tuft
#   scripts/vendor-tuft.sh --ref=v0.1.0
#   scripts/vendor-tuft.sh --source=/some/clone
#
# Layout it produces:
#   web/js/rainbow-slice.js   # the vendored utility
#   web/js/TUFT_UPSTREAM      # provenance stamp (sibling of vendored files)
#
# Tuft utilities are pure JS with no DB-affecting side effects, so there's
# no version flow to worry about (unlike segman).

set -euo pipefail

REF="main"
SOURCE="$HOME/src/tuft"
for arg in "$@"; do
    case "$arg" in
        --ref=*)    REF="${arg#--ref=}" ;;
        --source=*) SOURCE="${arg#--source=}" ;;
        *) echo "unknown arg: $arg"; exit 2 ;;
    esac
done

if [ ! -d "$SOURCE/.git" ]; then
    echo "vendor-tuft: $SOURCE is not a git clone" >&2
    exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

echo "== Vendoring tuft from $SOURCE @ $REF =="

git -C "$SOURCE" fetch --quiet origin
git -C "$SOURCE" checkout --quiet "$REF"

UPSTREAM_SHA=$(git -C "$SOURCE" rev-parse --short HEAD)
UPSTREAM_REF=$(git -C "$SOURCE" rev-parse --abbrev-ref HEAD)
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Per-utility copies — explicit list, not a glob, so adding a tuft utility
# is a deliberate edit to this script + the consumer.
UTILS=(rainbow-slice.js)

for u in "${UTILS[@]}"; do
    SRC="$SOURCE/lib/js/$u"
    if [ ! -f "$SRC" ]; then
        echo "vendor-tuft: missing $SRC" >&2
        exit 1
    fi
    cp "$SRC" "web/js/$u"
    echo "  copied web/js/$u"
done

cat > web/js/TUFT_UPSTREAM <<EOF
source: github.com/slackwing/tuft
ref:    $REF
sha:    $UPSTREAM_SHA
branch: $UPSTREAM_REF
at:     $NOW
files:  ${UTILS[*]}
EOF
echo "  stamped web/js/TUFT_UPSTREAM (@ $UPSTREAM_SHA)"

echo "== Done. =="
echo "Vendored tuft from $UPSTREAM_REF @ $UPSTREAM_SHA"
