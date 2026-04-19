# Manuscript Studio — Architecture

A high-level guide to how the pieces fit together. Reflects the current
codebase; when in doubt, the code wins.

---

## 1. Purpose

Manuscript Studio is a self-hosted, multi-user web application for annotating
book manuscripts stored in Git. The source of truth for the text is always a
Markdown file in a Git repository; annotations (highlights, notes, tags,
priorities, flags) are a layer on top, keyed by sentence.

The signature feature is **annotation migration**: when the manuscript is
edited and committed, annotations follow their sentences heuristically —
unchanged sentences keep their annotations, moved sentences carry them along,
and edited or deleted sentences mark their annotations as uncertain with a
confidence score.

---

## 2. Request topology

```
┌───────────────────┐       ┌──────────────────────┐      ┌────────────────┐
│   GitHub (push)   │─────► │  Apache / Nginx      │─────►│ manuscript-    │
└───────────────────┘       │  (TLS, proxy)        │      │ studio-server  │
                            └──────────────────────┘      │ (Go, :5001)    │
┌───────────────────┐                                     └────────┬───────┘
│    Browser        │─────►                                        │
└───────────────────┘                                               ▼
                                                           ┌────────────────┐
                                                           │   PostgreSQL   │
                                                           │  (host-managed)│
                                                           └────────────────┘
```

- **Single Go binary** serves both the API and the static web UI.
- **Apache (or nginx)** terminates TLS and proxies to `127.0.0.1:5001`. The
  app supports path-prefix hosting (`/manuscripts` under a shared domain) or
  subdomain hosting; see §5.
- **PostgreSQL runs outside Docker.** In production, GCP Cloud SQL or
  equivalent. In dev, a Postgres container on port 5433.
- **No CLI.** WriteSys had a `writesys` CLI that processed manuscripts
  directly. Manuscript Studio exposes `POST /api/admin/sync` for the same
  purpose; the GitHub webhook hits the same underlying code path.

---

## 3. Repository layout

```
api/                 HTTP router, request handlers
  handlers/          Thin adapters between HTTP and internal packages
cmd/
  server/            Main server entrypoint (cmd/server/main.go)
  admin-upsert/      One-shot binary: seeds admin user from config
internal/            Shared Go code not intended for import outside this repo
  auth/              Sessions, bcrypt, CSRF, admin-token check
  config/            YAML loader
  database/          pgx pool + query methods
  migrations/        Manuscript processing: bootstrap + migrate + git ops
  models/            DB-row structs with JSON tags
  fractional/        Fractional-index helpers for annotation ordering
  sentence/          Sentence tokenization, ID generation, diff/match
  segmenter/         Segmenter (copied from the segman project)
liquibase/changelog/ Database schema as XML changesets
web/                 Static frontend (HTML/CSS/JS) served by the Go binary
  css/book.css       Typography + layout (single stylesheet)
  js/                Vanilla JS, no build step, no framework
testdata/            Fixtures used by tests (e.g. test.manuscript)
tests/               Playwright + Node test suite
debug/               One-off scripts for the user to run against the DB
docker-compose.dev.yaml  Dev Postgres only
Dockerfile           Production server image (multi-stage)
Dockerfile.liquibase Liquibase runner image
install.sh           One-liner installer (prod default; `--dev` for local)
Makefile             Dev workflow targets
```

---

## 4. Data model (see liquibase/changelog/001-initial-schema.xml)

### Core tables

- **`user`** — `username` (PK), bcrypted `password_hash`, `role`.
- **`manuscript_access`** — many-to-many grant of which users see which
  manuscripts. Login requires both valid password AND a row here.
- **`manuscript`** — one row per tracked repo+file. `manuscript_id` is the
  stable handle the UI passes around.
- **`migration`** — one row per (`manuscript_id`, `commit_hash`,
  `segmenter`). Captures the state of segmentation at that commit: count of
  sentences and a JSONB `sentence_id_array` listing their ordering. A
  migration can point at a `parent_migration_id` for diffing.
- **`sentence`** — one row per sentence in a given migration. Primary key is
  `sentence_id`, a deterministic 8-char hex hash of the sentence text +
  ordinal + commit hash. Immutable once written — changes create new
  sentences with new IDs, preserving history.
- **`annotation`** — the user-facing layer: color, note, priority, flagged,
  position (fractional index for within-sentence ordering). Soft-deleted via
  `deleted_at`. References a `sentence_id`.
- **`annotation_version`** — append-only history per annotation. Every edit
  creates a new row. Also records migration lineage (which sentences this
  annotation has been on, and with what confidence).
- **`tag`** / **`annotation_tag`** — scoped tags. Tags are per-migration, so
  renaming a tag on a new commit doesn't retroactively rename old ones.

### Why this shape

- **Sentences are immutable** — edits create new IDs. No "versioning" of the
  sentence record itself; the migration logic tracks lineage separately. This
  avoids ambiguity about what "the current text" of a sentence is.
- **Annotations don't have versions in the main table** — `annotation` holds
  the current state; `annotation_version` holds history. Writes touch both
  in a transaction.
- **Multi-annotation per sentence is allowed** — the 14.writesys schema
  originally had a unique constraint on (sentence, user). We dropped it:
  a user can stick multiple notes on one sentence, ordered by fractional
  position.

### Schema changes going forward

Pre-release we consolidated everything into `001-initial-schema.xml`. Post-
release, never edit 001. Every change is a new changeset (002, 003, …);
Liquibase's checksum validation will fail on edits to old ones. See AGENTS.md.

---

## 5. Base-path hosting

