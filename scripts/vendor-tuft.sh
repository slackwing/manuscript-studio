#!/usr/bin/env bash
#
# Vendor utilities and UI components from github.com/slackwing/tuft into
# manuscript-studio. Copies are never edited here — change tuft, re-run.
#
# Usage:
#   scripts/vendor-tuft.sh                       # ref=origin/main, source=~/src/tuft
#   scripts/vendor-tuft.sh --ref=v0.6.0
#   scripts/vendor-tuft.sh --source=/some/clone
#
# Reads the files straight from git at the ref (`git show`), so it never
# checks anything out in the tuft clone.
#
# Layout it produces:
#   web/js/rainbow-slice.js                    # lib/js utilities (pure functions)
#   web/js/TUFT_UPSTREAM                       #   provenance stamp
#   web/vendor/tuft/grid-of-squares.{js,css}   # lib/ui components (JS + CSS)
#   web/vendor/tuft/TUFT_UPSTREAM              #   provenance stamp
#
# Tuft code is pure JS/CSS with no DB-affecting side effects, so there's no
# version flow to worry about (unlike segman).

set -euo pipefail

REF="origin/main"
SOURCE="$HOME/src/tuft"
for arg in "$@"; do
    case "$arg" in
        --ref=*)    REF="${arg#--ref=}" ;;
        --source=*) SOURCE="${arg#--source=}" ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

if [ ! -d "$SOURCE/.git" ]; then
    echo "vendor-tuft: $SOURCE is not a git clone" >&2
    exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Explicit lists, not globs: adding a tuft utility/component is a deliberate
# edit to this script + the consumer.
UTILS=(rainbow-slice.js)            # lib/js/<file>            → web/js/
COMPONENTS=(grid-of-squares)        # lib/ui/<name>/<name>.{js,css} → web/vendor/tuft/
UTILS_DEST="web/js"
COMPONENTS_DEST="web/vendor/tuft"

git -C "$SOURCE" fetch --quiet origin
SHA=$(git -C "$SOURCE" rev-parse --short "$REF")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "== Vendoring tuft from $SOURCE @ $REF ($SHA) =="

show() { # <path in tuft> <dest file>
    if ! git -C "$SOURCE" cat-file -e "$REF:$1" 2>/dev/null; then
        echo "vendor-tuft: $1 not found at $REF" >&2
        exit 1
    fi
    git -C "$SOURCE" show "$REF:$1" > "$2"
    echo "  $1 → $2"
}

stamp() { # <dest dir> <files...>
    local dest="$1"; shift
    cat > "$dest/TUFT_UPSTREAM" <<EOF
source: github.com/slackwing/tuft
ref:    $REF
sha:    $SHA
at:     $NOW
files:  $*
EOF
    echo "  stamped $dest/TUFT_UPSTREAM"
}

mkdir -p "$UTILS_DEST" "$COMPONENTS_DEST"
for u in "${UTILS[@]}"; do
    show "lib/js/$u" "$UTILS_DEST/$u"
done
stamp "$UTILS_DEST" "${UTILS[@]}"

files=()
for c in "${COMPONENTS[@]}"; do
    for ext in js css; do
        show "lib/ui/$c/$c.$ext" "$COMPONENTS_DEST/$c.$ext"
        files+=("$c.$ext")
    done
done
stamp "$COMPONENTS_DEST" "${files[@]}"

echo "== Done. Vendored tuft @ $REF ($SHA) =="
