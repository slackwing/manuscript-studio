# Plan: Push-to-PR feature

Status: **SHIPPED 2026-04-22**. Implemented per this plan; see
ARCHITECTURE.md §6.8 for the live design summary. Kept here for the design
notes and risk register.

Post-ship enhancement (2026-04-30): the push commit also stages a sibling
`<name>.segman` file (sentence-per-line, produced by the
github.com/slackwing/segman library and its pre-commit hook) when one
already exists at the base commit, so PR diffs can be reviewed at
sentence granularity. See ARCHITECTURE.md §6.8.

Owner notes: this captures a design discussion between Slackwing and Claude.

---

## What it is

A button in the top toolbar that pushes the current user's unmerged
suggested edits to a branch on the manuscript's GitHub repository, so the
user can open a Pull Request from there. Merging that PR triggers the
existing webhook → migration flow, at which point the merged suggestions
are no longer "live" (their old `sentence_id` is unreachable from the
new commit) and the user can write new suggestions on top of the new
commit.

Single-user only. Each user pushes their OWN suggestions to their OWN
branch. No multi-user coalescing.

---

## UI

A split-button in the top toolbar, visually separated from the
session/logout area:

- **0 unmerged suggestions:** button hidden or disabled with tooltip.
- **N > 0:** primary action label adapts to whether a branch already
  exists for the current `(commit_hash, user)`:
  - No existing branch: `[Push New (N) ▼]`
  - Existing branch: `[Push (N) ▼]`  (updates the existing branch)
- The down-arrow opens a menu with the alternate action (e.g. "Push
  New" when the default is "Push", so the user can fork off another
  proposal).
- Include a GitHub icon to make it clear this writes to GitHub.
- Click → confirmation modal showing a unified diff of the
  `.manuscript` file changes → confirm → API call.
- On success, link out to `https://github.com/{slug}/compare/{branch}`
  so the user can click "Create pull request."

The button is **disabled when the loaded migration is not the latest**.
Tooltip: "manuscript has been updated — please refresh."

---

## Backend

### New endpoint

`POST /api/manuscripts/:id/push-suggestions`

Body:
```json
{ "action": "update" | "new" }
```

Behaviour:
1. Validate that `migrationID == latest(manuscriptID)` for this manuscript.
   If not, return **409 Conflict** with `{"error": "stale", ...}`. Defense
   in depth — the frontend already disables the button in this state.
2. Validate that the manuscript has a configured `origin` and a
   read+write deploy key. If not, **501 Not Implemented** with a hint.
3. Load this user's `suggested_change` rows for sentences in the current
   migration.
4. Read `.manuscript` source from the local repo at the latest commit hash.
5. Apply suggestions via substring-replace into the file content. (See
   "Source-level edits" below — this works cleanly only after the
   raw-markdown-storage change lands.)
6. Compute a stable branch name:
   - `update`: `suggestions-{commitShort}-{username}` (deterministic).
   - `new`: `suggestions-{commitShort}-{username}-{N}` where N is the
     smallest integer such that the branch doesn't already exist locally
     OR remotely.
7. Branch from the current commit, write the modified `.manuscript`,
   commit with message `"Apply N suggested edits from {username}"`,
   force-push (for `update`) or push (for `new`) to origin.
8. Return `{branch_name, compare_url}` where `compare_url` is the
   GitHub `/compare/{branch}` URL the frontend can link to.

### Helper functions

- `internal/migrations/git.go` (or similar): `CommitAndPush(repoPath,
  branch, message)`. Uses the existing deploy-key infra; same key as
  pull (read+write).
- New `internal/sentence/apply.go` (or similar): `ApplySuggestions(source
  []byte, suggestions []models.SuggestedChange) ([]byte, error)`. Pure
  function — easy to unit-test.

### Auth + secrets

- Same SSH deploy key already configured for pull. The user enables
  "Allow write access" on the GitHub deploy key (one-time, in the GitHub
  UI). The install-script docs already point at this; we should call out
  the read+write requirement if it isn't already.
- The repo's `origin` URL must be SSH (`git@github.com:...`), not HTTPS.

### Schema

No new tables. Branches are git-side state; we look them up via `git
ls-remote` or local `git branch --list`. If we ever need to display PR
status in the UI, we'd add a `pr_state` table later — not for v1.

---

## Source-level edits

UNIFIED_DATA_SHAPE landed (commit 61d3777), so `sentence.text` already
carries raw markdown plus optional leading structural marker
(`\n\t` for new paragraph, `\n\n` for new section). Suggestions are
edited as raw text (with glyph display: `¶`/`§`) and saved in the same
storage form.

`ApplySuggestions(source []byte, suggestions []models.SuggestedChange)`:

- For each suggestion, `bytes.Replace(source, []byte(originalRaw),
  []byte(suggestionRaw), 1)`. Single replacement per sentence.
- Sentences are stored with their leading marker, so a sentence whose
  storage form is `"\n\tFoo bar."` matches the source bytes `\n\tFoo
  bar.` directly — no special-casing needed.
