# SCRATCHPAD_PLAN — scratchpads + Canonize

**Status: implementing (2026-07-25).** Design agreed in conversation; the
DECISIONS below are the author's calls and must not drift. Implementation
notes marked *(impl)* are engineering choices under those decisions.

## 1. Purpose

Free-form workspaces for brainstorming, rough writing, and ideation — with a
first-class bridge into the book: draft prose in a scratchpad, then
**Canonize** it into the manuscript, after which the scratchpad shows a live
window onto that region of the book. Same source, visible from both places.

## 2. Decisions (locked)

1. **Editor**: ProseMirror, used as standardly as possible — for the
   *scratchpad* surface only (rich text: paragraphs, headings, lists,
   bold/italic, tables, images). ProseMirror is NOT used to edit book
   content.
2. **Book-content block**: a special PM node whose *content is plain
   `.manuscript` text edited in monospace* — exactly the suggested-edit
   workflow. Preview renders with the book renderer: no pagination, no
   suggested-edit features inside the widget; the container grows with the
   content. Commands inside are permitted (not guarded); validation happens
   at canonize time only where corruption is possible.
3. **Canonize from scratchpad**: block-level only. Creates **one suggested
   edit** that wraps the block's (canonicalized) text in a unique block
   `&anchor#slug{label}` … `&end#slug` pair. At that moment the block (a)
   saves its text forever as an immutable snapshot, and (b) gains a
   reference `(manuscript_id, ref_slug)` — from then on it renders the
   **effective manuscript** (committed + suggestions) between anchor and
   end, resolved fresh on load. A tab switches to "As canonized" (the
   snapshot).
4. **`&end#slug`**: new command marking the end of a region opened by the
   slug's block command. Block iff sole line content (like anchor);
   invisible in the book; not in the outline.
5. **After canonize the widget is read-only** — a live view plus an "Open in
   book" jump. Suggested editing happens in the manuscript, and those edits
   show up in the widget. (Editing from inside the widget is explicitly out
   of scope for now.)
6. **Strictness**: proactively prevent broken regions. Regions may NEST
   (`&end` matches by slug) but never cross. Import targets must be
   committed sentences with no pending suggestion. Slug collisions are
   rejected at canonize time. A block whose region can't be resolved shows
   an error state and falls back to its snapshot.
7. **Import affordance**: a + between PARAGRAPHS in the book view (not
   between sentences), shown as a horizontal insertion rule; also
   fill-a-placeholder, which replaces the `&placeholder` and inherits its
   slug. Selecting "Import from scratchpad" picks a scratchpad + draft
   block.
8. **Scratchpads are DB-only and USER-owned** — not manuscript-scoped.
   Hundreds per user; one scratchpad may canonize blocks into different
   manuscripts (each block carries its own target). The Evernote-style
   homepage (cards, recents, global search) is a future, separate feature;
   v1 ships a plain list.
9. **Naming**: the operation is **canonize** (admit to the canon) — distinct
   from the existing text-normalization layer *canonicalize*
   (CANONICALIZE_PLAN.md), which canonize *uses* on import.

## 3. `&end#slug` (segman v2.3.0 + command layer)

