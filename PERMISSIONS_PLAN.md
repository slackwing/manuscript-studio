# Spec: Roles & permissions (v3) + multi-user suggestions/notes

Status: **v3.2 IMPLEMENTED 2026-08-21** (v3.1 + review round 3: creator
gets admin+author; accepting is EXCLUSIVE per sentence — the 409 at
accept time replaces any push-time conflict resolution; People order is a
localStorage display preference, not server state).
Previous: **v3.1** (v3 + Slackwing's review of
OPEN_QUESTIONS). v3.1 delta: `manage-others-suggestions` became
**`manage-suggestions`** and covers one's OWN suggestions too — accepting
changes the manuscript, so readers/beta-readers file suggestions but
never accept, not even their own. Interpretation history in
`OPEN_QUESTIONS.md`; deferred follow-ups in `DEFERRED.md`. History: v1
(author-only trio), v2 (ownership rule + static roles.json — superseded
but their machinery survives here).

## 1. Model

- **roles.json** (embedded via go:embed, served at `GET api/roles`) is the
  single source of role → action bundles. No DB-defined roles.
- **`role` table** (038): `(username, manuscript_id, role)` rows; a user
  may hold several roles per manuscript. Any row ⇒ the manuscript is
  visible. Cutover: every legacy `manuscript_access` row expanded to
  admin+author+editor+pointer (nothing the single user could do is lost);
  `manuscript_access` remains on disk but is no longer read.
- **Ownership rule** stands: your own notes/suggestions are always fully
  yours (create/edit/delete/see); the "-others" in an action name is
  literal. Actions that mutate the book (push/commit) are explicit.
- **Creator of a manuscript gets `admin` + `author`** (v3.2) — whoever
  mints a book is presumed to be writing it; reassign in settings when
  not (e.g. creating a book you'll only edit).
- **Last-admin protection**: the final admin role row on a manuscript
  cannot be removed (409); the system-token ops path is the escape hatch.
- Enforcement: `Can(username, manuscriptID, action)` (Go) computed from
  the role rows × roles.json; the session payload ships each accessible
  manuscript's effective `actions` so the frontend gates affordances with
  `hasAction(manuscriptId, action)` — same data, no drift.

## 2. Actions

| action | meaning |
|---|---|
| `see-manuscript` | open the book (admin holds this so the UI loads) |
| `see-outline` | Outline tab |
| `see-statistics` | Statistics tab |
| `see-others-notes` | others' notes render (yours always do) |
| `see-others-edits` | others' suggested edits visible (modal rail, People tab) |
| `manage-others-notes` | complete / retag / retask others' notes (never delete — hide is the universal non-destructive out) |
| `manage-suggestions` | accept / reject ANY suggestion — own included (accepting changes the manuscript; v3.1) |
| `commit-and-push-suggestions` | the Push/Commit button (github + local alike) |
| `manage-manuscript` | settings modal fields (renamed from edit-settings) |
| `manage-role-<role>` | grant/revoke that role (programmatic: the needed permission is derivable from the role name) |
| `award-points` | the points surfaces: star-pointing on tasks, landing squares grid; points always accrue to the button-presser |

Creation of one's own notes/suggestions requires no action — any role on
the manuscript suffices (this is what makes `reader` more than the
public page: you're logged in to DO something on your own layer).

## 3. Role bundles (roles.json is authoritative; this is a mirror)

|                        | admin | author | editor | beta-reader | reader | pointer |
|------------------------|:-----:|:------:|:------:|:-----------:|:------:|:-------:|
| see-manuscript         | ✓ | ✓ | ✓ | ✓ | ✓ |   |
| see-outline            |   | ✓ | ✓ | ✓ |   |   |
| see-statistics         |   | ✓ | ✓ |   |   |   |
| see-others-notes       |   | ✓ | ✓ | ✓ |   |   |
| see-others-edits       |   | ✓ | ✓ | ✓ |   |   |
| manage-others-notes    |   | ✓ | ✓ |   |   |   |
| manage-suggestions     |   | ✓ | ✓ |   |   |   |
| commit-and-push-suggestions | | ✓ | ✓ |   |   |   |
| manage-manuscript      | ✓ |   |   |   |   |   |
| manage-role-admin      | ✓ |   |   |   |   |   |
| manage-role-author     | ✓ | ✓ |   |   |   |   |
| manage-role-editor     | ✓ | ✓ |   |   |   |   |
| manage-role-beta-reader| ✓ | ✓ |   |   |   |   |
| manage-role-reader     | ✓ | ✓ |   |   |   |   |
| manage-role-pointer    | ✓ |   |   |   |   |   |
| award-points           |   |   |   |   |   | ✓ |

"public" is not a role — a future non-authed read-only page is parked
(OPEN_QUESTIONS #11).

## 4. Multi-user suggestions

- `suggested_change` gains `review_status` (NULL | accepted | rejected,
  + reviewed_by/reviewed_at) and `stale` (bool). Editing your suggestion
  resets its review to NULL.
- **Visibility**: GET suggestions returns every user's suggestions when
  the caller holds `see-others-edits`; each row carries user_id, review
  state, staleness. Otherwise own only (reader experience unchanged).
- **Review**: accept/reject — own included — needs `manage-suggestions`
  (v3.1: accepting changes the manuscript; a reader's suggestion waits
  for an author/editor). "Accept all own uncontested" (same gate) marks
  every own fresh unreviewed suggestion accepted where no other user has
  a live suggestion on that sentence.
- **Rendering**: the manuscript's red/green diff per sentence shows the
  top-ordered user's FRESH non-rejected suggestion (your People-tab drag
  order — a per-browser localStorage display preference over the
  role-seniority default; v3.2). Reviewed suggestions render a
  superscript ✓ / ✗ after the diff. Sentences carrying only STALE
  suggestions get the dotted-underline affordance instead of a diff.
- **Modal**: the left pane grows a rail — "0" = the live view (your own
  editable suggestion, as today), then a letter button per OTHER user
  with a suggestion here (read-only view), then entries for STALE
  suggestions. Accept/Reject buttons under the left pane appear per the
  permission rules.
- **Migration**: suggestions are carried on EVERY old→new pairing (any
  confidence), never dropped: text-identical → still fresh; text changed
  → `stale = true`. (No-successor sentences keep their old attachment —
  OPEN_QUESTIONS #2.) Review status rides along.
- **Push/Commit** (`commit-and-push-suggestions`) applies **exactly the
  accepted set** — accepting is exclusive per sentence (a second accept
  409s until the first is rejected/cleared; v3.2), so pushes never
  resolve conflicts. Scopes: `all-accepted` and `own-accepted`. Same
  semantics local and github; local still commits + migrates in one
  request.

## 5. Multi-user notes

- Others' notes render for `see-others-notes` holders, attributed.
- Nobody deletes another's note, ever. **Hide** (per-viewer, free,
  reversible) renders it at 50 % opacity, sorted below unhidden ones; the
  owner never knows. Completion (by owner, or others via
  `manage-others-notes`) clears it for everyone, as before.
- `manage-others-notes` = complete / retag / retask / recolor / reflag
  others' notes; the note's TEXT stays owner-only.
- beta-reader: sees, hides — changes nothing.

## 6. People tab

Third pane tab (with Outline/Statistics, gated `see-others-edits`): every
user with a role on the manuscript, sorted by highest role then account
age, drag-to-reorder (persisted per viewer per manuscript in
localStorage; v3.2). The order is only the suggestion-DISPLAY priority in
§4 — never a push input.
