#!/usr/bin/env bash
# Manuscript Studio — NUKE DATABASE
#
# Drops every table in the public schema, including Liquibase's
# DATABASECHANGELOG/DATABASECHANGELOGLOCK tables, so install.sh can
# run migrations from scratch.
#
# DESTRUCTIVE. Irreversible without a backup.

set -euo pipefail

CONFIG_FILE="$HOME/.config/manuscript-studio/config.yaml"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

if [[ ! -f "$CONFIG_FILE" ]]; then
    log_error "Config not found at $CONFIG_FILE. Run install.sh first."
fi

get_config() {
    grep "^[[:space:]]*$1:" "$CONFIG_FILE" | head -1 | sed "s/.*$1:[[:space:]]*[\"']*\([^\"']*\)[\"']*/\1/"
}

DB_HOST=$(get_config "host")
DB_PORT=$(get_config "port")
DB_NAME=$(get_config "name")
DB_USER=$(get_config "user")
DB_PASSWORD=$(get_config "password")

echo ""
echo -e "${RED}========================================${NC}"
echo -e "${RED}         NUKE DATABASE WARNING${NC}"
echo -e "${RED}========================================${NC}"
echo ""
echo "This will permanently destroy ALL data in:"
echo "  Host:     $DB_HOST:$DB_PORT"
echo "  Database: $DB_NAME"
echo "  User:     $DB_USER"
echo ""
echo "All tables (including Liquibase tracking) will be dropped."
echo "This action CANNOT be undone. Backups are your responsibility."
echo ""

read -rp "Proceed? [y/N]: " response1
if [[ ! "$response1" =~ ^[Yy]$ ]]; then
    log_info "Aborted."
    exit 0
fi

read -rp "Type the database name ($DB_NAME) to confirm: " response2
if [[ "$response2" != "$DB_NAME" ]]; then
    log_error "Database name did not match. Aborted."
fi

log_warn "Nuking database..."

PGPASSWORD="$DB_PASSWORD" psql \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO $DB_USER; GRANT ALL ON SCHEMA public TO public;" \
    || log_error "Failed to drop/recreate schema"

log_info "Database nuked. Run install.sh to rebuild the schema."
