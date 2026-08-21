# Plan: Public manuscripts (DEFERRED — braindump only)

Status: **NOT SCHEDULED.** Captures Slackwing's 2026-08-21 idea plus
implementation notes so the eventual pass starts warm. Nothing here is
built; "public" is deliberately NOT a role (PERMISSIONS_PLAN v3 §3).

## The idea (Slackwing, verbatim-ish)

> Maybe a manuscript can be made public, and then you'd see a link, like
> andrewcheong.com/manuscripts/<slug>, which shows the committed version —
> just the pages, not even the outline — and the manuscript studio header,
> yes, but no settings button, etc. It's a non-auth'ed area.

## Sketch

- **Toggle**: a `public` boolean on the manuscript row, flipped in the
  settings modal (gated `manage-manuscript`). Default private, obviously.
- **Route**: `GET /read/<slug>` (or `/<slug>` under the base path —
  needs care not to collide with the SPA routes), served WITHOUT the auth
  middleware. Renders the committed text of the LATEST done migration
  only: pages + header chrome, no outline/stats/people, no gear, no
  suggestion affordances, no notes — the renderer already supports a
  read-only pass; the cheap version is a server-side HTML render or a
  stripped page that loads only renderer + pagedjs with a public API
  endpoint (`GET /api/public/<slug>/manuscript`) that checks the flag.
- **Login prompt**: the public header could show "Sign in" instead of the
  user chrome, funneling collaborators to the real app.

## Security/care list (why this is its own pass)

- A brand-new UNAUTHENTICATED surface: rate limiting, no enumeration
  (404 for private and nonexistent alike), no cache poisoning via the
  base-path injection, correct robots/cache headers (author's choice:
  indexable or not?).
- The public payload must be built from committed sentences ONLY — no
  suggestions, notes, people, or word-count internals leaking through a
  reused authed endpoint.
- Slug is already URL-safe and unique (manuscript.name), but public URLs
  make renames a breaking change — maybe freeze or alias.
- Decide whether public covers github-mode books whose repo is private
  (it does — the DB copy is what's served — but say so explicitly).
