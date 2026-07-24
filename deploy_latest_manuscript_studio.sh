#!/usr/bin/env bash
# Re-runs the public install one-liner. Idempotent on a healthy install.
#
# Downloads install.sh to a temp file first (rather than streaming it into
# bash) so a mid-transfer disconnect can't execute a truncated script.
# -f makes curl fail on HTTP errors instead of piping an error page to bash.
# Executing the downloaded file with `bash "$tmp"` keeps stdin attached to
# the terminal, which install.sh's prompt_yn relies on.
set -euo pipefail
tmp=$(mktemp /tmp/manuscript-studio-install.XXXXXX)
trap 'rm -f "$tmp"' EXIT
curl -fsSL -H "Cache-Control: no-cache" \
    "https://raw.githubusercontent.com/slackwing/manuscript-studio/main/install.sh" \
    -o "$tmp"
bash "$tmp"
