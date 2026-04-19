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
Body: `{"username": "...", "password": "...", "manuscript_name": "..."}`
Response 200: `{"username", "manuscript_name", "csrf_token"}` + `Set-Cookie: session_token=...`
Response 401: `Invalid credentials` (same body for any failure mode — timing-safe, no enumeration).
Response 400: `Invalid request body` / `Missing required fields`.

### `GET /api/users`
List of usernames for the login dropdown. Response: `{"users": [{"username": ...}]}`.

### `GET /api/manuscripts`
List of configured manuscript names. Response: `{"manuscripts": ["..."]}`.

---

## Session-protected

### `POST /api/logout`
Clears the session cookie. Returns 204.

### `GET /api/session`
Response 200: `{"username", "manuscript_name", "csrf_token", "accessible_manuscripts": [...]}`. Refreshes the session's expiry if it's in the last quarter of TTL.
Response 401: when the cookie is missing/invalid/expired.

### `GET /api/migrations?manuscript_id=N`
Returns all completed migrations for that manuscript, newest first. Pending/running/error rows are excluded.

### `GET /api/migrations/latest?manuscript_id=N`
Most recent **completed** migration for that manuscript.
Response 404: no completed migrations exist yet.

### `GET /api/migrations/{migration_id}/manuscript`
Returns the markdown content + sentence list + this user's annotations for a completed migration.
Response 404: migration not found OR migration not yet at status='done'.

### Annotations
- `GET /api/annotations/{commit_hash}` — all annotations for a given commit (this user).
- `GET /api/annotations/sentence/{sentence_id}` — annotations on one sentence.
- `POST /api/annotations` — create. Body: `{sentence_id, color, note?, priority, flagged}`.
- `PUT /api/annotations/{annotation_id}` — update.
- `PUT /api/annotations/{annotation_id}/reorder` — change `position`.
- `DELETE /api/annotations/{annotation_id}` — soft-delete.

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
