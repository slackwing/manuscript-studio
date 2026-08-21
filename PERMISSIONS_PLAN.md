# Spec: Roles & permissions

Status: **DRAFT v2 — spec only, approve before implementing.**
v2 (2026-08-21) incorporates Slackwing's review: static roles.json, the
ownership rule (no more "-others" actions), lightweight resource concept,
`role` table naming, manage-* role actions, see-* split, action catalog
regrounded in a scan of the actual route surface (`api/server.go:224-346`).

Companion: `MANUSCRIPT_LIFECYCLE_PLAN.md` (Phase 3). Naming note for that
doc: what it calls `suggest-edits` is now `add-suggestions` here.

---

## 1. Where we are today

- `user.role` column exists (default `"author"`) but nothing reads it.
  Deprecated by this spec; drop in a later changeset.
- Real authorization is `manuscript_access`: binary per-user,
  per-manuscript. A grant means everything; no grant, no login.

## 2. Model

### 2.1 Roles live in a static `roles.json`

One file, the single source of truth for role → action bundles:

```json
{
  "roles": {
    "admin":  ["edit-settings", "manage-admins", "..."],
    "author": ["see-manuscript", "..."]
  }
}
```

- **Backend**: `go:embed`, loaded at startup into the check function.
- **Frontend**: served verbatim (static file or `GET api/roles`). The
  session payload already tells the client its roles per manuscript; with
  roles.json it computes the same effective action set the backend uses.
- This gives the two layers cleanly: **UI hides affordances** the action
  set doesn't include; **backend enforces at every API entryway**. Same
  data, one definition, no drift.
- v1 has no custom/DB-defined roles; changing a bundle is a deploy.

### 2.2 Assignments: the `role` table

`role (username FK, manuscript_id FK, role TEXT, PRIMARY KEY (username,
manuscript_id, role))`.

Named plain `role` (not `manuscript_role`) per review — the
`manuscript_id` column already carries the scope, and the role
*definitions* live in roles.json, so the table can't be confused for a
role catalog. Rows are grants; a user may hold multiple roles on one
manuscript (Slackwing = `admin` + `editor`; Ronald = `author`).

- Visibility/login rule: any row ⇒ the manuscript is visible in /home
  (replaces `manuscript_access`, which is dropped after cutover).
- Migration: each `manuscript_access` row expands to `admin` + `author` +
  `editor`, then prune by hand.
- **Invariant: every manuscript keeps ≥1 admin.** Enforced as last-admin
  protection: removing/demoting the final `admin` row is rejected
  in-transaction. The system-token ops path bypasses it (lockout
  recovery). Creator is auto-assigned `admin` at creation.

### 2.3 The ownership rule (replaces all "-others" actions)

> **You always have full control of resources you own.** Every action
> verb in the catalog therefore implicitly means "on resources you do
> NOT own."

So there is no `complete-others-notes`; there is `complete-notes`, and
completing/editing/deleting/seeing your *own* note needs no action at
all. Same for suggestions, scratchpads, sketches, task types, daily
rules — the whole user-owned productivity cluster (daily-rules,
task-types, point-events, note-actions routes) needs **zero role rows**;
the ownership rule alone governs it.

**One carve-out**: actions that mutate the *manuscript or its repo* are
never implied by ownership, even of your own resources — accepting your
own suggestion still rewrites the book. These stay explicit:
`accept-suggestions`, `push-suggestions`, `commit-local`. (Creating a
resource is also not ownership of anything yet, so `add-*` actions are
explicit grants too.)

### 2.4 Resources — lightweight, yes; framework, no

Adopt the *concept*: a resource is `{type, owner, manuscript_id?}` —
types today: manuscript, note, suggestion, scratchpad, sketch/variation,
task-type, daily-rule. Its only job is to feed the standard check
function so the ownership rule lives in exactly one place:

- Backend: `Can(username, action, resource) bool` — ownership shortcut
  first, then roles.json lookup over the user's `role` rows for
  `resource.manuscript_id`. Used by every handler.
- Frontend: `can(action, resource?)` — same logic over the served
  roles.json + session roles. Drives affordance visibility only; the
  backend check is the real gate.

What we deliberately do NOT build: a generic resource table, per-resource
ACLs, or an action×resource cartesian (`see`+`edit`+`delete` × every
type). The catalog stays a flat, curated list; the resource struct is
just the argument that makes one shared checker possible. If a future
feature needs per-resource sharing, revisit then.

## 3. Action catalog

