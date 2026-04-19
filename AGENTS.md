# Agent Instructions

For AI coding agents (Claude Code, Cursor, etc.) working on this repo.

---

## 🚨 CRITICAL NOTICES — READ FIRST 🚨

### N1 — Never modify schema outside Liquibase

No `ALTER TABLE` / `CREATE TABLE` in Go code, no manual `psql` schema
changes. All schema changes go through a new changeset under
`liquibase/changelog/` (see §3).

Violation = failed task.

### N2 — Every change needs a test

No exceptions. See §4. If you fix a bug, first write a test that
reproduces it, then fix.

Violation = failed task.

### N3 — Update `install.sh` → bump `SCRIPT_VERSION`

The script is distributed via `curl | bash` and GitHub's CDN caches it for
several minutes. The version string printed at the top of each run lets the
user confirm they got the edit, not a cached copy.

Format: `YYYY-MM-DD.N`. If today's date is used, increment `.N`; if newer
date, reset `.N` to `1`. Bump on every change, even trivial ones.

### N4 — Never reference `the-wildfire` in this repo

`the-wildfire.manuscript` is the user's private working document on the
production VM. It must not appear in `testdata/`, `tests/`, `config.dev.yaml`,
or anywhere else in this repo. If you see it, delete it.

Tests use **`test-manuscripts`** with **`manuscript_id=1`**.

### N5 — Playwright must run headless

Every `chromium.launch(...)` call: `{ headless: true }`. Tests run under
`make test` and need to work without a display.

### N6 — Don't create `debug-*.js` / `one-off-*.js` test files

Use existing test files, or add a properly-named `test-<feature>.js`. No
throwaway scripts.

### N7 — Don't use CSS `scale()` for sizing

When making an element bigger or smaller on hover/focus/state change,
recalculate explicit dimensions in px/em/rem. `scale()` breaks positioning in
nested absolute layouts — especially with floating sticky-note / annotation
margin elements.

```css
/* ❌ DON'T */
.circle:hover { transform: scale(1.2); }

/* ✅ DO */
.circle { width: 22px; height: 22px; }
.circle:hover { width: 26px; height: 26px; } /* 22 × 1.18 */
```

### N8 — Segmenter parity

