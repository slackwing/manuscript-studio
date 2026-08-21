# Spec: Roles & permissions (v3) + multi-user suggestions/notes

Status: **v3 IMPLEMENTED 2026-08-21** from Slackwing's second review
(stream-of-consciousness message). v2's open questions were resolved by
that message; new interpretation calls live in `OPEN_QUESTIONS.md` with
the defaults chosen. History: v1 (author-only trio), v2 (ownership rule +
static roles.json — both superseded but their machinery survives here).

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
- **Creator of a manuscript gets `admin`** — nothing else. Assign
  content roles in settings (including to yourself).
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
| `manage-others-suggestions` | accept / reject others' suggestions (own accept/reject is free) |
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
| manage-others-suggestions |   | ✓ | ✓ |   |   |   |
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
- **Review**: accept/reject own = free; others' = `manage-others-
  suggestions`. "Accept all own uncontested" endpoint marks every own
  fresh unreviewed suggestion accepted where no other user has a live
  suggestion on that sentence.
- **Rendering**: the manuscript's red/green diff per sentence shows the
  top-ordered user's FRESH non-rejected suggestion (your People-tab drag
  order; you always outrank by default your own initial order = role
  desc, then account age). Reviewed suggestions render a superscript
  ✓ / ✗ after the diff. Sentences carrying only STALE suggestions get the
  dotted-underline affordance instead of a diff.
- **Modal**: the left pane grows a rail — "0" = the live view (your own
  editable suggestion, as today), then a letter button per OTHER user
  with a suggestion here (read-only view), then entries for STALE
  suggestions. Accept/Reject buttons under the left pane appear per the
  permission rules.
- **Migration**: suggestions are carried on EVERY old→new pairing (any
  confidence), never dropped: text-identical → still fresh; text changed
  → `stale = true`. (No-successor sentences keep their old attachment —
  OPEN_QUESTIONS #2.) Review status rides along.
- **Push/Commit** (`commit-and-push-suggestions`) applies **accepted**
  suggestions only. Scopes: `all-accepted` (People-order winner on
  conflicts) and `own-accepted`. Same semantics local and github; local
  still commits + migrates in one request.

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
age, drag-to-reorder (persisted per viewer). The order is the suggestion-
display priority in §4.