Grounded in the route surface (`api/server.go`). Legend: ✅ exists ·
🔮 aspirational (listed so bundles don't churn when the feature lands).

### See (visibility of others' work; own is always visible)
| action | covers |
|---|---|
| `see-manuscript` ✅ | text, migrations, outline, history, stats, wordcount, push-state; sketch-from-selection reads |
| `see-notes` ✅ | others' notes/annotations on this manuscript |
| `see-suggestions` ✅ | others' suggestions/variations on this manuscript |

### Contribute
| action | covers |
|---|---|
| `add-notes` ✅ | create notes (+ their tags) on sentences |
| `add-suggestions` ✅ | create/edit own suggestions — includes variations, range-deletes, placeholder edits, sketch placement/canonize, and **docx import** (all land as the same suggestion PUT) |
| `push-suggestions` ✅ | push own suggestions to a branch (github mode) |

### Moderate (inherently about others' work / the book itself)
| action | covers |
|---|---|
| `complete-notes` ✅* | complete/uncomplete others' notes (*route exists; cross-user semantics untested) |
| `accept-suggestions` 🔮 | apply a suggestion to the manuscript (flow TBD — §6, DO NOT FORGET) |
| `reject-suggestions` 🔮 | dismiss a suggestion without applying |
| `commit-local` 🔮 | Commit button on local-mode manuscripts (commit + migrate) |

### Manage
| action | covers |
|---|---|
| `edit-settings` 🔮 | settings modal: display name, birthday, word goal (today's PATCH `/manuscripts/{id}/meta` is un-gated ✅) |
| `manage-admins` 🔮 | add/remove admin role rows |
| `manage-authors` 🔮 | add/remove author role rows |
| `manage-editors` 🔮 | add/remove editor role rows |
| `manage-readers` 🔮 | add/remove reader role rows |
| `trigger-sync` ✅ | manual re-sync/migration (today system-token only) |

### Server-level (not per-manuscript)
| action | covers |
|---|---|
| `create-manuscript` 🔮 | see the ghost card; grant storage TBD (§6) |

Outside the model entirely (user-owned, ownership rule only): scratchpads
(+images), sketches/variations as objects, user-wide tags, task types,
daily rules, note-actions, point-events. Points crossovers → §6.

Dropped from v1: `manage-placeholders` and `place-sketches` (both are
mechanically `add-suggestions`); `manage-tags` (note tags ride the note;
user-wide tags are user-owned); `read-manuscript` (renamed/split into the
three `see-*` actions).

## 4. Role bundles (v1) — FOR REVIEW

|                      | admin | author | editor | reader | public |
|----------------------|:-----:|:------:|:------:|:------:|:------:|
| `see-manuscript`     |  ?¹   | ✓ | ✓ | ✓ |  —² |
| `see-notes`          |       | ✓ | ✓ |  ?³ |   |
| `see-suggestions`    |       | ✓ | ✓ |  ?³ |   |
| `add-notes`          |       | ✓ | ✓ |   |   |
| `add-suggestions`    |       | ✓ | ✓ |   |   |
| `push-suggestions`   |       | ✓ | ✓ |   |   |
| `complete-notes`     |       | ✓ |   |   |   |
| `accept-suggestions` |       | ✓ |   |   |   |
| `reject-suggestions` |       | ✓ |   |   |   |
| `commit-local`       |       | ✓ |   |   |   |
| `edit-settings`      | ✓     |   |   |   |   |
| `manage-admins`      | ✓     |   |   |   |   |
| `manage-authors`     | ✓     | ✓ |   |   |   |
| `manage-editors`     | ✓     | ✓ |   |   |   |
| `manage-readers`     | ✓     | ✓ |   |   |   |
| `trigger-sync`       | ✓     |   |   |   |   |

¹ Open question carried from v1: admin as pure administration (no read)
  is the cleanest reading of the design, but means an admin-only user
  sees settings for a book they can't open. Decide.
² `public` = the unauthenticated principal. Empty bundle in v1 — it
  exists in roles.json now so "public manuscripts" later is one line
  (`see-manuscript`) plus whatever auth carve-out that day requires.
³ Should a reader see the editorial layer (notes/suggestions), or get a
  clean reading copy? Leaning clean copy (privacy of editorial chatter);
  a `beta-reader` bundle with `see-notes` could exist later. Decide.

Notes:
- Author manages every role **except admins** — interpreting "an author
  can do the last 4" as: authors control who works on their book
  (authors/editors/readers) but not who administers the system record.
  Flag if you wanted authors adding admins too.
- Author can add other authors — role self-propagation is accepted
  (an author you add is as trusted as you).
- Editor keeps `push-suggestions` (github mode is PR-gated downstream);
  only author holds the direct-mutation trio (`accept`, `commit-local`).

## 5. Enforcement plan

- `Can` / `can` as in §2.4 — one checker per layer, both fed by
  roles.json. Every handler calls `Can`; every affordance renders behind
  `can`. No per-feature permission logic anywhere else.
- **Incremental rollout** (unchanged from v1): Phase 3 ships roles.json,
  the `role` table + migration, the assignment UI, and enforcement ONLY
  on the manage/settings actions. Content actions start permissive
  (any role ⇒ allowed) *behind the checker* — flipping one to real
  enforcement is a roles.json/checker change, not a handler rewrite.
- `/api/admin/*` system-token endpoints remain the out-of-band ops path.

## 6. Open questions / TODO

- **⚠ Accept flow for suggestions — flagged so it isn't forgotten.**
  Today the only apply-path is push → PR → merge → webhook. An in-app
  "accept" would: apply the suggestion text to the file, commit
  (+ push to canonical branch in github mode — same machinery as
  push-suggestions' force-push; plain commit in local mode), migrate.
  Interacts with: stale-migration guard, multiple pending suggestions on
  one sentence (accept one, re-anchor or invalidate the rest?), and
  whether accept exists in github mode at all or PR-merge stays the only
  door there. Needs its own design pass before `accept-suggestions` or
  `reject-suggestions` are implemented.
- **Points × permissions** (carried): points routes today are user-scoped
  (`points-daily`, `point-events`, note points). Are points per-user,
  per-manuscript, or per (user, manuscript)? Does completing someone
  else's note award whom? Spec separately before Phase 3 touches
  anything points-adjacent.
- `create-manuscript` grant storage: config username list vs a
  server-level grants table. (Leaning DB, consistent with everything
  else being DB-managed grants.)
- Admin `see-manuscript` (¹) and reader visibility (³) — see table.
- roles.json location/name (`web/roles.json` served statically vs
  embedded + `GET api/roles`) — cosmetic, decide at build time.
