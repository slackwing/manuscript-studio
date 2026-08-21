# Plan: Manuscript lifecycle — in-app creation, settings, local repos, docx import

Status: **PHASES 0, 1, 2, 5 SHIPPED 2026-08-21** (see
`tests/test-manuscript-lifecycle.js` + `tests/test-manuscript-normalize.js`
for the living spec). Phase 3 awaits PERMISSIONS_PLAN approval; Phase 4
(github-mode creation) deferred pending the `git_repo_access` /
`create-manuscript` decisions in that review. §6.5 shipped as the
"+ sentence after" link in the suggestion modal.
Captures a design discussion between Slackwing and Claude (2026-08-20),
revised per review 2026-08-21. Review decisions folded in below, marked
**[R]**:

- **[R] Naming**: everything `repo_*` becomes `git_repo_*` (columns,
  tables, config keys, identifiers). The existing `manuscript.repo_path`
  column is renamed in the Phase 0 changeset while we're touching the
  table anyway.
- **[R] Repo storage layout**: `<repos_dir>/git/local/<slug>/` (local-mode
  repos) and `<repos_dir>/git/remote/<slug>/` (clones of GitHub repos),
  migrating the current flat layout under `MANUSCRIPT_STUDIO_REPOS_DIR`.
- **[R] Ronald's book tests LOCAL mode** — supersedes §3's darkfeather
  recommendation (option (a) is dead; user simply hadn't thought of local
  mode when darkfeather was chosen). The local-repos backup TODO is now a
  hard requirement, not a nice-to-have.
- **[R]** Manuscript page keeps SHOWING birthday + word goal; only the
  inline editing moves to the settings modal.
- **[R]** Normalizer: no "scene" concept — chapters map to `##`, nothing
  infers `###` scenes.
- **[R]** New feature ride-along (§6.5): insert-a-sentence-between-
  sentences, fixing a long-standing annoyance.
- **[R] Execution**: implement all phases in one run — phase boundaries
  are for organization/review, not stopping points. STOP once the UI is
  usable: Slackwing creates the manuscript and imports chapters himself
  (real .docx files only touched in local docker testing). Phase 3 waits
  on PERMISSIONS_PLAN approval (spec-first rule); Phase 4 (github-mode
  creation) is deferred — it depends on `git_repo_access` /
  `create-manuscript` decisions in that same review and Ronald's book no
  longer needs it.

Companion spec: `PERMISSIONS_PLAN.md` (roles/permissions — spec-first,
approved before any enforcement code is written).

---

## 0. The one structural prerequisite (read this first)

Everything below assumes manuscripts can be **created from the UI**. Today
they can't, and not because a modal is missing: `config.yaml` is the source
of truth for manuscripts — the server derives the `manuscript` DB row from
config at sync time (`internal/database/manuscripts.go:18`, keyed by
`repo_path` + `file_path`). A UI "create" has nowhere to write.

So the enabling refactor is **registry-to-DB**:

- The `manuscript` table becomes the source of truth for manuscripts
  (name, display name, repo binding, branch, path, birthday, word goal).
- `config.yaml` keeps what genuinely belongs to server operation:
  the **repo registry** (slug, clone auth — SSH/PAT, webhook secret) and
  server settings. Credentials never live in the DB.
- Webhook handling changes shape: match the incoming repo slug against the
  config repo registry, then look up *all manuscripts bound to that repo*
  in the DB (today it matches against config manuscript entries —
  `matchManuscriptForWebhook`, `api/handlers/admin.go:311`).
