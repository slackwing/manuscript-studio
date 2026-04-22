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
                     (admin, annotations, auth, migrations, suggestions)
cmd/
  server/            Main server entrypoint (cmd/server/main.go)
  admin-upsert/      One-shot binary: seeds admin user from config
  backfill-prev-sentence/  CLI to populate sentence.previous_sentence_id
                     for manuscripts that pre-date the history feature
internal/            Shared Go code not intended for import outside this repo
  auth/              Sessions, bcrypt, CSRF, admin-token check
  config/            YAML loader
  database/          pgx pool + query methods
  migrations/        Manuscript processing: bootstrap + migrate + git ops
  models/            DB-row structs with JSON tags
  fractional/        Fractional-index helpers for annotation ordering
  sentence/          Sentence tokenization, ID generation, diff/match
  segmenter/         Segmenter (vendored from the segman project — DO NOT EDIT)
liquibase/changelog/ Database schema as XML changesets
web/                 Static frontend (HTML/CSS/JS) served by the Go binary
  css/book.css       Typography + layout (single stylesheet)
  js/                Vanilla JS, no build step, no framework
    vendor/          Third-party libs vendored into the repo (whitelisted in
                     .gitignore via `!web/js/vendor/**`). Currently:
                     diff-match-patch.js (Google's reference implementation,
                     used by suggestions.js).
testdata/            Fixtures used by tests (e.g. test.manuscript)
tests/               Playwright + Node test suite
debug/               One-off scripts for the user to run against the DB
docker-compose.dev.yaml  Dev Postgres only
Dockerfile           Production server image (multi-stage)
Dockerfile.liquibase Liquibase runner image
install.sh           One-liner installer (prod default; `--dev` for local)
Makefile             Dev workflow targets
test-all.sh          Test runner with fast/slow/all/js-only modes
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
  - **`previous_sentence_id`** (nullable, self-FK) — set by the migration
    processor when an old→new pairing is found. This is the **lynchpin of
    cross-commit identity**: any code that asks "what was this sentence
    before?" walks this chain. Backfilled for legacy data by
    `cmd/backfill-prev-sentence`.
- **`annotation`** — the user-facing layer: color, note, priority, flagged,
  position (fractional index for within-sentence ordering). Soft-deleted via
  `deleted_at`. References a `sentence_id`.
  - **`completed_at`** (nullable) — analogous to `deleted_at`. Set when the
    user clicks the green checkmark on a sticky note. Filtered out of all
    reads (along with `deleted_at`).
- **`annotation_version`** — append-only history per annotation. Every edit
  creates a new row. Also records migration lineage (which sentences this
  annotation has been on, and with what confidence).
- **`tag`** / **`annotation_tag`** — scoped tags. Tags are per-migration, so
  renaming a tag on a new commit doesn't retroactively rename old ones.
- **`suggested_change`** — at most one suggestion row per `(sentence_id,
  user_id)` (UNIQUE). Holds a user's proposed alternate text for a
  sentence. Because `sentence_id` is per-migration, the uniqueness is
  effectively "one suggestion per user per sentence per commit".
  Suggestions are copied forward on text-identical (`Confidence == 1.0`)
  pairings; fuzzy pairings leave the suggestion attached to the old
  `sentence_id` (frozen at the commit where it was made).

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

The processor produces a map `bestPreviousByNew` mapping each new sentence
to its best old-sentence pairing (with a confidence score). This drives
three downstream behaviors in a single pass:

1. **`previous_sentence_id`** is set on each new `sentence` row.
2. **Annotations** are carried forward on every pairing (any confidence).
3. **Suggestions** (see §6.5) are copied forward only on `Confidence == 1.0`
   pairings — text-identical sentences. Fuzzy matches deliberately leave
   the suggestion frozen on the old sentence so the user re-evaluates it.

If you write code that asks "what was this sentence before?", use
`previous_sentence_id` (in the DB) or `bestPreviousByNew` (in the processor).
Don't re-implement the matching.

---

## 6.5. Sentence-history feature

A read-side view of the `previous_sentence_id` chain.

- **Endpoint**: `GET /api/migrations/{migration_id}/history` returns up to 3
  prior text versions per sentence by walking the chain. Batched in a single
  pass — no N+1.
- **Frontend**: `web/js/history.js` renders left-margin "history bars" with
  three lanes (1 / 2 / 3 commits ago). Each lane is colored by alphanumeric
  character delta:
  - green = sentence shorter than predecessor
  - red   = sentence longer
  - blue  = same length but content changed
- **Hover** on a bar shows a popup that stacks all known versions of the
  sentence, oldest first.

The "history bar" code only runs once per render — it reads the batched
response and stamps DOM, then is idle. No live updates while editing.

---

## 6.6. Suggested-edits feature

Lets a reader propose alternate text for a sentence without touching the
underlying markdown.

