#!/usr/bin/env bash
#
# Vendor ProseMirror as ONE self-contained ESM bundle for the scratchpad
# editor (SCRATCHPAD_PLAN.md §6).
#
# Why a bundle instead of per-package CDN imports: ProseMirror's packages
# share prosemirror-model class identities (Schema/Node instanceof checks);
# loading packages from a CDN can resolve the shared dep to two different
# URLs → two module instances → subtle breakage. One esbuild bundle has
# exactly one copy, is fully offline, and pins versions at vendor time.
#
# Produces:
#   web/scratchpad/vendor/prosemirror.mjs   # the bundle (committed)
#   web/scratchpad/vendor/PM_UPSTREAM       # provenance stamp
#
# Usage: scripts/vendor-prosemirror.sh   (network + npm required; the app
# itself keeps its no-build-step discipline — this is a vendor refresh, run
# like vendor-segman.sh / vendor-tuft.sh.)
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Pin the set together; bump deliberately.
PKGS=(
    prosemirror-model@1.25.3
    prosemirror-state@1.4.3
    prosemirror-view@1.41.3
    prosemirror-transform@1.10.4
    prosemirror-commands@1.7.1
    prosemirror-keymap@1.2.3
    prosemirror-history@1.4.1
    prosemirror-inputrules@1.5.0
    prosemirror-schema-list@1.5.1
    prosemirror-dropcursor@1.8.2
    prosemirror-gapcursor@1.3.2
    prosemirror-tables@1.7.1
)

WORK=$(mktemp -d /tmp/vendor-prosemirror.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

npm init -y >/dev/null
npm install --no-audit --no-fund --silent esbuild "${PKGS[@]}"

cat > entry.mjs <<'ENTRY'
export * from 'prosemirror-model';
export * from 'prosemirror-state';
export * from 'prosemirror-view';
export * from 'prosemirror-transform';
export * from 'prosemirror-commands';
export * from 'prosemirror-keymap';
export * from 'prosemirror-history';
export * from 'prosemirror-inputrules';
export * from 'prosemirror-schema-list';
export { dropCursor } from 'prosemirror-dropcursor';
export { gapCursor } from 'prosemirror-gapcursor';
export * from 'prosemirror-tables';
ENTRY

./node_modules/.bin/esbuild entry.mjs --bundle --format=esm --minify \
    --outfile=prosemirror.mjs

mkdir -p "$REPO_ROOT/web/scratchpad/vendor"
cp prosemirror.mjs "$REPO_ROOT/web/scratchpad/vendor/prosemirror.mjs"

{
    echo "source: prosemirror.net packages, bundled via esbuild"
    echo "at:     $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    printf 'pkg:    %s\n' "${PKGS[@]}"
} > "$REPO_ROOT/web/scratchpad/vendor/PM_UPSTREAM"

echo "Vendored $(du -h "$REPO_ROOT/web/scratchpad/vendor/prosemirror.mjs" | cut -f1) bundle."
