#!/usr/bin/env bash
#
# check-cache-busters.sh — fail if a cache-busted web asset changed vs. the
# last commit but its ?v= in web/index.html was NOT bumped.
#
# The trap this prevents: editing web/css/book.css (or any ?v='d JS) without
# bumping its ?v= means browsers keep serving the OLD cached file even after
# deploy — the change silently doesn't reach users. This bit us with the
# title/part page-break CSS (book.css edited across 3 commits, ?v=86 never
# bumped → looked broken on the live site until the cache was disabled).
#
# Run before committing web changes:  scripts/check-cache-busters.sh
# Exits 0 if clean, 1 (with a list) if any asset drifted without a bump.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
INDEX="web/index.html"

if ! git rev-parse HEAD >/dev/null 2>&1; then
  echo "no commits yet; skipping cache-buster check"
  exit 0
fi

fail=0

# Every asset referenced with ?v=N in index.html.
assets=$(grep -oE '(css|js)/[A-Za-z0-9._/-]+\.(css|js)\?v=[0-9]+' "$INDEX" | sort -u)

while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  path="web/${ref%%\?v=*}"          # web/css/book.css
  ver_now="${ref##*\?v=}"           # 87
  [ -f "$path" ] || continue        # vendored/absent — skip

  # Did the file content change vs HEAD?
  if git diff --quiet HEAD -- "$path"; then
    continue                        # unchanged → nothing to check
  fi

  # File changed. Did its ?v= change vs HEAD's index.html?
  ver_head=$(git show "HEAD:$INDEX" 2>/dev/null \
    | grep -oE "${ref%%\?v=*}\?v=[0-9]+" | head -1 | grep -oE '[0-9]+$' || true)

  if [ -n "$ver_head" ] && [ "$ver_now" = "$ver_head" ]; then
    echo "✗ $path changed but its cache-buster is still ?v=$ver_now — bump it in $INDEX"
    fail=1
  fi
done <<< "$assets"

if [ "$fail" -eq 0 ]; then
  echo "✓ cache-busters OK (every changed ?v='d asset had its version bumped)"
fi
exit $fail