The server can be hosted two ways, switchable via one config line:

- **Subdomain** (`manuscripts.example.com`) — set `server.base_path: ""`.
- **Path prefix** (`example.com/manuscripts`) — set
  `server.base_path: "/manuscripts"`.

Mechanics when `base_path` is non-empty:

1. Middleware strips the prefix from incoming `req.URL.Path` AND chi's
   `RouteContext.RoutePath` (both — chi routes off its own context, not the
   request URL).
2. The server injects `<base href="/manuscripts/">` into every HTML response.
3. The frontend's HTML/JS use **relative** URLs (`css/book.css`, `api/login`).
   With `<base>`, relative URLs resolve correctly under the prefix. Without
   `<base>`, they resolve to the domain root.
4. Some libraries (Paged.js) fetch stylesheets directly via JS, not via
   `<link>`. For those, `renderer.js` builds an absolute URL using
   `new URL('css/book.css', document.baseURI)` so it picks up the `<base>`.

When `base_path` is empty, we skip the `<base>` injection entirely. Some
third-party libraries misbehave under a `<base href="/">` that doesn't add
any information.

---

## 6. Annotation migration algorithm

Lives in `internal/migrations/processor.go`. Two modes:

- **Bootstrap** — first migration for a manuscript. Tokenize the file,
  generate sentence IDs, write migration + sentences. No annotations to
  carry.
- **Migrate** — subsequent commits. Get the prior migration's sentences.
  Tokenize the new commit. Compute a diff using `internal/sentence` which
  matches sentences by text similarity + position. For each old→new match
  above a confidence threshold, carry annotations forward: append a new
  `annotation_version` row with the new `sentence_id`, and update the main
  `annotation.sentence_id`. Low-confidence matches become orphan annotations
  (retained but visibly marked as needing review).

The segmenter version is baked into every migration row. If you upgrade the
segmenter, migrations from old segmenter versions remain valid (their
sentence IDs are what they are); new migrations use the new segmenter.
Old annotations migrate across the change, with confidence scores.

---

## 7. Frontend

- **No build step, no framework.** Vanilla JS, loaded via `<script>` tags in
  `index.html` in a specific order (see that file).
- **Paged.js** (CDN, loaded from `unpkg`) does book-style pagination.
- **Renderer flow** (`renderer.js`):
  1. Fetch the migration's markdown, sentence list, and annotations via
     `GET /api/migrations/{id}/manuscript`.
  2. Parse markdown → HTML in a detached container.
  3. Wrap each sentence in `<span class="sentence" data-sentence-id="...">`.
     This wrapping happens **before** pagination; Paged.js duplicates the
     spans across page breaks as needed.
  4. Apply annotation highlights (`highlight-yellow` etc.) based on
     sentence ID.
  5. Hand the wrapped HTML to Paged.js for pagination.
- **Segmenter parity required.** The JS segmenter (`web/js/segmenter.js`)
  must produce identical sentence splits as the Go segmenter
  (`internal/segmenter/segman.go`), because sentence IDs are derived from
  text+ordinal and must match for DOM wrapping to find its targets.

---

## 8. Spacing & color invariants

Hard-coded design values tested by `tests/spacing-invariants-test.js`.
Defined as CSS variables in `web/css/book.css`:

| Variable | Value | Meaning |
|----------|-------|---------|
| `--page-gap` | 2em (32px) | Vertical gap between pages |
| `--horizontal-gap` | 32px | Page edge → annotation margin |
| `--annotation-top` | 150px | Viewport top → annotations |
| `--annotation-width` | 272px | Fixed width of annotation column |

### Colors

Six highlight colors, each with four variants (highlight, sticky-note
background, sticky-note border, accent). Full definitions in
`web/css/book.css` under `:root { --highlight-*, --sticky-*, ... }`.

### Rule: never use `scale()` transforms for sizing

When making an element bigger or smaller, recalculate dimensions in px/em/rem
explicitly. `scale()` breaks positioning in nested absolute layouts. See
AGENTS.md for the full rule.

---

## 9. Auth

- **Sessions** — cookie-based, server-side session store
  (`internal/auth/auth.go`). Bcrypt password hashes in the `user` table.
  Sessions expire after 24 hours.
- **CSRF** — per-session token. State-changing routes require
  `X-CSRF-Token` header matching the session's token.
- **Admin (system) token** — for server-to-server operations (GitHub
  webhook, `/api/admin/sync`, `/api/admin/users`, `/api/admin/grants`).
  Checked against `auth.system_token` from config via
  `Authorization: Bearer <token>`.
- **Timing-safe login** — login always runs bcrypt, even for unknown users
  (dummy hash), so response time doesn't leak whether a username exists.
- **Generic error messages** — failed login always says "Invalid
  credentials", whether the problem was a missing user, wrong password, or
  lack of manuscript access. Prevents enumeration.

---

## 10. Testing model

See AGENTS.md for rules; the short version:

- **Go unit tests** — `go test ./...`. Cover `internal/sentence` and
  `internal/fractional`. No DB required.
- **Playwright UI integration** — `node tests/ui-integration.js`. Runs
  against a live server backed by real Postgres. Gatekeeper.
- **Feature tests** — `tests/test-*.js` and `tests/*-test.js`. Individual
  Node scripts. Not run by `test-all.sh`; invoke directly.
- All tests use `manuscript_id=1` (`test-manuscripts`). Cleanup is done by
  `cleanupTestAnnotations()` in `test-utils.js`, which wipes annotation
  tables and re-triggers bootstrap via the admin API.
- Playwright must run headless.
