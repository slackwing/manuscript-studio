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

## Useful commands

```bash
docker logs -f manuscript-studio-dev-server   # tail server logs
debug/connect_db.sh                           # psql into the dev DB
debug/nuke_database.sh                        # wipe + recreate the dev DB schema
curl http://127.0.0.1:5001/livez              # liveness probe
curl http://127.0.0.1:5001/readyz             # readiness probe (checks DB + repos)
```

## Code-review remediation

The `CODE_REVIEW_PLAN.md` at repo root tracks the v1 cleanup work. Most items are done; a few are deferred (audit logging, multi-manuscript docs vs code reconciliation, configurable segmenter version) — see the "Skipped" header and the `DEFERRED` notes.
