# Code Review Plan

Working document for executing the v1 code-review remediations. Items are ordered by severity. Each task has enough context to be picked up cold.

> **STATUS (2026-04-19):** All non-skipped items below are **complete**. The
> per-task checkboxes below were NOT individually ticked during execution —
> see git history for the actual changes. The headline notes:
>
> - Schema: changeset 002 (migration status) and 003 (sessions) added; 001 frozen.
> - Security: PAT removed from URLs (#1), login made timing-safe (#2), XSS in annotations + manuscript content fixed (#3), config placeholders rejected at startup (#5), system token uses constant-time compare (#7), webhook returns 403 + logs failures (#8), `<base href>` escaped + validated (#9), HSTS in prod (#11), repo paths constrained to `repos_dir` (#12).
> - Reliability: migrations now status-tracked end-to-end (#4), DB-backed sessions with sliding-window refresh (#6), admin rate limiting (#10), 1 MiB body cap (#13), `/livez` + `/readyz` (#24), startup recovery for stuck migrations.
> - Quality of life: password validation centralized (`auth.ValidatePassword`, min 4) (#15), slog adopted with per-request logger (#25), `GetBranchName` returns errors (#20), dead `database.NewDB` removed (#22), Content-Type-guarding `fetchJSON` helper added (#19), six docs created in `docs/` (#18).
> - Tests added: handler auth, system-token check, webhook signature, password validation, config validation (placeholders, `repos_dir`, `base_path`), git token-leak guard, commit-ref validator, rate limiter, error truncation, plus a Playwright XSS regression test.

**Skipped (per user):** #14 (audit logging — defer), #17 (multi-manuscript docs/code reconciliation), #21 (hardcoded segmenter version / branch name).

**Resolved design questions:**
- **#4 status tracking (Option B):** Reuse the existing `migration` table as the status row. Insert at `pending`/`running` *before* work starts; update to `done` or `error` when finished. Add `status`, `started_at`, `finished_at`, `error` columns; loosen NOT NULL on result columns (`sentence_count`, `sentence_id_array`, etc.). The existing unique constraint on `(manuscript_id, commit_hash, segmenter)` enforces the "already in progress → 409" check for free. **Risk to manage:** every query that joins `migration` and assumes the row means "fully processed" must add `WHERE status = 'done'`. Audit and fix as part of this task.
- **#12 "configured root":** Add `repos_dir` to config. At startup, every `GitRepository.Path` must resolve (after `filepath.Clean`) to a path inside `repos_dir`. Fail to start otherwise.
- **#15 password rules:** Min length **4**. No common-password check. No other constraints. ("test" must still work.)
- **#16 schema freeze:** `001-initial-schema.xml` is frozen as of this plan. All future schema changes go in new changesets (`002-*.xml`, `003-*.xml`, …).

---

## Master task list

Work top-to-bottom. Each task is independently committable. Mark `[x]` when done.

### #1 — GitHub PAT in clone URL [Critical / Security]
**Where:** `internal/migrations/git.go:162-175` (`getAuthenticatedURL`)
**Problem:** Token is interpolated into `https://TOKEN@github.com/...`, leaking into `ps`, error messages, and container logs.

- [ ] Decide on credential mechanism. Recommended: git credential helper writing to an in-memory store, OR `GIT_ASKPASS` script that reads token from an env var. SSH is cleanest but requires key mounting and changes deployment story — pick credential helper for now.
- [ ] Remove `getAuthenticatedURL` entirely.
- [ ] Add a small helper that runs git with `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=<helper>`, and the token passed via env var (never argv).
- [ ] Update `Clone`, `Pull`, `Fetch` paths in `internal/migrations/git.go` to use the new helper.
- [ ] Audit all `log.Printf` / error wrapping in `internal/migrations/git.go` to ensure no path can format a URL containing the token.
- [ ] Add a unit test that runs a fake git command and asserts the token never appears in argv or in returned error strings.

---

### #2 — Login is not actually timing-safe [Critical / Security]
**Where:** `api/handlers/auth.go:58-87`
**Problem:** Bcrypt is only run on the user-exists branch, so timing reveals whether a username exists.

- [ ] Define a package-level `dummyHash` constant (precomputed bcrypt of an arbitrary string at the same cost factor as real hashes).
- [ ] Refactor `HandleLogin`:
  - Look up user.
  - Pick `hashToCompare := user.PasswordHash if user != nil else dummyHash`.
  - Always call `auth.VerifyPassword(req.Password, hashToCompare)`.
  - Then evaluate `userExists && passwordValid && hasAccess` and return one generic error for any failure.
- [ ] Make sure the response body and status code are identical for "no such user", "wrong password", and "no access".
- [ ] Add a test that times 100 logins against a real user vs 100 against a nonexistent one and asserts mean delta < some threshold (loose check — purpose is regression detection, not statistical proof).

---

### #3 — Stored XSS via annotation notes [Critical / Security]
**Where:** `web/js/annotations.js:166, 375, 408` (and any other `innerHTML` site touching note content)
**Problem:** `innerHTML = \`...${annotation.note}...\`` executes embedded HTML/JS.

- [ ] Grep `web/js/` for every `innerHTML` assignment. List them all in this task before editing.
- [ ] For each: build the DOM with `createElement` + `textContent`, OR keep the static template and set the dynamic field via `element.value` / `element.textContent` after insertion.
- [ ] Specifically fix the textarea case: render the template with an empty textarea, then `textarea.value = annotation.note ?? ''`.
- [ ] Add a Playwright test that creates an annotation with note content `<img src=x onerror="window.__xss=1">`, reloads, and asserts `window.__xss` is undefined.
- [ ] Sanity-check other user-controlled fields (annotation labels, usernames in display, manuscript titles) for the same pattern.

---

### #4 — Async migrations are fire-and-forget [Critical / Reliability]
**Where:** `api/handlers/admin.go:125, 163` (`go h.processMigration(...)`)
**Problem:** No status, no retry, no timeout, no observability.
**Approach:** Option B — reuse the existing `migration` table as the status row.

- [ ] Schema (new changeset `002-migration-status.xml`):
  - Add columns to `migration`: `status TEXT NOT NULL DEFAULT 'done'` (values: `pending|running|done|error`), `started_at TIMESTAMPTZ`, `finished_at TIMESTAMPTZ`, `error TEXT`. Default `done` so existing rows backfill cleanly.
  - Drop NOT NULL on `sentence_count`, `additions_count`, `deletions_count`, `changes_count`, `sentence_id_array`, `branch_name` — these aren't known until the work finishes.
  - Index on `status` for the status endpoint.
- [ ] **Audit pass:** grep every `SELECT … FROM migration` and every join against it. Anywhere the code assumes "row exists ⇒ work is done" must add `WHERE status = 'done'`. List the call sites in this task body before editing. Likely: sentence lookup, annotation migration, segment retrieval.
- [ ] In the trigger handler (`api/handlers/admin.go`):
  - Insert a `migration` row with `status='pending'`, `started_at=now()`, real `commit_hash`/`segmenter`/`manuscript_id`, result columns NULL.
  - The existing unique constraint on `(manuscript_id, commit_hash, segmenter)` will reject a duplicate insert → return `409 Conflict` to the caller. Treat any unique-violation error as 409.
  - Pass the new `migration_id` to the goroutine.
  - Return `202 Accepted` with `migration_id` and `started_at`.
- [ ] In `processMigration`:
  - Transition `pending → running` at entry.
  - Wrap body in `defer` that records `done` (with all result columns populated) or `error` (with truncated message), and `finished_at`.
  - Use `context.WithTimeout(ctx, 5*time.Minute)` (configurable later).
- [ ] Implement `GET /api/admin/status` properly: return `migration` rows with `status IN ('pending','running')` plus the most recent `done`/`error` per manuscript.
- [ ] Startup recovery: `UPDATE migration SET status='error', error='interrupted by restart', finished_at=now() WHERE status IN ('pending','running')`.
- [ ] Test: trigger migration, assert row transitions through `pending → running → done`; trigger twice for same commit, assert second returns 409.

---

### #5 — Weak/copy-pasteable example secrets [Critical / Config]
**Where:** `config.example.yaml`, `internal/config/*`
**Problem:** Placeholders look real enough to accidentally use; no startup validation.

- [ ] Replace every `changeme-...` / `github_pat_xxx...` value in `config.example.yaml` with obviously-broken tokens (e.g. `REPLACE_ME_OR_SERVER_WONT_START`).
- [ ] In config-loading code, after parse, walk the secret fields (DB password, webhook secret, session secret, system token, GitHub PAT) and reject any that contain `REPLACE_ME` or are empty (in production mode).
- [ ] In `install.sh`, generate random secrets (`openssl rand -hex 32`) for session/webhook/system tokens and write them into the new config file rather than copying from example.
- [ ] Document in `AGENTS.md` and the new `docs/CONFIGURATION.md` that the server intentionally refuses to start with placeholder secrets.
- [ ] Test: load a config with one `REPLACE_ME` value, assert startup fails with a clear message naming the offending field.

---

### #6 — Sessions in memory only [High / Auth+Scale]
**Where:** `internal/auth/auth.go:29-42`
**Problem:** Restart logs everyone out; no horizontal scaling.

- [ ] Schema (new changeset `003-sessions.xml`):
  - `sessions(id TEXT PRIMARY KEY, username TEXT NOT NULL, csrf_token TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now())`.
  - Index on `expires_at` for cleanup.
- [ ] Replace the in-memory map in `internal/auth/auth.go` with DB-backed `Create`, `Get`, `Touch`, `Delete`.
- [ ] On each authenticated request, update `last_activity_at` and extend `expires_at` if within a refresh window (e.g. last quarter of TTL).
- [ ] Replace the in-memory cleanup goroutine with a periodic `DELETE FROM sessions WHERE expires_at < now()` (every few minutes).
- [ ] Test: create session, restart server (or just create new auth instance against same DB), assert session still valid.

---

### #7 — System token compared with `==` [High / Security]
**Where:** `api/handlers/admin.go:282-286`
**Problem:** Non-constant-time comparison enables timing attacks on the most privileged token.

- [ ] Replace `authHeader == expected` with `subtle.ConstantTimeCompare` or `hmac.Equal`.
- [ ] Audit other secret comparisons in the codebase (CSRF tokens, webhook signatures) for the same issue and fix in this same task.
- [ ] No new test required — straightforward refactor — but ensure existing admin-auth tests still pass.

---

### #8 — Webhook signature failures hidden [High / Security]
**Where:** `api/handlers/admin.go:69, 118-120, 289-291`
**Problem:** Returns 200 even on bad signature; empty `WebhookSecret` silently allowed.

- [ ] Add `WebhookSecret` to the startup secret-validation list (#5). Empty value → fail to start in production.
- [ ] Change webhook handler to return `403 Forbidden` (not 200, not 400) on invalid signature.
- [ ] Log every failed validation: source IP, signature header presence, body length. Use the structured logger from #14.
- [ ] Test: POST with wrong signature returns 403 and writes a log line.

---

### #9 — `<base href>` injection from config [High / Security]
**Where:** `api/server.go:162-177`
**Problem:** `base_path` is interpolated into HTML without escaping.

- [ ] HTML-escape `basePath` with `html.EscapeString` before injecting.
- [ ] Also validate `base_path` at config load: must match `^(/[A-Za-z0-9._~-]+)*$` (no quotes, no spaces, no closing tags).
- [ ] Test: set `base_path` to `/foo"onclick="alert(1)`, assert config load fails.

---

### #10 — No rate limiting on admin routes [High / Security]
**Where:** Anything under `/api/admin/*`
**Problem:** Token leak → trivial DoS or migration spam.

- [ ] Add a small in-process limiter (token bucket) keyed by token hash. Default: 10 req/min per token, 100 migration jobs/5min globally.
- [ ] Apply via middleware, not in each handler.
- [ ] Make limits configurable in `config.yaml` under a new `rate_limits` section, with sane defaults.
- [ ] Return `429 Too Many Requests` with `Retry-After`.
- [ ] Test: hammer an admin endpoint, assert 429 kicks in, assert it recovers after the window.

---

### #11 — Cookie `Secure` flag conditional, no HSTS [High / Security]
**Where:** `api/handlers/auth.go:105`, response headers in `api/server.go`
**Problem:** A reverse-proxy misconfig leaks sessions over HTTP.

- [ ] Keep `Secure: h.IsProduction` (dev still needs HTTP cookies on localhost).
- [ ] Add a middleware that sets `Strict-Transport-Security: max-age=31536000; includeSubDomains` in production mode only.
- [ ] Document in `docs/DEVELOPMENT.md` (created in #18) that production deployments MUST terminate TLS upstream.
- [ ] Test: hit any endpoint in prod mode, assert HSTS header present; in dev mode, assert absent.

---

### #12 — Repo paths not constrained to a root [Medium / Validation]
**Where:** `internal/migrations/git.go:43-46, 88-89`
**Problem:** Config could specify `Path: ".../../etc/whatever"` and `os.MkdirAll` would happily create it.

- [ ] Add `repos_dir` field to the top-level config (default `/app/repos` in container, `./repos` locally).
- [ ] At config load, for each manuscript's `GitRepository.Path`:
  - Compute `abs := filepath.Clean(path)` (or `filepath.Abs` if relative).
  - Assert `strings.HasPrefix(abs+string(os.PathSeparator), filepath.Clean(reposDir)+string(os.PathSeparator))`.
  - Fail startup with a clear message naming the manuscript and offending path.
- [ ] Also validate commit-hash format where supplied: `^[a-f0-9]{7,40}$|^(HEAD|main|master|develop)$`. Reject otherwise.
- [ ] Test: config with escaping path → startup fails; config with valid path → starts fine.

---

### #13 — No request body size limits [Medium / Reliability]
**Where:** `api/server.go` (router setup)
**Problem:** A 1GB POST OOMs the container.

- [ ] Add a global default cap (e.g. 1 MiB) via middleware using `http.MaxBytesReader` on `r.Body`.
- [ ] Per-route overrides where needed (annotations: 64 KiB; admin migration trigger: tiny; anything that takes manuscript content if it exists: explicit larger cap).
- [ ] Make the global default configurable.
- [ ] Test: POST a body over the cap, assert 413.

---

### #14 — Audit logging — DEFERRED
Skipped per user direction. Existing `log.Printf` to stdout (captured by Docker into `logs/`) stays as-is for now. Revisit when there's a concrete need for a queryable audit trail.

---

### #15 — Password validation [Medium / Auth]
**Decision:** Min length 4, no other rules. ("test" must work.)

- [ ] In `HandleLogin` registration / password-set paths: validate `len(password) >= 4`. Reject with a clear message.
- [ ] No common-password check, no character-class rules.
- [ ] Centralize in a `auth.ValidatePassword(string) error` so all entry points use the same rule.
- [ ] Test: 3-char password rejected, 4-char accepted.

---

### #16 — Freeze `001-initial-schema.xml` [Medium / Schema]
**Decision:** Frozen as of this plan. All new changes go in new changesets.

- [ ] Add a header comment to `001-initial-schema.xml` stating: "FROZEN as of <date>. Do not edit. Add new changesets instead."
- [ ] Update `AGENTS.md` § 3 (or wherever the schema policy lives) to reflect the freeze.
- [ ] All schema work in this plan (#4, #6, #14) goes into `002`, `003`, `004` respectively as noted in those tasks.
- [ ] (No test — process change.)

---

### #18 — Create the missing docs [Medium / Documentation]
**Where:** README references `docs/CONFIGURATION.md`, `docs/DEVELOPMENT.md`, `docs/API.md` that don't exist.

- [ ] `docs/CONFIGURATION.md`: every config field, type, default, whether required in prod. Include the placeholder-rejection rule from #5 and the `repos_dir` constraint from #12.
- [ ] `docs/DEVELOPMENT.md`: how to run locally, how to run tests (Go + Playwright), how to add a Liquibase changeset (referencing the freeze rule from #16), how the dev cookie/HTTPS exception works (from #11).
- [ ] `docs/API.md`: every endpoint, auth requirement, request/response shape, error codes. Group by `public`, `authenticated`, `admin`.
- [ ] Verify every link in `README.md` resolves after these are created.

---

### #19 — Frontend doesn't validate `Content-Type` [Medium / Frontend]
**Where:** `web/js/renderer.js:81-85` and similar fetch sites.

- [ ] Wrap all `fetch().then(r => r.json())` paths in a small helper that checks `response.ok` and `response.headers.get('content-type')?.includes('application/json')` before parsing.
- [ ] On non-JSON / non-OK responses, surface the response text (truncated) in a UI error rather than a parse exception.
- [ ] Audit `web/js/` for every fetch call and migrate to the helper.
- [ ] Test: stub fetch to return HTML 500, assert UI shows readable error.

---

### #20 — `GetBranchName` swallows errors [Low / Code Quality]
**Where:** `internal/migrations/git.go:118-127`

- [ ] Change signature behavior: on error, return `("", err)` instead of `("unknown", nil)`.
- [ ] Update callers to decide on a fallback explicitly (most likely propagate the error since branch name is metadata).
- [ ] Run the test suite; expect a couple of call sites to need adjustment.

---

### #22 — Remove dead `database.NewDB` [Low / Dead Code]
**Where:** `internal/database/db.go:18-37`

- [ ] Confirm with `grep -r "database.NewDB"` that nothing calls it.
- [ ] Delete the function.
- [ ] If it has unique env-var-loading logic worth keeping, fold it into `Connect`. (Quick check first; expect not.)

---

### #23 — Test coverage thin [Low / Testing]
**Where:** Codebase-wide.

- [ ] Add table-driven tests for each handler in `api/handlers/` covering: happy path, auth failure, validation failure, DB error.
- [ ] Add tests for `internal/auth/` covering: session create/get/touch/expire (against the new DB-backed store from #6).
- [ ] Add tests for `internal/config/` covering: secret-placeholder rejection (#5), `repos_dir` enforcement (#12), `base_path` validation (#9).
- [ ] Add Playwright failure-path tests: bad login, expired session, 403 on admin route without token, 429 on rate limit (#10).
- [ ] Set a minimum coverage gate in CI (start at current %, ratchet up).

---

### #24 — `/health` is too shallow [Low / Ops]
**Where:** `/health` handler.

- [ ] Split into `/livez` (always 200 if process is up) and `/readyz` (probes DB ping + config validity + each configured repo path is readable).
- [ ] At startup, validate every manuscript's repo path can be `os.Stat`'d; log warnings (not failures) if missing — `/readyz` will report.
- [ ] Update `docker-compose.dev.yaml` healthcheck (and any deployment manifests) to use `/readyz`.
- [ ] Test: stop the DB, assert `/readyz` returns non-200 while `/livez` still 200.

---

### #25 — Standardize on structured logging [Low / Logging]
Since #14 is deferred, this is the introduction point for `log/slog`.

- [ ] Initialize a global `slog` handler in `cmd/server/main.go` — JSON in production, text in dev (driven by config).
- [ ] Sweep the codebase for `log.Printf` and `fmt.Println` and convert to slog with consistent fields: `req_id`, `user`, `route`, `latency_ms`, `error`.
- [ ] Add a request-ID middleware that injects `req_id` into the request context and into every log line for that request.
- [ ] (No new test; verify by tail-ing logs during e2e run.)

---

## Execution order suggestion

Roughly:
1. Schema-freeze + the two new changesets (#16, then #4/#6 schema parts).
2. Critical security: #1, #2, #3.
3. Config hardening: #5, #12, #9.
4. Auth/session/admin: #7, #6, #15, #10, #11.
5. Reliability: #4 handler logic, #8, #13.
6. Logging: #25.
7. Docs and cleanup: #18, #19, #20, #22, #24.
8. Tests: #23 woven through; final pass at the end.
