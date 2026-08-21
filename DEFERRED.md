# Deferred — agreed-but-not-scheduled work

Kept small and honest: each item names its origin so context is one hop
away. Prune when shipped.

- **Public manuscripts** — non-authed read-only page per manuscript
  (`PUBLIC_PLAN.md`). Origin: OPEN_QUESTIONS #11.
- **Replies to Notes; @-tagging people; an Inbox of @'s.** Origin:
  Slackwing, 2026-08-21 review round 2 (item 13). Multi-user notes
  shipped without threading; replies + mentions + an inbox surface are
  the natural next layer.
- **Shared rail component** — the suggest-modal's user rail
  (`suggestions.js mountUserRail`) and the sketch widget's variation rail
  share the `.sn-rail` CSS family but not code. Cross-reference comments
  exist at both sites; extracting one real component keeps the look from
  drifting. Origin: OPEN_QUESTIONS #12.
- **Phase 4: github-mode creation from the UI** — repo picker over a
  `git_repo_access` table + path/branch fields in the creation modal.
  Manuscripts on external repos are config-registered meanwhile.
  Origin: MANUSCRIPT_LIFECYCLE_PLAN §7.
- **`create-manuscript` gating** — POST /api/manuscripts (the ghost card)
  is currently open to ANY logged-in user; a server-level grant needs a
  home (config list vs DB table) since it isn't per-manuscript.
  Origin: OPEN_QUESTIONS #10.
- **git/local prod backups** — server-owned repos exist nowhere else;
  nightly `git bundle`/mirror of `<repos_dir>/git/local/` still needs to
  be set up on the VM. Origin: MANUSCRIPT_LIFECYCLE_PLAN §3 (hard TODO).
- **Points × roles follow-ups** — pointer role shipped; whether pointers
  see others' received-points views, and any per-manuscript vs global
  pointer nuances. Origin: PERMISSIONS_PLAN v1 §6 (points TODO).
- **Drop `manuscript_access` + `user.role`** — both unread since v3;
  remove in a later changeset once a deploy cycle has proven the role
  table. Origin: PERMISSIONS_PLAN v3 §1.