If you touch `web/js/segmenter.js`, you must also update
`internal/segmenter/segman.go` (or vice versa). Both must split sentences
identically, or sentence IDs will mismatch between browser and server and
DOM wrapping will silently fail. The canonical source is the
[segman](https://github.com/slackwing/segman) project; copy the current
version into both locations when upgrading.

---

## 1. Core principles

1. **Markdown in git is the source of truth** — annotations are a layer on top.
2. **Sentences get new IDs when edited** — no false lineage; the migration
   algorithm tracks lineage separately with confidence scores.
3. **Append-only annotation history** — never hard-delete, only soft-delete.
4. **Heuristic migration with confidence** — users review/fix low-confidence
   matches manually; we don't pretend the match is certain.
5. **Tests are a specification** — if a test fails, fix the code. If the test
   is obsolete, ask the user before deleting.

---

## 2. Quick orientation

```
api/             HTTP handlers
cmd/server/      Main server entrypoint
cmd/admin-upsert/ One-shot: seed the admin user from config
internal/        Core logic: config, database, auth, migrations, sentence,
                 segmenter, fractional, models
liquibase/       Database schema
web/             Frontend (vanilla JS, no build step)
tests/           Playwright + Node test suite
testdata/        Fixtures (test.manuscript + init script)
debug/           User-facing debugging scripts (nuke_database.sh, connect_db.sh)
install.sh       One-liner installer
Makefile         Dev workflow targets
config.dev.yaml  Committed dev config (works out of the box)
ARCHITECTURE.md  How the pieces fit together
```

Full layout and design in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 3. Database schema changes

`001-initial-schema.xml` is **FROZEN** (as of 2026-04-19). Do not edit it.

Every schema change is a new changeset:
- File: `liquibase/changelog/NNN-description.xml` (increment `NNN`).
- Wire it in: add `<include file="changelog/NNN-description.xml"/>` to
  `db.changelog-master.xml`.
- Verify locally: `make db-reset && make db-migrate`.
- Add or update tests for the new schema.

---

## 4. Testing

### Workflow for any code change

1. **Before coding:** write a failing test.
2. **While coding:** run the most-relevant test file.
3. **After finishing:** all tests pass.
4. **Before committing:** `./test-all.sh`.

When you discover a bug:
1. Write a test that reproduces it → verify it fails.
2. Fix the bug → verify test passes.
3. Commit test and fix together.

### Where to put tests

| Kind | Location | Run via |
|------|----------|---------|
| Gatekeeper UI integration | `tests/ui-integration.js` | `./test-all.sh` or `node tests/ui-integration.js` |
| Smoke | `tests/smoke.js` | `node tests/smoke.js` |
| Feature (tags, trash, rainbow, etc.) | `tests/test-*.js` or `tests/*-test.js` | `node tests/<name>.js` |
| Go unit | `internal/**/*_test.go` | `go test ./...` |

### Helpers

Use `tests/test-utils.js`:
- `TEST_MANUSCRIPT_ID` (`1`) and `TEST_MANUSCRIPT_NAME` (`"test-manuscripts"`)
- `TEST_URL` — pre-built URL with the right manuscript_id
- `TEST_USERNAME` / `TEST_PASSWORD` (both `"test"`)
- `loginAsTestUser(page)` — logs in with the test user
- `cleanupTestAnnotations()` — wipes annotation data, re-bootstraps the test
  manuscript via the admin API

### When a test fails

- **Test is outdated** → update it to match current intended behavior
- **Test is irrelevant** → ask the user whether to delete it
- **Code broke something** → fix the code, NOT the test

### Backend verification without a browser

If you can't open a browser:
- Check server logs: `docker logs manuscript-studio-dev-server`
  (or the native process's stdout).
- Hit endpoints directly: `curl http://127.0.0.1:5001/api/migrations/latest?manuscript_id=1`.
- Use `debug/connect_db.sh` to run SQL against the dev DB.

---

## 5. Local dev

Two flows, both in the `Makefile`:

**Fast iteration (native Go server):**
```bash
make dev          # terminal 1 — starts Postgres + builds + runs server
make test         # terminal 2 — resets DB, seeds, runs gatekeeper tests
```

**Production-fidelity (full Docker install flow):**
```bash
make dev-install    # runs ./install.sh --dev end-to-end
make test-install   # runs tests against the containerized server
```

Namespaces and defaults:
- Dev config: `~/.config/manuscript-studio-dev/`
- Dev DB: `localhost:5433` (non-default port; won't collide)
- Dev server: `http://127.0.0.1:5001/`
- Admin user: `admin` / `admin`  •  Test user: `test` / `test`

Dev env vars the server understands:
- `MANUSCRIPT_STUDIO_CONFIG_FILE` — explicit config path (bypasses default
  search paths)
- `MANUSCRIPT_STUDIO_REPOS_DIR` — where manuscript repos are stored
  (overrides the Docker-mount default of `/repos`)

---

## 6. Key design decisions

Documented more fully in [ARCHITECTURE.md](./ARCHITECTURE.md). Highlights:

- **Single Go binary** for server + static files. No separate web server
  process.
- **PostgreSQL outside Docker** — managed by the user (GCP Cloud SQL in prod,
  docker-compose Postgres in dev). Data durability wins.
- **API-integrated migration** — the GitHub webhook and the manual
  `/api/admin/sync` call both enter through the same code path
  (`api/handlers/admin.go:processMigration`).
- **Base-path-aware** — `server.base_path` config switches between subdomain
  hosting and path-prefix hosting; middleware strips the prefix and the
  server injects `<base href>` into HTML responses.
- **Timing-safe, enumeration-safe auth** — all login failures return the
  same "Invalid credentials" message; bcrypt runs even for unknown users.

---

## 7. Tone / meta

- If anything here conflicts with the code, the code wins. Propose updates
  to this file instead of diverging.
- If you're unsure, ask the user rather than guessing.
- Keep this file terse. Agents skim; walls of prose get ignored.
