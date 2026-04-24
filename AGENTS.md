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

### N8 — Vendored libraries — DO NOT EDIT

These files are vendored from external repos. NEVER edit them here —
re-vendor instead via the script.

| File | Source | Vendor script |
|------|--------|---------------|
| `internal/segman/segman.go` | github.com/slackwing/segman | `scripts/vendor-segman.sh` |
| `internal/segman/VERSION.json` | github.com/slackwing/segman | (same) |
| `web/js/segman.js` | github.com/slackwing/segman | (same) |
| `web/js/rainbow-slice.js` | github.com/slackwing/tuft | `scripts/vendor-tuft.sh` |

Provenance stamps live next to the vendored files
(`internal/segman/UPSTREAM`, `web/js/TUFT_UPSTREAM`). PR review can
read them to see "what got vendored when, from what ref."

The Go and JS segmenters MUST split sentences identically, or sentence
IDs will mismatch between browser and server and DOM wrapping will
silently fail. Both come from the same upstream so this is enforced
upstream — but if you ever bump one without the other, you'll find out
the hard way.

`internal/segman/version.go` is hand-written (NOT vendored): it
go:embeds VERSION.json so the segmenter version flows into
`migrations.SegmenterVersion` automatically on re-vendor. See
PERSONAL_VENDORING_PLAN.md §4.

### N9 — Render order in renderer.js is load-bearing

In `web/js/renderer.js renderManuscript()` the order MUST be:

```
wrapSentences() → applyAnnotations() → WriteSysSuggestions.applyToSpans() → smartquotes.element()
```

If `smartquotes` runs before `applyToSpans`, the DOM has curly apostrophes
while the suggestion text has straight ones, and diff-match-patch reports
every apostrophe as a spurious diff. Don't reorder.

### N10 — Classify every new tests/*.js file

`test-all.sh` has two arrays at the top (`FAST_TESTS`, `SLOW_TESTS`). When
you add `tests/test-foo.js`, add `test-foo` (basename, no `.js`) to whichever
is appropriate. The script's sanity check refuses to run if anything is
unclassified. Threshold: ≤15 s wall time = `fast`, otherwise `slow`.

### N11 — Suggestions FK to sentences in tests

`suggested_change.sentence_id` FKs to `sentence`. If your test creates
suggestions, **delete them before calling `cleanupTestAnnotations()`** or
the FK will block the cascading sentence delete and the test that follows
yours will run on dirty data.

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
api/             HTTP handlers (admin, annotations, auth, migrations, suggestions)
cmd/server/      Main server entrypoint
cmd/admin-upsert/ One-shot: seed the admin user from config
internal/        Core logic: config, database, auth, migrations, sentence,
                 segmenter (vendored — see N8), fractional, models
liquibase/       Database schema (frozen 001 + numbered changesets)
web/             Frontend (vanilla JS, no build step)
  js/vendor/     diff-match-patch.js (whitelisted in .gitignore)
tests/           Playwright + Node test suite (classified in test-all.sh)
testdata/        Fixtures (test.manuscript + init script)
debug/           User-facing debugging scripts (nuke_database.sh, connect_db.sh)
old/             Archived one-shot tools (see old/README.md)
install.sh       One-liner installer
Makefile         Dev workflow targets
test-all.sh      Test runner (fast/slow/all/js-only)
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

### Test split (fast / slow / all)

| Command | Wall time | Use when |
|---------|-----------|----------|
| `make test-fast` | ~2.5 min | Inner dev loop |
| `make test-slow` | ~7 min | Before committing UI-heavy changes |
| `make test` | ~10 min | Before pushing |

When you add a test file, **classify it** in `FAST_TESTS` or `SLOW_TESTS`
in `test-all.sh` (see N10).

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

## 7. Recent subsystems — quick reference

These were added in 2026-04 and are easy to miss. Full detail in
ARCHITECTURE.md §6.5–§6.7.

- **Sentence history** (`previous_sentence_id` column + `history.js` +
  `GET /api/migrations/{id}/history`). The column is the **lynchpin of
  cross-commit identity** — any code that asks "what was this sentence
  before?" should walk this chain (or use `bestPreviousByNew` in the
  processor). Don't re-implement matching.
- **Suggested edits** (`suggested_change` table + `suggestions.js` +
  `PUT/DELETE /api/sentences/{id}/suggestion` + `GET /api/migrations/{id}/suggestions`).
  Re-clicking the selected sentence opens the modal. Diff is rendered
  inline using `web/js/vendor/diff-match-patch.js`. See N9 for the render
  order.
- **Annotation completion** (`completed_at` column + green checkmark UI +
  `POST /api/annotations/{id}/complete`). Filtered from reads, just like
  `deleted_at`.
- **Push-to-PR** (`web/js/push.js` split-button + `internal/sentence/apply.go`
  + `internal/migrations/git.go WriteCommitPushBranch` +
  `POST /api/manuscripts/{id}/migrations/{mid}/push-suggestions`). User
  pushes their suggestions as a `suggestions-{shortSHA}-{user}` branch on
  the manuscript repo's `origin`. Commits are written via git plumbing so
  the working tree/HEAD are untouched. See ARCHITECTURE.md §6.8 and
  `PUSH_FEATURE_PLAN.md`.
- **401 → login redirect** (`web/js/auth.js authenticatedFetch`) — any
  401 response sends the user to `login.html` so an expired session can't
  silently break the UI.
- **Manuscript picker + access guard** (`web/js/picker.js` top-bar
  dropdown; `api/handlers/access.go` `requireManuscriptAccess*`). Manuscript
  is no longer baked into the session — it's URL-driven via
  `?manuscript_id=N`. Every per-manuscript endpoint (handlers in
  `migrations.go`, `suggestions.go`, `annotations.go`) calls one of the
  `requireManuscriptAccess*` helpers; they 404 on access miss to avoid
  existence leaks. Last-opened manuscript is persisted on the user row so
  the next login lands on it.
- **Confidence == 1.0** (in `internal/migrations`): the gate for
  copy-forward of suggestions on a pairing. Annotations carry forward at
  any confidence; suggestions only at exact-text match.

Schema migrations 002–006 (status, sessions, completed, prev-sentence,
suggested_change) are all live. 001 is frozen — see §3.

### Deploying

When the user asks you to deploy, run `./remote-deploy.sh` from the repo
root. It SSHes to a pre-configured host alias whose key is locked down
on the VM via `command="..."` to run only the install one-liner — you
cannot get a shell or any other access through it. If the user hasn't
set up the SSH host alias yet, point them at the header of
`remote-deploy.sh` for the one-time setup steps. If the script's missing
or the SSH alias isn't configured, ask the user to deploy manually
rather than guessing at credentials.

---

## 8. Tone / meta

- If anything here conflicts with the code, the code wins. Propose updates
  to this file instead of diverging.
- If you're unsure, ask the user rather than guessing.
- Keep this file terse. Agents skim; walls of prose get ignored.
