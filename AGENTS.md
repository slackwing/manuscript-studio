# Agent Instructions

Instructions for AI coding agents (Claude Code, Cursor, etc.) working on this repo.

## 🚨 CRITICAL TEST RULES — READ FIRST 🚨

### Write tests for EVERYTHING

**Every feature, fix, or change MUST have tests. No exceptions.**

**Workflow:**
1. **Before coding:** write a failing test that demonstrates the issue or desired behavior
2. **While coding:** run the most-relevant test file to verify progress
3. **After finishing:** all tests pass
4. **Before committing:** run `./test-all.sh`

**When you discover a bug:**
1. Immediately write a test that reproduces it
2. Verify the test fails
3. Fix the bug
4. Verify the test passes
5. Commit test and fix together

**If you ship code without tests, you have failed the task.**

### Test manuscript rules

Manuscript Studio's dev environment has **one** configured manuscript:
**`test-manuscripts`** with **`manuscript_id=1`**. Tests use this.

The real `the-wildfire` manuscript lives on the production VM only and **must
never** be referenced from this repo's tests or fixtures. If you see
`the-wildfire` anywhere in `testdata/`, `config.dev.yaml`, or `tests/`,
delete it.

### Headless mode is required

Playwright browser launches in tests **MUST** use `{ headless: true }`. The
tests are meant to run under `make test` and in CI; headed browsers break
that.

### Test file organization

**Gatekeeper tests** (run by `./test-all.sh`):
- `tests/ui-integration.js` — visual rendering, Paged.js, layout, core UI
  flows. This is the most important test file; it catches layout regressions.

**Feature tests** (`tests/test-*.js`, `tests/*-test.js`):
- Standalone node scripts, each covering a feature (tags, rainbow bars, trash
  icons, etc.). Run individually with `node tests/<name>.js`.
- New test files should use the `TEST_URL` / `loginAsTestUser` /
  `cleanupTestAnnotations` helpers from `tests/test-utils.js`.

**Go unit tests** (`internal/**/*_test.go`):
- Pure Go, run with `go test ./...`. No server required.

### Do NOT create debug-* or one-off test files

Use the existing test files. If you need to investigate a bug, write a
repeatable test against it and check it in, not a throwaway script.

### When tests fail

- **Test is outdated** → update it to match current behavior
- **Test is irrelevant** → ask the user whether to delete it
- **Code broke something** → fix the code, NOT the test

Never let tests diverge from the codebase.

---

## Local dev environment

Two flows, both documented in the `Makefile`:

**Fast iteration (native Go server):**
```bash
make dev          # in one terminal — starts Postgres + server
make test         # in another — resets DB, seeds, runs tests
```

**Production-fidelity (Docker-packaged server via install.sh):**
```bash
make dev-install  # runs ./install.sh --dev end-to-end
make test-install # same tests, against the containerized server
```

Dev config namespace: `~/.config/manuscript-studio-dev/`
Dev DB: `localhost:5433` (not the default 5432, to avoid collision)
Dev server: `http://127.0.0.1:5001/`
Test user: `test` / `test`

---

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

---

## Database schema changes MUST go through Liquibase

**Never modify schema directly via `ALTER TABLE` or `CREATE TABLE` in code.**
All schema changes must be new Liquibase changesets under
`liquibase/changelog/`.

**Required workflow for schema changes:**
1. Create new changelog `liquibase/changelog/NNN-description.xml` (increment N)
2. Add `<include file="changelog/NNN-description.xml"/>` to `db.changelog-master.xml`
3. Run `make db-migrate` against a fresh database to verify it applies cleanly
4. Add or update tests for the new schema

**Pre-release exception:** The initial schema is consolidated in `001-initial-schema.xml`. Once this project has real users, never edit 001 — every future change is a new changeset. Appending is the law.
