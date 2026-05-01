# API Reference

All endpoints are mounted under `/api`. When the server is configured with a non-empty `server.base_path`, the prefix is `<base_path>/api`.

Three auth tiers:

- **Public** — anyone can call.
- **Session** — requires a valid session cookie (`session_token`) from `POST /api/login`. State-changing methods (POST/PUT/DELETE) also require an `X-CSRF-Token` header matching the session's CSRF token.
- **Admin** — requires `Authorization: Bearer <system_token>` matching `auth.system_token` in config. Constant-time compared. Rate-limited per token (`rate_limits.admin_per_token_rpm`).

Response bodies are JSON unless noted.

---

## Public

### `POST /api/login`
Body: `{"username": "...", "password": "..."}`. The manuscript is no longer
chosen at login time — see `GET /api/session` for the user's accessible
manuscripts and the `?manuscript_id=N` URL convention.
Response 200: `{"username", "csrf_token", "last_manuscript_name", "manuscripts": [{name, manuscript_id}, ...]}` + `Set-Cookie: session_token=...`. The client lands on `last_manuscript_name` if it's still in `manuscripts`, else the first entry.
Response 401: `Invalid credentials` (same body for any failure mode — timing-safe, no enumeration).
Response 400: `Invalid request body` / `Missing required fields`.

### `GET /api/users`
List of usernames for the login dropdown. Response: `{"users": [{"username": ...}]}`.

---

## Session-protected

### `POST /api/logout`
Clears the session cookie. Returns 204.

### `GET /api/session`
Response 200: `{"username", "csrf_token", "last_manuscript_name", "accessible_manuscripts": [{name, manuscript_id}, ...]}`. Refreshes the session's expiry if it's in the last quarter of TTL.
Response 401: when the cookie is missing/invalid/expired.

### `POST /api/session/last-manuscript`
Body: `{"manuscript_name": "..."}`. Records the user's most recently opened manuscript so the next login lands on the same one. Returns 204 on success, 403 if the user lacks access to the named manuscript, 400 on missing field.

All per-manuscript endpoints below return **404 Not Found** when the calling user lacks `manuscript_access` to the requested manuscript (whether by direct `manuscript_id` or transitively via `migration_id`/`sentence_id`/`annotation_id`). 404 is used uniformly so the response doesn't leak whether the id exists.

### `GET /api/migrations?manuscript_id=N`
Returns all completed migrations for that manuscript, newest first. Pending/running/error rows are excluded.

### `GET /api/migrations/latest?manuscript_id=N`
Most recent **completed** migration for that manuscript.
Response 404: no completed migrations exist yet.

### `GET /api/migrations/{migration_id}/manuscript`
Returns the markdown content + sentence list + this user's annotations for a completed migration.
Response 404: migration not found OR migration not yet at status='done'.

### `GET /api/migrations/{migration_id}/history`
Returns up to 3 prior text versions per sentence, walking the
`sentence.previous_sentence_id` chain. Batched in a single pass — no N+1.
Response shape: `{"sentences": [{sentence_id, history: [{text, commit_hash, ...}, ...]}, ...]}`.
Sentences with no history return an empty `history` array.

### `GET /api/migrations/{migration_id}/suggestions`
Returns all of the calling user's suggestions for the given migration.
Response shape: `{"suggestions": [{suggestion_id, sentence_id, text, created_at, updated_at}, ...]}`.

### Annotations
- `GET /api/annotations/{commit_hash}` — all annotations for a given commit (this user). Excludes `deleted_at` and `completed_at`.
- `GET /api/annotations/sentence/{sentence_id}` — annotations on one sentence.
- `POST /api/annotations` — create. Body: `{sentence_id, color, note?, priority, flagged}`.
- `PUT /api/annotations/{annotation_id}` — update.
- `PUT /api/annotations/{annotation_id}/reorder` — change `position`.
- `POST /api/annotations/{annotation_id}/complete` — mark as completed (sets `completed_at`). Two-click confirm in the UI.
- `DELETE /api/annotations/{annotation_id}` — soft-delete (sets `deleted_at`).

