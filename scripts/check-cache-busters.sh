#!/usr/bin/env bash
#
# check-cache-busters.sh — fail if a cache-busted web asset changed vs. the
# last commit but its ?v= was NOT bumped in the file that references it.
#
# The trap this prevents: editing web/css/book.css (or any ?v='d JS) without
# bumping its ?v= means browsers keep serving the OLD cached file even after
# deploy — the change silently doesn't reach users. This bit us with the
# title/part page-break CSS (book.css edited across 3 commits, ?v=86 never
# bumped → looked broken on the live site until the cache was disabled).
#
# It ALSO walks the JS module chain: a bumped ?v= inside modal.mjs is useless
# while modal.mjs itself is cached under an old ?v= — every REFERENCING file
# whose ?v= strings changed must itself be bumped where IT is referenced.
# (That exact chain shipped a stale scratchpad.css to phones once.)
#
# Run before committing web changes:  scripts/check-cache-busters.sh
# Exits 0 if clean, 1 (with a list) if any asset drifted without a bump.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! git rev-parse HEAD >/dev/null 2>&1; then
  echo "no commits yet; skipping cache-buster check"
  exit 0
fi

# Every file that references ?v='d assets (HTML entry points + the JS/mjs
# links of the module chain).
REFERRERS=$(grep -rlE '\?v=[0-9]+' web --include='*.html' --include='*.js' --include='*.mjs' | sort -u)

fail=0

for REF_FILE in $REFERRERS; do
  # Every asset referenced with ?v=N in this file.
  assets=$(grep -oE "[A-Za-z0-9._/-]+\.(css|js|mjs)\?v=[0-9]+" "$REF_FILE" | sort -u)
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    rel="${ref%%\?v=*}"
    rel="${rel#./}"
    path="web/${rel}"                 # refs are web-root- or dir-relative
    if [ ! -f "$path" ]; then
      path="$(dirname "$REF_FILE")/${rel}"
      [ -f "$path" ] || continue      # vendored/absent — skip
    fi
    ver_now="${ref##*\?v=}"

    # Did the asset's content change vs HEAD?
    git diff --quiet HEAD -- "$path" && continue

    # Asset changed. Did its ?v= in THIS referencing file change vs HEAD?
    ver_head=$(git show "HEAD:$REF_FILE" 2>/dev/null \
      | grep -oE "$(basename "$rel")\?v=[0-9]+" | head -1 | grep -oE '[0-9]+$' || true)

    if [ -n "$ver_head" ] && [ "$ver_now" = "$ver_head" ]; then
      echo "✗ $path changed but $REF_FILE still says ?v=$ver_now — bump it there"
      fail=1
    fi
  done <<< "$assets"
done

if [ "$fail" -eq 0 ]; then
  echo "✓ cache-busters OK (every changed ?v='d asset had its version bumped in every referencing file)"
fi
exit $fail
