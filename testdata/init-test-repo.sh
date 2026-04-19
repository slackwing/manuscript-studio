#!/usr/bin/env bash
# Materialize the test manuscript as a fresh git repo at the dev repos path.
# This gives tests a clean, identical starting state every run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_NAME="${1:-test-manuscripts}"
DEV_CONFIG_DIR="${MANUSCRIPT_STUDIO_DEV_CONFIG_DIR:-$HOME/.config/manuscript-studio-dev}"
REPO_DIR="$DEV_CONFIG_DIR/repos/$REPO_NAME"

echo "Materializing test manuscript repo at: $REPO_DIR"

rm -rf "$REPO_DIR"
mkdir -p "$REPO_DIR"

cp "$SCRIPT_DIR/manuscripts/test.manuscript" "$REPO_DIR/"

git -C "$REPO_DIR" init -q -b main
git -C "$REPO_DIR" -c user.email=test@example.com -c user.name=Test add -A
git -C "$REPO_DIR" -c user.email=test@example.com -c user.name=Test commit -q -m "Initial test manuscript"

echo "Test repo ready. HEAD: $(git -C "$REPO_DIR" rev-parse --short HEAD)"
