#!/usr/bin/env bash
# Manuscript Studio — mint a single-use invite code (default 365 days).
# Usage: ./mint_invite.sh [note] [days]
# Uses the system token from the configured config.yaml, against localhost.

set -euo pipefail

CONFIG_FILE="$HOME/.config/manuscript-studio/config.yaml"
NOTE="${1:-}"
DAYS="${2:-365}"

TOKEN=$(grep -A5 '^auth:' "$CONFIG_FILE" | grep 'system_token:' | head -1 | sed "s/.*system_token:[[:space:]]*[\"']*\([^\"']*\)[\"']*/\1/")
PORT=$(grep -A5 '^server:' "$CONFIG_FILE" | grep 'port:' | head -1 | sed 's/.*port:[[:space:]]*//')

curl -sf -X POST "http://localhost:${PORT:-8080}/api/admin/invites" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"days\": $DAYS, \"note\": \"$NOTE\"}"
echo