- One-time migration: existing config `manuscripts:` entries are upserted
  into the DB at startup (idempotent, like today's sync upsert), then the
  config section is reduced to the repo registry.

This is Phase 0. It's the real cost of the feature; the modal is the cheap
part.

---

## 1. Ghost-card creation (landing page)

- To the right of the last manuscript card: a **ghost card** — faint card
  outline, `+` centered. On hover it lights up and reads "Create new
  manuscript". Click → creation modal (§2).
- **Scratchpads adopt the identical pattern**, replacing their current `+`
  affordance. One shared ghost-card component/CSS class; the two grids
  differ only in label and click handler.
- The manuscript ghost card renders only for users allowed to create
  manuscripts (see `PERMISSIONS_PLAN.md`, server-level `create-manuscript`).

Files: `web/js/home.js`, `web/css/book.css`.

## 2. Creation modal

One modal, driven by a **shared field schema** (§4) so creation and
settings can't drift.

Fields (from the current `manuscript` row + config binding):

| field          | required | editable later | notes |
|----------------|----------|----------------|-------|
| display name   | yes      | yes            | "The Wildfire" |
| slug/name      | yes (derived, overridable) | no | URL-safe id; kebab of display name |
| storage        | yes      | no (v1)        | `local` \| `github` (§3) |
| repo           | if github | no (v1)       | picker: repos this user has access to |
| path in repo   | if github | no (v1)       | e.g. `18.kichurchak/book.manuscript` |
| branch         | if github | no (v1)       | default from repo registry |
| birthday       | no       | yes            | date writing began |
| word goal      | no       | yes            | stats-pane target |

On submit (local mode): server creates the local repo (§3), writes a
**seeded** `book.manuscript` containing `# <Display Name>` (NOT an empty
file — the title line gives docx import a committed sentence to anchor
its suggestion to, §6, and sidesteps zero-sentence edge cases), makes the
initial commit, runs the bootstrap migration, inserts the manuscript row,
and grants the creator the **admin** role (answering "why do *I* get to
manage access": because you created it).

On submit (github mode): server commits the same seeded `.manuscript` at
the given path on the configured branch and pushes, then bootstraps.
Reuses the push feature's git machinery.

**Verify before building:** bootstrap/renderer behavior on a
title-only file (one heading, zero body sentences) — the trailing `+`
page (§6) must render and anchor correctly in that state.

### Repo access

- Repo **credentials/topology** stay in `config.yaml` (repo registry).
- Repo **grants** go in a new DB table `git_repo_access (username, git_repo_name)`
  — *not* a username list in config. Rationale: consistent with
  `manuscript_access`, editable without a server restart, and eventually
  manageable from the UI. Config = what only the operator can know
  (secrets); DB = who may do what.
- The modal's repo picker lists repos the user has a grant on. The server
  holds all the keys either way; the grant is authorization, not
  authentication.

## 3. Local-repo storage mode

Viable today in spirit: config already has the `url:` escape hatch pointing
a manuscript at a local filesystem path ("for testing" —
`config.example.yaml`). We promote it to a first-class mode.

- Server-managed directory: `<repos_dir>/git/local/<slug>/` (one git repo
  per manuscript, `book.manuscript` at root), where `<repos_dir>` is the
  existing `MANUSCRIPT_STUDIO_REPOS_DIR`. Remote clones move to
  `<repos_dir>/git/remote/<slug>/`; the flat legacy layout is migrated at
  startup (idempotent move). **[R]**
- No webhook, no push-to-GitHub. **Commit button = commit + migration
  synchronously** in one request (same processor call the webhook path
  uses; no queue hop needed for a single-writer local repo).
- Button treatment: octocat + "Push (N)" is GitHub-specific (confirmed:
  `ICON_GITHUB` in `web/js/push.js` is the octocat). Local mode shows a
  **git commit icon (dot-on-a-line), label "Commit (N)"**. Recommend the
  commit glyph over the merge glyph — merge implies branch semantics that
  local mode deliberately doesn't have.
- **`.segman` sibling: skip in local mode.** Its whole purpose is
  sentence-granular PR diffs on GitHub; local repos have no PRs. (It is
  NOT required for migrations — the server segments `.manuscript` itself.)
  So no, an empty `.manuscript` need not create a `.segman` on commit.
- **Graduation path** (design for it, build later): local → GitHub is
  `git remote add` + push + flip the manuscript row's binding. Keep the
  local repo layout boring so this stays a data-only operation.

### Ronald's book: LOCAL mode **[R — decided 2026-08-21]**

Ronald's book is the dogfood case for local mode (the earlier darkfeather
recommendation is dead — local mode simply hadn't been conceived when
darkfeather was chosen). Consequence: the book lives only in
`<repos_dir>/git/local/<slug>/` on the GCP server, so the **server backup
story for that directory is now a HARD requirement** before real chapters
go in. Cheapest adequate option: a nightly `git bundle` (or mirror push)
of every repo under `git/local/` to a private remote or to the existing
server backup path — pick at implementation time and document it in
README's deploy doctrine. A later "graduation" to darkfeather stays
possible via the remote-add path above.

## 4. Settings modal (shared with creation)

- **One field schema** (single JS descriptor: key, label, input type,
  required, `editableAfterCreate`) renders both the creation modal and the
  settings modal. Add a field once, it appears in both; immutable fields
  render read-only in settings. This is the DRY requirement.
- Entry points:
  - Landing card: **gear icon** beside the daily-tasks affordance (gear,
    not word, for consistency). Card is an `<a>` — gear click must
    stopPropagation.
  - Manuscript view: gear to the right of the title ("The Wildfire ⚙").
- The manuscript page/stats pane **keeps displaying** birthday and word
  goal; only the inline **editing** affordance is removed — edits happen
  in the settings modal. **[R]**
- Settings modal gains a **User access** section: list users with roles on
  this manuscript; add/remove users; assign/revoke roles. Visible only
  with the `manage-access` permission. Backend: session-authed,
  permission-gated endpoints (today's `/api/admin/users|grants` are
  system-token-only and stay for bootstrap/ops use).

## 5. Roles & permissions

Spec-first, in `PERMISSIONS_PLAN.md`. Summary of the agreed direction:
actions (permissions) are the atoms; roles are named bundles of actions;
users hold **multiple roles per manuscript**. Creator gets `admin`.
No role is enforced on content actions until the spec is approved.

Open TODO recorded there: how points interact with roles/permissions, and
whether points are per-user or per-manuscript.

## 6. Docx import

### UX

- The between-paragraph hover `+` rule (currently the canonize/place
  affordance, `web/js/import-scratchpad.js`) becomes a small **menu**:
  - "Place sketch…" (existing canonize flow, unchanged)
  - "Import .docx…" (new) — inserts the converted content at that boundary
- A **trailing blank page always shows a centered `+`** with the same
  menu. This covers the two cases the hover rule can't: a completely empty
  manuscript, and appending after the last paragraph.

### Mechanics (DECIDED 2026-08-20: in-browser, as a suggested edit)

- Conversion pipeline, entirely **in the browser**:
  **.docx → markdown → `.manuscript` normalization → ONE suggestion**.
- Conversion libs, vendored (house style — vanilla JS, no build step,
  like diff-match-patch): **mammoth.js** (docx → semantic HTML) +
  **turndown** (HTML → markdown). pandoc is demoted to an offline
  fallback if mammoth quality disappoints on real Kichurchak files.
- New `.manuscript` **normalizer** module (browser JS, but written
  standalone so a CLI can reuse it):
  - heading mapping: chapters → `##`. No scene inference — there is no
    scene concept. **[R]**
  - blank-line paragraph breaks → the house `\n\t` convention
  - dashes/ellipses/smart-quote normalization, Word-cruft stripping
- Insertion is a **suggested edit, not a direct commit** — the same shape
  as the canonize flow (`import-scratchpad.js`): compose the imported
  fragment onto the boundary sentence as ONE suggestion via the ordinary
  suggestion PUT (stale-migration guard included). Preview before filing;
  review in the studio; then the existing Push (github) / Commit (local)
  flow lands it, and migration runs as usual. The server stays both
  docx- and markdown-ignorant — no new import endpoint at all.
- **Anchor requirement**: a suggestion needs a committed boundary
  sentence, which an empty manuscript lacks. Solved in §2: creation seeds
  the initial commit with `# <Display Name>`, so every manuscript always
  has an anchor (the trailing-page `+` composes onto the last sentence).
- **No separate permission**: importing files a suggestion, so it is
  covered by `suggest-edits` (see PERMISSIONS_PLAN §3 — `import-content`
  subsumed). Editor imports, author reviews and pushes — exactly the
  Kichurchak workflow.

## 6.5 Insert a sentence between sentences **[R — new]**

Long-standing annoyance: adding a sentence between two existing sentences
has always meant opening a suggestion on one of them and typing the new
sentence *inside* it. Import-as-suggestion is built on exactly the
composition that fixes this, so it rides along:

- Affordance: on the sentence-selection UI (where the suggestion modal
  opens today), an explicit **"insert after"** mode — user types ONLY the
  new sentence; the system composes `original + " " + new` as the
  suggestion on the anchor sentence, same shape as canonize/import.
- The diff renders as a pure insertion (word-diff against the committed
  text shows only the added sentence), so the review experience is right
  without any data-model change: still one suggestion row on the anchor,
  still the same push/migration path, and the migration processor's
  matching handles the grown sentence exactly as it does today.
- Scope guard: this is UX sugar over the existing suggestion PUT — no new
  endpoint, no schema change. If a pending suggestion already exists on
  the anchor, compose onto it (canonize already defined this precedent).

## 7. Phasing

- **Phase 0 — registry-to-DB** (§0). Prerequisite for 1–3.
- **Phase 1 — ghost cards + creation modal, local mode only** (§1–3),
  incl. empty-manuscript tolerance and the local Commit button.
- **Phase 2 — settings modal + gears** (§4), shared field schema, remove
  inline birthday/goal editing.
- **Phase 3 — permissions** (schema + access-management UI) once
  `PERMISSIONS_PLAN.md` is approved.
- **Phase 4 — github-mode creation** (repo registry + `git_repo_access` +
  path picker).
- **Phase 5 — docx import** (§6).

Phase 5 has **no dependency on 0–4** if Ronald's manuscript is registered
via config the old way (option (a) in §3). Since importing his book is the
live goal, Phase 5 can go first.

## 8. Risk register / verify list

- Title-only `.manuscript` through bootstrap + renderer (one heading,
  zero body sentences — no crash, trailing `+` page renders).
- Chapter-sized suggestions: diff rendering + push-modal performance with
  a 5k-word insertion in one suggestion (import-as-suggestion, §6).
  Evaluate on the first real chapter; chunk-per-scene is the fallback.
- Repeated imports at the same anchor (e.g. chapters 1 and 2 both onto the
  trailing sentence before either is pushed): canonize-style composition
  must hold up, or the UX should nudge "push before next import".
- Registry-to-DB: webhook matching parity, existing wildfire manuscript
  migrates losslessly, `manuscript_id` stability (annotations reference
  migrations, which reference manuscript_id — must not change).
- Local-repo backups (explicit TODO before any real content goes local).
- Concurrent commit+migrate on local repos (single-flight lock per
  manuscript; the migration queue already serializes — reuse it).
- mammoth.js output quality on real Word files (italics, em-dashes,
  footnotes?) — evaluate on the first real .docx before committing to the
  browser-side approach.
- Card gear inside `<a>`: click/propagation on touch devices.
