#!/usr/bin/env bash
# seed-user.sh — upsert a user + grant access to a manuscript via the admin API.
#
# Usage:
#   scripts/seed-user.sh <username> <password> <manuscript_name> [server_url]
#
# Defaults:
#   server_url = http://127.0.0.1:5001
#
# Reads the system token from the dev config by default. Override with
# SYSTEM_TOKEN=... to point at a prod config / remote server.
#
# Examples:
#   # local dev
#   scripts/seed-user.sh andrew 's3cret' the-wildfire
#
#   # remote (run on the VM that has access to the config)
#   SYSTEM_TOKEN=... scripts/seed-user.sh andrew 's3cret' the-wildfire http://127.0.0.1:5001

set -euo pipefail

USERNAME="${1:?username required}"
PASSWORD="${2:?password required}"
MANUSCRIPT="${3:?manuscript_name required}"
SERVER="${4:-http://127.0.0.1:5001}"

if [ -z "${SYSTEM_TOKEN:-}" ]; then
    CONFIG="${MANUSCRIPT_STUDIO_CONFIG_FILE:-config.dev.yaml}"
    if [ ! -f "$CONFIG" ]; then
        echo "ERROR: no SYSTEM_TOKEN env var and config file $CONFIG not found." >&2
        exit 1
    fi
    SYSTEM_TOKEN=$(grep system_token "$CONFIG" | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
fi

curl -sf -X POST "$SERVER/api/admin/users" \
    -H "Authorization: Bearer $SYSTEM_TOKEN" -H "Content-Type: application/json" \
    -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\",\"role\":\"author\"}" >/dev/null

curl -sf -X POST "$SERVER/api/admin/grants" \
    -H "Authorization: Bearer $SYSTEM_TOKEN" -H "Content-Type: application/json" \
    -d "{\"username\":\"$USERNAME\",\"manuscript_name\":\"$MANUSCRIPT\"}" >/dev/null

echo "Created/updated user '$USERNAME' with access to '$MANUSCRIPT'."