- **Schema**: `suggested_change` (see §4). Unique per `(sentence_id, user_id)`.
- **Endpoints**:
  - `GET /api/migrations/{migration_id}/suggestions` — all of this user's
    suggestions for the migration.
  - `PUT /api/sentences/{sentence_id}/suggestion` — body: `{text}`. The
    server collapses identical-to-original text into a DELETE.
  - `DELETE /api/sentences/{sentence_id}/suggestion` — explicit clear.
- **Migration**: see §6 — copy-forward on `Confidence == 1.0`.
- **Frontend**: `web/js/suggestions.js`. Re-clicking the already-selected
  sentence opens a monospace modal; **Enter** saves, **Esc** cancels.
  Diffs vs the original are rendered inline inside the existing
  `<span class="sentence">` using `web/js/vendor/diff-match-patch.js`. Spans
  keep their original `data-sentence-id` attribute even when a suggestion
  introduces new sentence boundaries inside the rendered text — so
  annotations, history bars, and selection all keep working.

### Critical render-order constraint

In `web/js/renderer.js renderManuscript()` the order is:

```
wrapSentences()                       // span every sentence
applyAnnotations()                    // highlight colors
WriteSysSuggestions.applyToSpans()    // inline diff overlay
smartquotes.element()                 // straight → curly quotes
```

If `smartquotes` runs before `applyToSpans`, every apostrophe in the DOM is
already curly while the suggestion text is still straight — diff-match-patch
then reports every apostrophe as a spurious change. **Do not reorder these
calls.**

---

## 6.7. Annotation completion

`annotation.completed_at` (column added 3aac761) marks an annotation as
"done" without deleting it. UI: green checkmark on each sticky note, with a
two-click confirm pattern (first click arms; second click commits). Endpoint:
`POST /api/annotations/{annotation_id}/complete`. Filtered out of all reads
just like `deleted_at`.

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
  text+ordinal and must match for DOM wrapping to find its targets. **Both
  files are vendored** from `~/src/feathers/15.segman/exports/lib/segman-{go,js}/`
  and must NEVER be edited directly in this repo — re-vendor instead.

### JS module map

| File | Responsibility |
|------|---------------|
| `auth.js` | Login, session, `authenticatedFetch` (auto-redirects to `login.html` on any 401 so an expired session can't silently break the UI). |
| `renderer.js` | Top-level render pipeline. See render-order constraint in §6.6. |
| `segmenter.js` | Vendored — see above. |
| `annotations.js` | Sticky-note CRUD, color picker, two-click complete, auto-jump to next annotated sentence. |
| `history.js` | Left-margin history bars (see §6.5). |
| `suggestions.js` | Re-click-to-edit modal + inline diff (see §6.6). |
| `rainbow-slice.js` | Per-sentence color stripe summarizing all annotations on it. |
| `pagedjs-config.js` | Paged.js handlers (page numbering, breaks). |
| `vendor/diff-match-patch.js` | Google's diff-match-patch (used by `suggestions.js`). |

### Selection / interaction notes

- Clicking a sentence:
  - selects it (mid-tone variant of any highlight color, no border),
  - drops the cursor straight into the first sticky note's textarea (the
    grey "uncreated" note if none exist; otherwise the first real note),
  - re-clicking the *already-selected* sentence opens the suggestion modal.
- Pagination is async + slow (~seconds). Re-renders happen on every
  suggestion save. The renderer clears `.pagedjs_pages` before re-running
  because Paged.js *appends*, not replaces.
- A down-arrow button below the gradient "uncreated" note jumps to the next
  annotated sentence. Sentence-preview clicks scroll to the source sentence.
- `.note-input` textareas use the **Caveat** font (Google Fonts), 18px —
  handwriting style.

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
  Node scripts. All are run by `test-all.sh` and **must be classified** as
  fast or slow in the two arrays at the top of that script (see §10.1).
- All tests use `manuscript_id=1` (`test-manuscripts`). Cleanup is done by
  `cleanupTestAnnotations()` in `test-utils.js`, which wipes annotation
  tables and re-triggers bootstrap via the admin API. **Note**:
  `suggested_change` rows FK to `sentence`, so if your test creates
  suggestions, delete them BEFORE calling `cleanupTestAnnotations` or the
  cascading sentence delete will be blocked by the FK.
- Playwright must run headless.

### 10.1. Fast / slow / all split

`test-all.sh` takes a mode arg:

| Command | What it runs | Wall time |
|---------|--------------|-----------|
| `./test-all.sh fast` (or `make test-fast`) | Go unit + FAST_TESTS subset | ~2.5 min |
| `./test-all.sh slow` (or `make test-slow`) | Go unit + SLOW_TESTS subset | ~7 min |
| `./test-all.sh all` (or `make test`) | Everything | ~10 min |
| `./test-all.sh js-only` | All JS tests, skip Go (server must be up) | varies |

**Threshold**: ≤15 s wall time = `fast`, otherwise `slow`. Two explicit
arrays (`FAST_TESTS`, `SLOW_TESTS`) at the top of `test-all.sh` enumerate
every test file by basename. A sanity check at the start of the script
**refuses to run** if any `tests/*.js` (other than `test-utils.js`) is
unclassified — so when you add a new test file, classify it.
