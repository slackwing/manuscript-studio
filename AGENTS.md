# Agent Instructions

Instructions for AI coding agents (Claude Code, Cursor, etc.) working on this repo.

## install.sh version bump (MANDATORY)

Whenever you modify `install.sh`, you MUST bump `SCRIPT_VERSION` at the top of the file in the same change.

**Why:** The script is fetched via `curl | bash` from GitHub, which is cached aggressively by GitHub's CDN (up to several minutes). The user needs to see the version string printed at the top of each run to confirm they're running the intended version, not a stale cached copy.

**Format:** `YYYY-MM-DD.N`
- `YYYY-MM-DD` — today's date
- `N` — increments within the same day, starting at `1`

**Examples:**
- First edit on 2026-04-18 → `2026-04-18.1`
- Second edit the same day → `2026-04-18.2`
- First edit the next day → `2026-04-19.1`

**How to apply:**
1. Before you finish editing `install.sh`, update the `SCRIPT_VERSION="..."` line near the top.
2. If the current date's version already exists, increment `.N`.
3. If a newer date exists, use today's date with `.1`.
4. Never leave the version unchanged when the script is modified, even for trivial edits — the point is to prove the fetched version matches the edit.
