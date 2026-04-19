# Troubleshooting

## Server refuses to start with "still contains the placeholder token REPLACE_ME"

`config.yaml` has at least one secret left at the example placeholder value. Replace it (use `openssl rand -hex 32` for the cryptographic ones). The validation only runs when `server.env: production`; in dev (`env: development`) placeholders are tolerated.

## Server refuses to start with "repo path escapes repos_dir"

A manuscript's `name` resolves to a directory outside `paths.repos_dir`. Either fix the name (no `..`, no leading `/`) or widen `repos_dir`.

## Login always returns 401

Check:
- Username actually exists in the `user` table (`debug/connect_db.sh` → `SELECT username FROM "user";`)
- Password matches what you set
- The user has access to the manuscript you selected (`SELECT * FROM manuscript_access WHERE username = '...';`)

The error message is intentionally generic ("Invalid credentials") and the timing is uniform — by design, to prevent username enumeration. If your client reports a 4xx that isn't 401, that's a `Bad Request` from validation; check the request body shape.

## `/admin/sync` returns 409 Conflict

A migration row for the same `(manuscript_id, commit_hash, segmenter)` already exists — pending, running, done, or error. Check `GET /admin/status` to see in-flight work, or query the `migration` table directly.

## `/admin/status` shows a row stuck at "running" forever

The server crashed mid-migration. Restart the server — startup recovery flips any pending/running rows from a previous process to `error` with message `"interrupted by server restart"`. Then re-trigger the migration.

## Webhook returns 403

The HMAC signature didn't validate. Check that:
- `auth.webhook_secret` in config matches the secret you configured in GitHub
- GitHub is sending the `X-Hub-Signature-256` header (it does for any modern config)
- The body wasn't mangled by an upstream proxy

The server logs the source IP and signature presence on every rejection.

## "Expected JSON, got text/html" in browser console

The server returned an HTML error page where the frontend expected JSON. Check the server logs for a 500 or panic. Likely a request that bypassed JSON serialization (e.g., a stack trace from chi's recoverer).

## Tests can't connect to Postgres

`tests/test-utils.js` first tries `psql` against `localhost:5433`, falling back to `docker exec` into the dev container if `psql` isn't installed. If both fail, the dev DB isn't running — `make dev` brings up Postgres in docker-compose.