- Grammar *(impl)*: `end` is the one keyword whose token is complete with a
  bare `#slug` and no `{...}` groups (the author's syntax: `&end#slug`).
  Recognition still requires `#` or `{` right after the keyword, so literal
  "&end of story" stays prose. Slug required; brace args accepted but
  ignored. All other keywords keep the ≥1-group rule.
- segman: keyword added; block iff sole non-whitespace line content (anchor
  rule); RULE 10 atomicity applies. Scenarios + SPECS + version bump.
- manuscript-studio: `CmdEnd` parses, is a block kind, renders as nothing
  (like unchanged `&meta`), never appears in the outline, passes validation,
  and canonicalize emits it in house form (lockstep corpus updated).
- Region = effective sentences strictly between the block `&anchor#slug`
  line and the first subsequent block `&end#slug` with the SAME slug.

## 4. Storage (Liquibase 010; DB-only per decision 8)

- `scratchpad(scratchpad_id, user_id → "user"(username), title, doc JSONB,
  schema_version, created_at, updated_at, deleted_at)` — `doc` is the
  standard ProseMirror `doc.toJSON()`; soft delete.
- `scratchpad_revision(revision_id, scratchpad_id, doc JSONB, saved_at)` —
  append-only autosave history (house pattern).
- `scratchpad_block(block_id UUID, scratchpad_id, manuscript_id, ref_slug,
  label, snapshot_text, canonized_migration_id, canonized_at)` — DERIVED
  index of canonized blocks, re-extracted from `doc` on every save; the doc
  JSON remains the source of truth. Answers "which scratchpads feed this
  manuscript/anchor" in SQL.
- `scratchpad_image(image_id UUID, user_id, content_type, data BYTEA,
  created_at)` — *(impl)* image bytes live in Postgres: no Docker
  volume/mount changes, survives redeploys, fine at personal scale (10MB
  cap). Images are scratchpad-only; the book format has no images.

## 5. API (session auth + CSRF, same middleware as everything else)

- `GET /api/scratchpads` — the user's list (id, title, updated_at, counts).
- `POST /api/scratchpads` — create (empty doc).
- `GET /api/scratchpads/{id}` — doc + canonized-block index rows.
- `PUT /api/scratchpads/{id}` — autosave (title + doc); writes a revision,
  re-derives `scratchpad_block`.
- `DELETE /api/scratchpads/{id}` — soft delete.
- `POST /api/scratchpads/{id}/blocks/{block_id}/canonize` — body
  `{manuscript_id, ref_slug, label}`: the single mutation that stamps the
  block's attrs (ref + snapshot + canonized_at) into the doc JSON
  server-side and upserts the index row. The *suggestion* itself is created
  client-side first via the existing `PUT /api/sentences/{id}/suggestion`
  (reusing its stale-migration guard and validation); this endpoint is step
  2. Not atomic across the two steps *(impl)*: a crash between them leaves a
  draft block + an orphan suggestion — re-canonize then reports the slug
  already exists and the user deletes one. Accepted.
- `POST /api/scratchpad-images` (multipart) → `{image_id}`;
  `GET /api/scratchpad-images/{id}` — serve with auth + long cache.

## 6. Scratchpad frontend (`web/scratchpad/`, own page `scratchpad.html`)

- *(impl)* One page: left sidebar (list, create, rename, delete, open),
  main column editor. Evernote-style homepage comes later (decision 8).
- ProseMirror via pinned esm.sh import map *(impl — same CDN posture as
  paged.js/smartquotes; exact versions pinned; packages share dep URLs so
  there is exactly one prosemirror-model instance)*.
- Schema: doc, paragraph, heading(1–3), bullet/ordered list, blockquote,
  horizontal_rule, image (from `scratchpad_image`), table (prosemirror-
  tables), text; marks strong/em; plus **book_content** — an atom node,
  attrs `{blockId, text, manuscriptId, refSlug, label, snapshotText,
  canonizedMigrationId, canonizedAt}`.
- **book_content NodeView**:
  - Draft: tabs *Edit* (monospace textarea → node attr `text`; suggested-
    edit muscle memory) and *Preview* (book render).
  - Canonized: tabs *Live* (region resolved from the effective manuscript)
    and *As canonized* (snapshot render); read-only; "Open in book" link;
    unresolvable region → error banner + snapshot fallback (decision 6).
  - Book rendering reuses the real pipeline — command.js, canonicalize.js,
    placeholder.js, renderer.js are loaded on the page and
    `renderSentencesToHTML` is called directly with pre-computed effective
    sentences (renderer.js init no-ops without a manuscript_id; without
    Paged.js there is no pagination and the container grows — exactly the
    non-paginated path the renderer already has). The rendered HTML lives in
    a **shadow root that links book.css** *(impl)* so book typography (and
    the placeholder hatch geometry) applies without leaking page-wide book
    styles into the PM editor. The placeholder layout pass runs against the
    shadow root.
- Live resolution: for each distinct target manuscript, fetch latest
  migration + manuscript + suggestions (existing endpoints), canonicalize
  each sentence's effective text, segment, and scan for the region (§3).
  Runs on load + a refresh button.

## 7. Book-side import (`web/js/import-scratchpad.js`)

- Hovering the gap between paragraphs shows a horizontal insertion rule
  with a +. Eligible gaps only: both neighbors committed, boundary sentence
  suggestion-free (decision 6/7).
- Click → modal: pick scratchpad → pick DRAFT block → slug (validated
  against the effective slug set + `[a-z0-9-]+`) + optional label →
  **Canonize**: builds suggested text = boundary sentence's text +
  `\n\n&anchor#slug{label}\n\n` + canonicalized block text + `\n\n&end#slug`,
  PUTs the suggestion, then calls the canonize endpoint (§5).
- Placeholder fill: a block `&placeholder`'s hover offers "Fill from
  scratchpad" — same modal, slug pre-filled from (and locked to) the
  placeholder's slug; the suggestion targets the placeholder's own sentence
  and REPLACES its command token with the region.
- Header gains a "Scratchpads" link.

## 8. Out of scope (explicitly deferred, not rejected)

Homepage/dashboard + global search; suggested editing from inside the
widget; scratchpad sharing; images/tables in the BOOK; realtime multi-tab
(prosemirror-collab steps log); server-side region resolution.

## 9. Test surface

segman scenarios (&end); Go: CmdEnd parse/validate/canonicalize lockstep,
scratchpad handlers (CRUD, block extraction, canonize, images); node unit:
region resolver + suggested-text builder; Playwright: scratchpad page e2e
(create → block → canonize into test manuscript → suggestion exists → book
renders region → widget Live/snapshot tabs), classified per N10.