### Suggestions
- `PUT /api/sentences/{sentence_id}/suggestion` — body: `{text}`. Idempotent upsert (UNIQUE on `sentence_id`+`user_id`). If `text` equals the original sentence text, the server collapses the call into a DELETE.
- `DELETE /api/sentences/{sentence_id}/suggestion` — explicit clear.
- `GET /api/manuscripts/{manuscript_id}/migrations/{migration_id}/push-state` — returns `{branch, branch_exists, compare_url}`. `branch` is the canonical `suggestions-{shortSHA}-{user}` name; `branch_exists` toggles the dropdown's "View on GitHub" item; `compare_url` is empty when `repository.slug` isn't configured.
- `POST /api/manuscripts/{manuscript_id}/migrations/{migration_id}/push-suggestions` — body is ignored (single mode: force-push the canonical branch). Applies the calling user's suggestions to the `.manuscript` file at the migration's commit, commits, and force-pushes to `origin`. If a sibling `<name>.segman` (sentence-per-line file produced by github.com/slackwing/segman) exists at the base commit, it's regenerated and staged in the same commit so PR diffs read sentence-by-sentence; otherwise only the `.manuscript` is touched. Response: `{branch, compare_url, commit_sha, applied, skipped, results}`. Returns 409 with `{error: "stale"}` when the migration is no longer the latest for the manuscript.

### Tags
- `GET /api/annotations/{annotation_id}/tags`
- `POST /api/annotations/{annotation_id}/tags` — body: `{tag_name, migration_id}`. Tag name must match `^[a-z0-9-]+$`.
- `DELETE /api/annotations/{annotation_id}/tags/{tag_id}`

---

## Admin

All `/api/admin/*` calls require the system token (except `/webhook`, which authenticates via HMAC signature instead). All responses include the standard rate-limit treatment: `429 Too Many Requests` + `Retry-After` when the per-token bucket is empty.

### `POST /api/admin/webhook`
GitHub push webhook receiver. No bearer token; instead validates `X-Hub-Signature-256` HMAC against `auth.webhook_secret`.
- Response 403: bad/missing signature. Logged with source IP.
- Response 200 `{"status":"ignored", ...}`: webhook for an unknown repo or for a commit that didn't touch the manuscript file.
- Response 202 `{"status":"accepted","migration_id":N,"started_at":"..."}`: a migration was kicked off.
- Response 409: a migration for this commit (or a sibling with the same segmenter version) already exists.

### `POST /api/admin/sync`
Body: `{"manuscript_name": "...", "commit_hash": "..."}`. `commit_hash` is optional and defaults to `HEAD`.
- Response 202: as above.
- Response 409: duplicate.
- Response 400: invalid `commit_hash` format. Validated against `^(HEAD|[A-Fa-f0-9]{7,40}|[A-Za-z0-9._/-]+)$`.
- Response 404: unknown `manuscript_name`.

Note: `commit_hash: "HEAD"` is treated literally for dedup purposes — two concurrent "HEAD" syncs for the same manuscript will see the second return 409. To dedup by resolved SHA, pass an explicit hash.

### `GET /api/admin/status`
Response 200:
```json
{
  "status": "in_progress" | "idle",
  "migrations_in_progress": 2,
  "active": [ /* full migration rows currently at status pending|running */ ]
}
```

### `POST /api/admin/users`
Body: `{"username", "password", "role"?}`. Idempotent upsert. Password is bcrypt-hashed.
Validation: `password` must be at least 4 chars (no other constraints).
Response 201 on success.

### `POST /api/admin/grants`
Body: `{"username", "manuscript_name"}`. Idempotent. Response 201.

---

## Health

### `GET /livez`
Cheap liveness probe. Always 200 if the process is up.

### `GET /readyz`
Deep readiness probe. Returns 503 if the DB is unreachable. Returns 200 with `"status":"degraded"` if any configured manuscript repo path doesn't exist on disk yet. Returns 200 `"status":"healthy"` when everything checks out.

### `GET /health`
Legacy alias for `/readyz`. Kept so existing scripts and dashboards keep working.
