# Open questions & warnings — permissions v3 / multi-user build

Collected while building from the 2026-08-21 stream-of-consciousness spec,
per "leave aside any questions you need me to answer / warnings to give me
in a separate doc". Each item notes the DEFAULT I implemented so you can
review by exception. Nothing here blocks using what shipped.

## Interpretation calls (review these first)

1. **"Stale" scope.** You said suggestions from "a previous commit hash"
   go stale. Taken literally, EVERY commit stales every pending suggestion
   — including ones whose sentence didn't change at all, which would break
   the accept→push loop (the push itself migrates and would stale
   everything not yet pushed, and a text-identical sentence's diff is
   still perfectly valid). **Default:** a carried suggestion stays FRESH
   when its sentence's text is unchanged (confidence 1.0 pairing) and goes
   STALE when the sentence text changed. Never dropped either way.

2. **Sentences with NO successor.** "Our migration always maps sentences
   to other sentences" — mostly, but a deleted sentence can have no
   pairing at all. **Default:** such suggestions keep their old
   sentence_id (invisible in the new migration, exactly today's orphan
   behavior). A positional fallback ("attach to the nearest surviving
   neighbor") is possible but felt too surprising to guess at.

3. **People-tab order: per-viewer or global?** **Default: per-viewer** —
   each user's drag order controls which suggestion THEY see rendered.
   A global order would let the author decide for everyone; say the word.

4. **People tab visibility.** It reveals the full access list.
   **Default:** visible to roles with `see-others-edits` (author, editor,
   beta-reader); readers don't get the tab (they can't see others' edits,
   so the ordering would do nothing for them anyway).

5. **Who manages `pointer` and `admin` grants?** manage-role-admin and
   manage-role-pointer went to **admin only**; author manages
   author/editor/beta-reader/reader. Flag if authors should hand out
   pointer.

6. **Accepting your OWN suggestion** needs no permission (that's the
   "accept all uncontested own" flow), and editing a suggestion resets its
   review status to unreviewed (an accepted-then-edited suggestion is a
   different suggestion). Rejecting your own is also free.

7. **"Uncontested"** = no OTHER user has a live (fresh, non-rejected)
   suggestion on the same sentence.

8. **Push scope.** The push/commit button now pushes **accepted
   suggestions only** — dropdown offers "all accepted" (default primary,
   People-order winner on per-sentence conflicts) and "own accepted".
   Today's one-click behavior = "Accept all own uncontested" (also in the
   dropdown) followed by push.

9. **Creator's roles.** Creating a manuscript grants **admin only** (per
   "why do I get to manage access" + your Ronald plan where you're not the
   author). You then assign author/editor/etc. in settings — including to
   yourself. Existing manuscript_access grants were expanded to
   admin+author+editor+pointer so nothing you can do today is lost.

10. **`create-manuscript` (server-level)** is still ungated — any
    logged-in user sees the ghost card. The grant-storage decision from
    PERMISSIONS_PLAN v2 §6 is still open.

11. **Public manuscripts** ("maybe a manuscript can be made public…
    andrewcheong.com/manuscripts/<slug>") — NOT built; it was phrased as a
    maybe and it's a non-authed surface with real security weight
    (unauthenticated route, slug enumeration, cache headers). Needs its
    own pass.

12. **Suggest-modal rail DRY with the sketch editor:** the modal's left
    rail reuses the sn-rail look (same CSS family) but not the sketch
    widget's code — the sketch rail is welded to variation state. Deeper
    DRY would mean extracting a shared rail component; noted as debt, not
    done.

13. **Notes "retask/retag" by author/editor**: implemented as
    manage-others-notes gating the EXISTING note-update endpoint fields
    (task type, tags, priority, color, flag, complete) on others' notes;
    body/text edits of someone else's note are still blocked (only the
    owner edits their words). Flag if you wanted body edits too.

14. **Hide is per-note per-viewer and free** for anyone who can see the
    note (any role incl. beta-reader/reader-on-own? readers can't see
    others' notes, so hide only matters for see-others-notes holders).
    Hidden ≠ mute: completing by anyone still clears it for everyone.

15. **Points grid on the landing page** is now pointer-gated. If a
    non-pointer ever should see their OWN received points, that's a new
    view (park).

16. **Outline for readers:** reader sees NO outline tab (your list). The
    book itself still renders headings, so this is just chrome gating.

## Warnings

- **Prod data migration (changeset 038)** expands every manuscript_access
  row into admin+author+editor+pointer role rows. manuscript_access stays
  in place (unread) as a safety net; a later changeset can drop it.
- **The migration processor now carries suggestions across ALL pairings**
  (previously only text-identical ones). Your existing wildfire
  suggestions gain longevity, not risk — but the first post-deploy
  migration will re-attach any fuzzy-matched pending suggestions as STALE
  instead of orphaning them. Review them via the modal rather than
  expecting them to vanish.
- **Multi-user rendering picks a per-sentence winner** (your People
  order). With only you on the wildfire nothing changes visually.
- Dev-server note from earlier still stands: your 5001 `make dev` runs an
  old binary (from worktrees/mobile-round) against the migrated dev DB —
  rebuild + restart it from main after merge.
