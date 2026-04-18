#!/usr/bin/env bash
# Manuscript Studio — open a psql shell against the configured database.

set -euo pipefail

CONFIG_FILE="$HOME/.config/manuscript-studio/config.yaml"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Config not found at $CONFIG_FILE" >&2
    exit 1
fi

get_config() {
    grep "^[[:space:]]*$1:" "$CONFIG_FILE" | head -1 | sed "s/.*$1:[[:space:]]*[\"']*\([^\"']*\)[\"']*/\1/"
}

DB_HOST=$(get_config "host")
DB_PORT=$(get_config "port")
DB_NAME=$(get_config "name")
DB_USER=$(get_config "user")
DB_PASSWORD=$(get_config "password")

echo "Connecting to $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
PGPASSWORD="$DB_PASSWORD" exec psql \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" "$@"
