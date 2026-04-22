# Development Guide

## Prerequisites

- Go 1.23+
- Docker (for Postgres in dev, full container build for prod-fidelity testing)
- Node + Playwright (for the test suite — `npm install` in repo root)
- `psql` (for `cleanupTestAnnotations` and `debug/connect_db.sh`)

## Two dev modes

Both live in the `Makefile`.

**Fast iteration** — native Go server, Postgres in Docker:
```bash
make dev          # terminal 1 — Postgres up, native binary up
make test         # terminal 2 — runs gatekeeper Playwright tests
```

**Production-fidelity** — exercises the full install path (Docker image build + container):
```bash
make dev-install
make test-install
```

## Defaults

- Dev config: `~/.config/manuscript-studio-dev/`
- Dev DB: `localhost:5433` (deliberately non-default to coexist with prod Postgres)
- Dev server: `http://127.0.0.1:5001/`
- Admin user: `admin` / `admin`
- Test user: `test` / `test`
- Test manuscript: `test-manuscripts` (manuscript_id `1`)

`config.dev.yaml` is committed and works out of the box. Its weak credentials are intentional and would be rejected by `Validate()` if you ever pointed it at `env: production`.

## TLS in production

The server speaks plain HTTP and expects to be terminated by a reverse proxy (Apache/Nginx). It sets `Strict-Transport-Security` only when `server.env == "production"`. In dev mode session cookies are sent without `Secure` so localhost works without HTTPS — production sets `Secure`.

## Adding a database changeset

`liquibase/changelog/001-initial-schema.xml` is **frozen** as of 2026-04-19 — never edit it. New schema goes in a new file:

1. Create `liquibase/changelog/NNN-description.xml` (next free `NNN`).
2. Add `<include file="changelog/NNN-description.xml"/>` to `db.changelog-master.xml`.
3. Run `make db-reset && make db-migrate` to verify it applies cleanly.
4. Add or update tests for any new tables/columns.

## Where to put tests

| Kind | Location | Run via |
|------|----------|---------|
| Go unit | `internal/**/*_test.go`, `api/handlers/*_test.go` | `go test ./...` |
| UI integration (gatekeeper) | `tests/ui-integration.js` | `./test-all.sh` |
| Smoke | `tests/smoke.js` | `node tests/smoke.js` |
| Feature | `tests/test-*.js` | `node tests/<name>.js` |

Playwright must run headless (`headless: true`) — `make test` runs in CI without a display.

## Fast vs slow test split

`test-all.sh` accepts a mode arg, exposed via Make targets:

| Target | Mode | Wall time | Notes |
|--------|------|-----------|-------|
| `make test-fast` | `fast` | ~2.5 min | Inner dev loop — assumes server already has state. |
| `make test-slow` | `slow` | ~7 min | UI-heavy flows: history bars, suggestions, scrollable notes, multi-stage tag UI, etc. |
| `make test` | `all` | ~10 min | Resets DB, seeds, bootstraps, runs Go + everything. |
| `./test-all.sh js-only` | `js-only` | varies | Skips Go (server must be up). |

Two arrays at the top of `test-all.sh` (`FAST_TESTS`, `SLOW_TESTS`) enumerate every test by basename. Threshold: ≤15 s wall = `fast`, otherwise `slow`. The script's sanity check refuses to run if any `tests/*.js` (other than `test-utils.js`) is unclassified — so when you add a test, classify it.

## Useful commands

```bash
docker logs -f manuscript-studio-dev-server   # tail server logs
debug/connect_db.sh                           # psql into the dev DB
debug/nuke_database.sh                        # wipe + recreate the dev DB schema
curl http://127.0.0.1:5001/livez              # liveness probe
curl http://127.0.0.1:5001/readyz             # readiness probe (checks DB + repos)
```

## One-off CLI tools

### `backfill-prev-sentence`

Populates `sentence.previous_sentence_id` for manuscripts whose migrations were created before the history feature shipped. Idempotent; pairings that can't be re-derived stay `NULL` (the history feature degrades cleanly).

```bash
# Production (containerized):
docker run --rm --network host \
  -v $CONFIG_FILE:/config/config.yaml:ro \
  manuscript-studio:latest \
  backfill-prev-sentence --manuscript=NAME [--dry-run]

# Dev (native binary):
go run ./cmd/backfill-prev-sentence --manuscript=test-manuscripts [--dry-run]
```

## Code-review remediation

The `CODE_REVIEW_PLAN.md` at repo root tracks the v1 cleanup work. Most items are done; a few are deferred (audit logging, multi-manuscript docs vs code reconciliation, configurable segmenter version) — see the "Skipped" header and the `DEFERRED` notes.
