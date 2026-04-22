#!/usr/bin/env bash
# Re-runs the public install one-liner. Idempotent on a healthy install.
# Kept in sync with the README install instructions.
set -euo pipefail
bash <(curl -sSL -H "Cache-Control: no-cache" "https://raw.githubusercontent.com/slackwing/manuscript-studio/main/install.sh")