- Falls back gracefully (skip with warning, do not abort the whole PR)
  if `originalRaw` isn't found — e.g. someone hand-edited the file
  between segmentation and PR.
- Suggestions that contain mid-content `\n\t` or `\n\n` (user expressing
  "split this here") write that into the source verbatim. After the
  webhook→migration round-trip, the segmenter splits one sentence into
  two with the new sentence carrying the leading marker.

**Capability now unlocked**: suggestions CAN restructure paragraphs.
Previous plan revision said "structural whitespace is not part of any
sentence" — that constraint is gone with UNIFIED_DATA_SHAPE.

**Glyph translation at apply time**: the suggestion's stored form is
real `\n\t` / `\n\n` (the glyph→storage conversion happens at modal-save
time, see `web/js/text-markers.js`). So when ApplySuggestions runs
server-side, no further conversion is needed — write bytes as-is.

---

## Migration / suggestion lifecycle

When the PR is merged on GitHub:

1. GitHub webhook fires → existing migration code runs → new commit's
   sentences get fresh `sentence_id`s.
2. The migration's `bestPreviousByNew` pairs old → new sentences. For
   the EDITED sentences, the pairing will be fuzzy (text changed), so
   the suggestion is NOT copied forward. It stays frozen on the old
   `sentence_id`, unreachable from the live UI.
3. New sentence has no suggestion attached. User starts fresh.

This is correct behaviour: the suggestion was "incorporated" by virtue
of being merged. The old suggestion row is harmless audit data.

(Optional v2 cleanup: after migration, delete suggestion rows whose
text matches the new sentence's text. Skipped for v1 — leaves a
question of "what counts as match" given migration-time text drift.)

---

## Out of scope for v1

- Multi-user PRs (combining multiple users' suggestions into one branch).
- Auto-creating the PR via the GitHub API (requires PAT). User clicks
  "Create pull request" themselves on the compare URL.
- Auto-cleanup of incorporated suggestions after merge.
- Conflict detection beyond the stale-migration check.
- "View existing PR" UI. Just link to compare URL.
- Pushing to non-GitHub remotes. Designed for GitHub-hosted repos only.

---

## Open questions resolved

| Question | Resolution |
|---|---|
| One branch per `(commit, user)` or also per click? | Default `update` reuses the branch; `new` lets the user fork. |
| Whose suggestions go in? | Calling user only (single-user feature). |
| What happens to suggestions after merge? | Stay frozen on old `sentence_id`. Harmless. |
| SSH key for push? | Same deploy key as pull, with write enabled. User responsibility to flip the GitHub setting. |
| Stale-state handling? | Refuse with 409 if migration ≠ latest. Button also disabled client-side. |
| Markdown loss in suggestions? | RESOLVED in UNIFIED_DATA_SHAPE (commit 61d3777). Storage carries raw markdown + structural markers. |
| GitHub API to auto-create PR? | No (v1). Link to compare URL. |
| Branch name prefix? | `suggestions-` (NOT `claude-suggestions-`; suggestions come from the user, not Claude). |
| Button label? | `Push` / `Push New`. Not "Open PR" — pushing the branch is what we actually do. |

---

## Implementation order

1. ~~(Prereq) Land raw-markdown-storage change.~~ DONE in commit 61d3777.
2. Backend endpoint + helpers + Go integration test:
   - `internal/sentence/apply.go` — pure `ApplySuggestions(source,
     suggestions)` returning new file bytes. Unit test covering: no-op
     suggestion, single substring replace, suggestion adding `\n\t`
     mid-content (paragraph split), unfound-original (skip with warn),
     multiple suggestions in one file.
   - `internal/migrations/git.go` — extend with `CommitAndPush`. Mock
     the actual `git push` in tests; assert local branch contents.
   - `api/handlers/suggestions.go` — new `HandlePushSuggestions`. Stale
     check, action enum, branch naming, calls into the helpers above.
3. Frontend split-button + modal + diff preview.
4. End-to-end Playwright test: write suggestion → push → verify branch
   exists in local repo with correct content. Skip the actual GitHub
   push in tests (the local clone has no real remote in dev).
5. Document in `docs/API.md`, `ARCHITECTURE.md`, `AGENTS.md`.

---

## Risk register

- **Push fails silently** → user thinks PR opened but nothing on GitHub.
  Mitigation: surface the push exit code in the API response; show
  error in modal.
- **Branch sprawl** if user clicks "New" repeatedly without merging.
  Mitigation: nothing for v1. If it gets bad, add a "delete old
  suggestion branches" admin action.
- **Stale local clone** (someone pushed to `main` between webhook and
  user's edit). Mitigation: stale-migration check catches the common
  case; rare race is accepted.
- **Force-push on update** could clobber a hand-pushed commit on the
  same branch. Mitigation: don't push hand commits to a `suggestions-*`
  branch; document the reserved name prefix.
