# CODE REVIEW — August 2026

**Reviewed at:** `main` @ `01c62c9` (2026-08-17). Line references are valid at this
commit (the reviews ran against `b27b3d8`; the only commits since touch docs and
`tests/` files not referenced below).

**Purpose:** identify the top 3 areas that are a mess / likely to drift and break
under continued incremental patching, and for each one list EVERY test needed for
full behavioral coverage — with `file:line` references — so the area can be
rewritten and validated by re-running those tests. **No tests are written yet;
this is the plan.**

**Method:** four parallel deep reviews (render+suggestion pipeline, scratchpad
editor subsystem, Go backend, notes UI + CSS), then ranked by mess density ×
patch frequency × evidence of drift already having happened.

**Test-type legend used throughout:**
- **U** — node unit (no browser; some need a `module.exports` added or run via
  `page.evaluate` on a synthetic page)
- **I** — Go integration test against the dev DB
- **E** — Playwright e2e against the dev server
- ⚠ — pins behavior that is **currently buggy**; write to intended semantics
  (fails until the bug is fixed)

---

# THE TOP 3

| Rank | Area | Size | Why it wins |
|---|---|---|---|
| 1 | `web/scratchpad/editor-core.mjs` + satellites | 2,431 ln (67% of a 3,617-ln subsystem) | 14 unrelated concerns in one file; a hand-rolled duplicate of the shared autosaver **with a live data-loss bug**; 14 mutable module globals; the subsystem where this week's only real test failures live |
| 2 | `internal/database/queries.go` + `variations.go` | 2,478 + 734 ln | 72-method god-file across ~17 tables; **proven silent drift** (note column lists already diverged); transaction and auth inconsistencies incl. 3 security gaps; **effectively zero direct Go test coverage** |
| 3 | Render + suggestion pipeline (`renderer.js`, `suggestions.js`, `pagedjs-config.js`, `command.js`) | ~2,200 ln | Highest invariant density in the repo (25 hidden ordering/parity invariants); a 185-line state machine every feature passes through; 74 lines of dead code and three stale comments actively misleading the next patcher |

**Runner-up** (not in the top 3, findings preserved in Appendix A): notes UI +
`book.css` — ~260 dead CSS lines, the gutter geometry constants copied 5×
across 3 files, a z-index ladder enforced only by comments, one latent
wrong-sentence-PUT bug, one attribute-injection surface.

---

# AREA 1 — Scratchpad / editor subsystem
`web/scratchpad/editor-core.mjs` (2,431), `modal.mjs` (260), `region.js`,
`scratch-render.js`, `web/js/scratchpad-modal.js`, `web/js/import-scratchpad.js` (349),
`web/js/edit-pane.js`

## 1.1 What's wrong

**One file, ~14 concerns.** editor-core.mjs holds: the ProseMirror schema
(46–145), a legacy-doc migrator (`modernizeDoc` 154–205), an HTTP client
(`apiCall` 233–246), a per-manuscript data cache (`bookData` 211–229), scroll
telemetry (362–427), a scroll-physics engine (`holdScroll` 429–489), an
805-line NodeView class (`SketchView` 491–1296), a note subsystem
(1332–1764), toolbar construction (2164–2250), two popover menus (1889–2070),
and the doc autosave/close-guard machine (2079–2431).

**The autosaver is duplicated and the copy has a data-loss bug.**
editor-core:2100–2162 re-implements `edit-pane.js`'s `createAutosaver`
(edit-pane:53–116) — same backoff formula, same countdown quirk — but WITHOUT
the in-flight-change "chase" (edit-pane:98). Consequence (**live bug**):
`saveNow` (2129–2155) snapshots the doc at fetch time; keystrokes typed while
the PUT is in flight set `saveState='unsaved'`, then line 2147
**unconditionally** sets `'saved'` when the PUT resolves — masking them. For
up to the 1.2s debounce window `isDirty()` is false while the doc holds
unsaved text; `modal.close()` skips the guard and `destroy()` (2415, 2420)
discards the pending save. This is DRY.md item 3's strongest argument.

**Other duplication:** `appendReloginLink` (editor-core:30–42) ≡
edit-pane:64–76 verbatim; CSRF getter ×4 (editor-core:24, modal.mjs:100, :132,
import-scratchpad:14); HTML escaper ×4 with drift (scratch-render:74 escapes
fewer entities); two fetch wrappers with different error shapes used by the
SAME endpoint family (`variationApi` 253–278 mixes them); trailing-paragraph
rule implemented twice (plugin 2296–2315 vs open-pass 2340–2358); rail-button
wiring, copy-ref handler, state-toggle, and search-picker popover each
duplicated internally; canonize write-path exists twice with different plans
(import-scratchpad:244–290 vs `placeVariation` 1113–1155).

**State:** 14 mutable module globals (250, 330, 331, 336, 367, 440, 447, 1336,
1423, 1426, 1537, 1540, 1647, 1744); reset discipline is partial —
**`noteCache` (1423) is never invalidated across modal opens**, so a note
recolored between pad opens renders stale (1572–1574). Icons are dereferenced
at module-evaluation time (302–303, 1548) — an invisible load-order bomb. A
bare global `fetchJSON` is used from an ES module with no import.

**Smaller defects:** `buildNoteColorBar` called with 3 args, takes 2 (2218 vs
1745) and its doc comment describes registration that doesn't exist;
import-scratchpad's button says "Place" (147) but error-path resets it to
"Canonize" (313); cache-bust versions hand-pinned in two places
(scratchpad-modal:13, modal.mjs:7).

## 1.2 Invariants a rewrite must preserve

1. Variations flush **before** the doc PUT (2134 → 2136); `saveNow`'s return is
   the variations result, not the doc's (2148) — close refuses if any widget
   flush failed.
2. `destroy()` ordering (2412–2429): flush → `destroyed=true` (suppresses
   retry at 2152) → remove listeners → conditional final save →
   `editorTearingDown=true` strictly around `view.destroy()`. Reorder those 4
   lines and every note in the pad is soft-deleted on close (defense at
   1624–1640).
3. `NoteRefView.update()` (1615–1621) is load-bearing — removing it re-opens
   silent note deletion. `destroy` soft-deletes only after a `setTimeout(0)`
   re-scan proves the ref left the doc (1629–1640); `suppressNoteDelete` is
   consulted synchronously (1624).
4. `modernizeDoc` guarantees on open: no `book_content`, no idless `snippet`
   (191–192), no `noteAnchor`/`noteHighlight` (157–187), fallback skeleton
   (204). `noteRef` stores `{noteId, text}` — **color is deliberately not in
   the doc** (97–103); recolor never touches the doc (1494–1501).
5. Every `snippet` block is followed by a non-snippet block and the doc ends
   with a paragraph (plugin 2296–2315 + open-pass 2340–2358 — both).
6. `renderEdit` parks the PM selection just after the widget before mounting
   the textarea (879–883) — Firefox otherwise scrolls the pad to the top.
7. Close-guard semantics differ **on purpose** per surface: pad refuses to
   close unsaved (modal.mjs:240–242); suggest-edit flushes; Escape inside a
   sketch textarea exits edit only via `stopPropagation` (946) — modal.mjs's
   handler (71–72) must stay bubble-phase.
8. `region.js` asymmetry is deliberate: `resolve` (19–78) runs on
   **canonicalized** effective text; `replacePlan` (87–133) on **raw**
   effective text so the plan composes with in-flight edits (comment 84–86).
   Offsets are code-point based (`Array.from`, 27–34).
9. `renderCanon` retries resolution exactly once force-fresh (1214–1220) and
   shows an error, never a stale snapshot (1198–1201); `placeVariation`
   re-fetches before placing (1117–1119).
10. One scroll hold per host; during `suspendScrollHolds` the pin **rebases
    instead of fighting** (459–462) — settle-scrolls depend on it
    (modal.mjs:199, 219).
11. The `'snippet'` node type name (86–88) and the three region spellings
    (`&anchor#`/`&snippet#`/`&sketch#`, region.js:40,106) are frozen forever.
12. `#scratchpad=N` hash via `replaceState` only (modal.mjs:91–96), cleared on
    close only if still a scratchpad hash (253–257); `_open` serializes on
    `this.opening` and refuses to stack pads (27–39).

## 1.3 Existing coverage

`test-region-resolver.js` (resolve only — NOT replacePlan), `test-canon-render-pipeline.js`,
`test-snippet-save-race.js` (one-flusher discipline 927–934), `test-save-resilience.js`,
`test-session-guard.js`, `test-scratchpad-canonize.js`, `test-scratchpad-notes/-note-tags/-manuscript-link.js`,
`test-sketch-place-push.js`, `test-sketch-rail-compare.js`, `test-sketch-restore.js`,
`test-sketch-sibling-refresh.js`, `test-sketch-navigate.js`, `test-sketch-from-selection.js`,
`test-snippet-editor/-caret/-edit-anchor/-edit-scroll/-no-scroll-jump/-leading-indent.js`,
`test-trailing-snippet-caret.js`, `test-legacy-note-doc.js` (happy path only),
`test-noteref-survives-edits.js`, `test-note-delete-restores-text.js`,
`test-double-click-trash.js`, `test-landing-note-deeplink-scroll.js`,
`test-canonize-compose.js`, `test-editor-shortcuts.js`, `test-suggest-edit-pane.js`.

## 1.4 Tests needed (full-coverage inventory)

### Save machine & close guard
| Name | Type | Covers | Behavior |
|---|---|---|---|
| doc-save-inflight-typing ⚠ | E | editor-core.mjs:2129–2161 | type during in-flight (slowed) doc PUT → status must not read Saved / `isDirty()` stays true; immediate close must not lose keystrokes |
| doc-save-retry-ladder | E | :2110–2121 | failing PUTs → countdown 2,4,8…60, attempt cap 6, success resets |
| close-refused-while-failing | E | modal.mjs:236–243, editor-core:2148 | server 500ing → Escape/backdrop/× leave pad open, countdown visible; recovery allows close |
| close-refused-by-variation-flush | E | :2124–2134, :2148 | doc PUT ok but one widget flusher fails → `saveNow()` false, pad stays open |
| destroyed-saver-no-retry | E | :2152, :2328, :2412–2420 | destroy with pending failure: no retry after teardown; no dispatch after `destroyed` |
| title-input-autosaves | E | :2362–2363, :2139 | title edit alone marks Unsaved and persists on flush |
| session-restored-flushes-variations | E | :2366–2369 | dirty variation + `ms:session-restored` → immediate flush |
| frozen-409-pins-status | E | :919 | variation frozen under an open editor → "frozen — not saved", no retry loop |

### Schema & modernizeDoc
| Name | Type | Covers | Behavior |
|---|---|---|---|
| modernize-idless-snippet-drop | U | :191–192 | idless snippet + `book_content` removed; doc valid |
| modernize-orphan-highlight | U | :179–182, :175 | highlight without anchor → mark stripped; anchor with noteId 0 → plain text |
| modernize-multi-note-run | U | :157–187 | anchor + several highlighted nodes fold to one noteRef; recurses into blockquote/list |
| modernize-empty-root | U | :204 | null/garbage → `{doc:[paragraph]}` |
| schema-roundtrip | U | :46–145 | JSON→PMNode→toJSON identity across every node/mark type |
| noteref-todom-persistence | U | :116–120 | serialized span carries data attrs, no color class |

### API layer & caches
| Name | Type | Covers | Behavior |
|---|---|---|---|
| apicall-error-shape | U | :233–246 | non-ok → Error with `.status` + body; 204 → null |
| bookdata-cache-semantics | U | :211–229 | same promise reused; `force` refetches; rejection self-evicts (226); suggestions failure tolerated (222) |
| bookdata-invalidation-on-place | E | :1149 | after place, canon pane shows the new region without reload |
| notecache-staleness ⚠ | E | :1423–1451, :1572–1574 | recolor between pad opens → fresh color on reopen (currently stale) |
| parse-variation-ref | U | :319–323 | valid/whitespace/rejects malformed |
| letterof-fmtdeleted | U | :282–291 | ordinal 0 → `·`; invalid ISO → `''` |
| find-normalized | U | :1352–1387 | smartquote/markdown tolerance; nearest-to-hint occurrence; empty → −1 |

### SketchView
| Name | Type | Covers | Behavior |
|---|---|---|---|
| widget-load-failure | E | :514–522 | context 404 → "unavailable" + working remove (no soft-delete, :1266) |
| refresh-keeps-compare | E | :527–538 | compare survives sibling refresh; closes if target vanished |
| readonly-mono-view | E | :858–863, :1077–1090 | frozen/superseded click → readOnly mono; blur returns to render |
| supersede-toggle | E | :643–644, :571 | ↓ toggles superseded↔draft; classes + rail colors update |
| place-fallback-plan | E | :1136–1146 | place-plan endpoint 500 → client `replacePlan` still places |
| place-ineligible-noop | E | :1114–1115 | place on non-canonized/unlinked sketch no-ops |
| canon-from-placed | E | :1180–1196 | ❦ pane ✨ seeds variation from `regionRawText`; widget inserted after; siblings refresh |
| canon-region-retry-and-error | E | :1210–1226 | stale cache → one forced retry; missing region → error, never stale text |
| goto-no-home | E | :1161–1168 | variation without home pad → alert, no hash change |
| remove-widget-delete-fails | E | :1266–1272 | soft-delete 500 → widget kept + alert |
| widget-registry-cleanup | E | :1287–1293 | close+reopen: flusher/live-view registries don't accumulate |
| cluster-relocation | E | :767–780 | compare toggle relocates the same DOM node; buttons clickable immediately |
| peer-switch-while-loading | E | :1013, :1221 | swap compare during slow fetch → late response discarded |

### Notes (in-pad)
| Name | Type | Covers | Behavior |
|---|---|---|---|
| note-create-empty-selection | E | :1457–1458, :2249 | empty selection: squares disabled |
| note-complete-removes-ref-keeps-note | E | :1711–1716, :1541–1545 | complete removes ref WITHOUT soft-deleting the note |
| sketch-note-complete-square | E | :1666–1674, :1710–1713 | square → green check; no doc edit; no delete affordance |
| note-float-singleton-and-race | E | :1647–1692 | rapid open of two refs → one float; supersede guard (1692) |
| note-float-outside-close-exceptions | E | :1652–1660 | click in `.note-linkpop` keeps float; elsewhere closes |
| recolor-no-doc-edit | E | :1494–1501 | recolor → doc JSON unchanged; all views recolored |
| multi-ref-removal | U/E | :1508–1527 | two refs of one note both replaced right-to-left correctly |
| teardown-preserves-notes | E | :2424–2427, :1624 | close pad with N notes → zero DELETE calls |

### Toolbar / menus
| Name | Type | Covers | Behavior |
|---|---|---|---|
| table-picker-grid | E | :1822–1885 | hover r×c; mousedown inserts exact table; outside click closes |
| table-ops-visibility | E | :2192–2197, :2247 | +Row/−Col/✕ only in table; all work |
| tab-in-table-vs-list | E | :2282–2283 | Tab = next cell / list sink / literal `\t` — three contexts |
| heading-toggle-revert | E | :2177–2180 | active H2 button click reverts to paragraph |
| insert-block-node-selection | U | :1315–1324 | NodeSelection on snippet: hr/table insert goes AFTER the atom |
| sketch-menu-clipboard-valid | E | :1940–1979 | stubbed clipboard `ms-variation:N` → enabled + preview; click inserts |
| sketch-menu-clipboard-fallback | E | :1953–1966 | clipboard rejects/hangs >700ms → localStorage fallback; foreign text stays disabled |
| sketch-menu-picker-search | E | :2022–2057 | debounced filter; error renders "Could not load"; Escape closes |
| image-upload-flow | E | :1300–1310, :2370–2382 | file → POST → image block; failure → alert, no node |
| open-time-trailing-normalize | E | :2340–2358 | pad seeded with trailing snippet/table opens with appended paragraph |

### Scroll engine
| Name | Type | Covers | Behavior |
|---|---|---|---|
| holdscroll-single-pin | E | :452–489 | two concurrent rebuilds → one hold; released after window (listener removed) |
| holdscroll-above-viewport-delta | E | :557–566 | widget above viewport grows → scrollTop adjusted by delta |
| holdscroll-suspension-rebase | E | :447–451, :459–462 | during suspension a programmatic scroll wins; new position then defended |
| scrolldiag-ring | E | :367–427 | buffer caps at 100; >300px jump dumps (low priority) |

### modal.mjs / scratchpad-modal.js / import-scratchpad.js
| Name | Type | Covers | Behavior |
|---|---|---|---|
| open-serialization | E | modal.mjs:27–39 | rapid double open waits; open-while-close-refused aborts without stacking |
| escape-scoping | E | modal.mjs:71–72, editor-core:946 | Esc in textarea exits edit only; second Esc closes; failing save → stays open |
| backdrop-vs-dialog-click | E | modal.mjs:66–68 | overlay mousedown closes; inside doesn't; expand toggles `spm-full` |
| hash-lifecycle | E | modal.mjs:91–96, :253–257 | replaceState only; sketch/variation params preserved; close clears only scratchpad hashes |
| editor-open-failure | E | modal.mjs:82–85 | GET 500 → error in slot, close works |
| opened-stamp | E | modal.mjs:98–101 | POST /opened on open; failure ignored |
| pad-link-put-failure | E | modal.mjs:133–159 | link PUT 500 → alert, chip stays unlinked |
| lazy-load-once | E | scratchpad-modal.js:11–16 | module imported once across opens |
| restore-from-hash-matrix | E | scratchpad-modal.js:31–44, :55 | load w/ hash opens; same-pad hashchange scrolls only; different pad swaps |
| proximity-single-hot | E | import-scratchpad.js:96–124 | nearest zone within 26px band only; none >80px off-column |
| eligibility-filtering | E | :189–200 | canonized/foreign-linked groups disabled with reason |
| slug-collision-guard | E | :237–242 | slug already in effective manuscript → error, no PUT |
| canonize-two-step-failure ⚠ | E | :282–290, :310–314, :147 vs :313 | suggestion ok + canonize fails → error mentions saved suggestion; pins the Place/Canonize label drift |
| stale-migration-409 | E | :279 | PUT 409 → "manuscript changed" message |
| replace-mode-marker | E | :260–263 | placeholder fill keeps leading marker; slug retires |
| freeze-all-prompt | E | :295–301 | confirm freezes all; decline doesn't; freeze failure non-fatal |
| stale-draft-purge | E | :305 | `ms-draft-suggest-<id>` removed after canonize |
| hash-scroll-retry | E | :321–334 | `#slug` scrolls once outline resolves; gives up after 40 tries |

### region.js (units — only `resolve` is unit-tested today)
| Name | Type | Covers | Behavior |
|---|---|---|---|
| replaceplan-inline-same-sentence | U | region.js:106–116 | opener+end inline → single suggestion `prefix\n\t…\nsuffix` |
| replaceplan-block-opener | U | :109–113 | sole-line opener → content after `\n\t` |
| replaceplan-interior-delete | U | :123–130 | interior sentences suggest `''`; end sentence trimmed |
| replaceplan-unchanged-omitted | U | :89 | unchanged sentence absent from plan |
| replaceplan-missing-anchor/end | U | :132 | both failure statuses, empty plan |
| replaceplan-composes-with-suggestion | U | :103 | sugMap entry used as base |
| replaceplan-codepoints | U | :96, :100 | astral chars don't shift offsets |
| regionrawtext-join | U | :139–147 | marker-led concat vs space-join; non-ok → null |
| resolve-inline-open-and-end-same-fragment | U | :44–57 | both tokens in one fragment → single inner item |
| resolve-with-canonicalize | U | :20, :36–37 | canonize fn actually applied (existing cases pass null) |
| effectiveslugs-inline | U | :160–162 | inline command slugs collected |

### edit-pane.js (units with fake timers — today only exercised via hosts)
| Name | Type | Covers | Behavior |
|---|---|---|---|
| autosaver-nochange-shortcut | U | edit-pane.js:84–88 | value===lastSaved → true, no save() |
| autosaver-chase | U | :96–99 | change during in-flight save → chained poke; flush false until settled |
| autosaver-retry-ladder | U | :100–115 | backoff 2→60, cap 6, success resets |
| autosaver-fatal | U | :102–103 | onFatal string pins status, no retry |
| autosaver-destroy | U | :130, :82 | destroy cancels timers; in-flight save returns false after |
| autosaver-draft-mirror | U | :44–51, :98, :101 | poke writes draft; success+clean clears; failure rewrites |
| readdraft-expiry | U | :206–217 | >48h or malformed → null + key removed |
| monoeditor-insertatcaret | U | :180–186 | splice at selection; caret after; input event |
| tabmarkup | U | :199–202 | tabs wrapped keeping real `\t`; trailing `\n` ZWSP; escaped |
| autogrow-pin | E | :157–167 | keystroke near scroll bottom doesn't clamp scrollTop |

**Rewrite-priority clusters:** (1) the ⚠ tests; (2) the region.js `replacePlan`
unit battery (today covered only through one full-stack e2e); (3) the modal
close-guard matrix; (4) the edit-pane autosaver units — these are where DRY.md
item 3 (porting the doc save onto `createAutosaver`) lands.

---

# AREA 2 — Database layer
`internal/database/queries.go` (2,478), `internal/database/variations.go` (734),
plus handler callers (`api/handlers/*.go`) and `internal/migrations/processor.go`

## 2.1 What's wrong

**God-file:** 72 `func (db *DB)` methods over ~17 tables. Section map:
manuscripts 23–112; migrations 114–342; sentence-text batch 344–377;
suggestions 379–600; sentence writes 602–667; slugs 675–755; more migrations
757–812; notes + versions 814–1520; tags 1522–1671; reorder 1673–1717;
users/access 1719–1837; home/daily notes 1839–2042; task types 2044–2156; note
actions/points 2158–2331; daily rules **plus an in-memory rule engine**
(`ruleMatches`/`ApplyDailyRules` 2410–2478 — business logic in the DB layer).
Natural split: 8 files + move the rule engine out.

**Proven silent drift:** the note column list is copied 5× and has ALREADY
diverged — `GetActiveNotesForSentences` (:1441–1448) and
`GetActiveNotesForSentence` (:1471–1478) omit `manuscript_id, scratchpad_id`
that the other three copies select (:816–825, :950–958, :1991–1998). Harmless
today only because `MigrateNotes` doesn't read them. `ListNotesForHome`
(:1867–1903) vs `ListDailyTaskNotes` (:1932–1969): ~35 lines duplicated
verbatim. The repo-basename regexp exists twice in SQL (:1882, :1942) AND in
Go (api/handlers/variations.go:533–548).

**Real bugs found:**
- **`changes_count` is wrong**: processor.go:197–202 computes the sub-unity
  confidence count then never uses it — :215 and :239 store
  `len(diff.Deleted)` instead. Bootstrap never sets it (:105–115).
- **`newSketchID` collision retry is dead code** (variations.go:136–148,
  :671–682): the retry INSERT runs inside the same now-aborted transaction, so
  every retry fails with "current transaction is aborted".
- **Security gaps:** `POST /api/admin/wordcount-compute` has **no
  `checkSystemToken`** (admin.go:507–517, mounted outside auth at
  api/server.go:347 — callable unauthenticated); `HandleCreateNote` has **no
  CSRF check** (notes.go:269–376; every other note mutation has one);
  `HandlePlacePlan` never calls `requireManuscriptAccess` and has no CSRF
  (variations.go handlers :401–475).

**Transaction inconsistencies:** `CreateNote` uses a process mutex + tx for
MAX(position) (:1014) but `CreateScratchpadNote` (:1123–1150) does the same
read-then-insert with neither; `CreateDailyRule` (:2372–2399) calls
`GetOrCreateTag` on the pool from inside a tx (orphan tags on rollback);
variations.go check-then-act without locks in 6 methods while two sibling
methods lock different rows (`FOR UPDATE OF v` :186 vs `OF s` :571);
`AddTaskTypes` loops pool Execs (:2086–2098) while `SetTaskTypeOrder` uses a
tx (:2117–2129).

**Error-handling drift:** variations.go collapses genuine DB errors into
`ErrNotOwner` → 404 in ~12 places with zero logging (a dropped connection
reads as "Not found"); the newer half of queries.go returns bare errors while
the older half wraps with `%w`; `HandlePutSuggestion` 500s on a nil migration
(suggestions.go:127–131) where 404/409 is right.

**Filter drift matrix:** `UpdateScratchpadNote` lets completed notes stay
editable (:1168); `UpdateNote` has no SQL guard at all (:1181–1186);
`ListTagCounts` counts completed notes (:1616); `CreateNote`'s MAX(position)
(:1032) and `ReorderNote`'s position list (:1681) are **not user-scoped**
while every visible list is — in a multi-user manuscript reorder computes
against the wrong array. `ReorderNote` also trusts `req.SentenceID` from the
body (notes.go:494).

**N+1:** `GetNotesByCommit`/`GetNotesBySentence` do 1 tag query per note
(:869–875, :994–998) while `ListNotesForHome` already solved it with
`json_agg` (:1889–1894) — three tag-loading strategies coexist. `HandleHome`
is O(manuscripts + pads) round-trips (home.go:100–151).

## 2.2 Invariants a rewrite must preserve

1. `suggested_change.sentence_id` FK has **no cascade** (006 changeset) —
   deleting a migration with suggestions FK-fails. `note.manuscript_id`/
   `scratchpad_id` are SET NULL (019).
2. Append-only: `sentence`/`migration` rows never update after done except the
   two blessed setters (:602–630); a corrupt `sentence_id_history` must
   **hard-error, never regenerate** (:908–912); `note_version` and
   `variation_revision` are append-only.
3. `previous_sentence_id` set at insert from highest-confidence pairing
   (processor.go:161–166, 340–360); fallback pairings lose to real matches;
   history endpoint walks ≤3 hops batched (migrations.go:190–269).
4. **`confidence == 1.0` gates suggestion carry-forward** (processor.go:302–317);
   notes carry at any confidence with it recorded.
5. `GetMigrationByID` returns nil unless `status='done'` (:757–773) — this is
   what 404s in-flight migrations everywhere. `MarkMigrationDone` overwrites
   `commit_hash` ("HEAD" pending rows, :279–281). Dedup key is the literal
   requested ref.
6. Single-instance assumptions: `createNoteMu` (:1010–1014) and
   `manuscriptMigrationLocks` (admin.go:438–449) are process-local. Migration
   goroutine acquires the per-manuscript lock BEFORE the 5-minute clock starts
   (admin.go:456–460); deferred error-mark registered before first write
   (processor.go:64–70); **note migration runs before `MarkMigrationDone`**
   (processor.go:177–179).
7. Ownership models differ by feature: manuscripts = config-name grants
   (a manuscript removed from YAML 404s, access.go:19–33); notes/variations/
   scratchpads = row-level user_id. Sketch note is 1-per-sketch (partial
   unique idx, 026), minted in the create tx, never deletable
   (notes.go:531–534). Versionless notes must never enter the versioned update
   path (notes.go:434–447).
8. Canonize post-036: `canon_variation_id` points at the placed lettered
   variation and doubles as the placed flag; legacy NULL-ordinal snapshots
   deleted on re-canonize (variations.go:536–545); canon variation frozen/
   immutable/undeletable; canonized sketch link permanent (:486–488).
9. `base_path`: body-size limiter runs BEFORE the strip middleware and matches
   by suffix (api/server.go:170–182 vs 196–214) — reordering breaks the
   10MB/4MB exceptions. `<base href>` injection (:384–402); `..` guard
   (:361–365).
10. Git: `ValidateCommitRef` at every ref boundary; tokens only via GIT_ASKPASS
    (git.go:396–415); `WriteCommitPushBranch` uses a temp index so pushes can
    run concurrently with migrations (git.go:246–255); branch name
    `suggestions-{short7}-{user}` force-pushed; segman sibling staged only if
    present at base (suggestions.go:450–469).
11. Stale-write guards: suggestion PUT and push both 409 `{"error":"stale"}`
    on non-latest migration (suggestions.go:118–147, :344–364). Prune window ≤3
    neighbors; empty-normalized suggestions never window-pruned (:435–456).
12. Daily determinism: order by `md5(note_id || seed)`; completed-today rows
    retained (:1960–1968); `ApplyDailyRules` is order-preserving backfill,
    −1 = unlimited (:2441–2478).

## 2.3 Existing coverage

Go: `processor_integration_test.go` (17 solid dev-DB tests — pairing,
carry-forward, prune, chains), `git_test.go`/`git_writebranch_test.go`,
`admin_test.go` (tokens, signatures, webhook filter), `server_test.go`
(dot-dot), `wordcount_rates_test.go`. **`queries.go` has effectively one test
(which never calls prod code); `variations.go` has zero.** The 96 Playwright
files cover many paths end-to-end behaviorally (named per-row below).

## 2.4 Tests needed (full-coverage inventory)

### Manuscripts & migrations (queries.go:23–342, 757–812)
| # | Test | Type | Covers | Behavior / existing |
|---|---|---|---|---|
| 1 | CreateManuscript_UpsertIdempotent | I | :23–47 | same (repo,file) → same id; display_name COALESCE |
| 2 | GetManuscript(ByID)_NilOnMissing | I | :49–90 | (nil,nil) both variants |
| 3 | UpdateManuscriptMeta_PartialNilKeeps | I | :92–112 | nil keeps old; nil,nil unchanged; missing id → nil |
| 4 | scanMigration_NullableColumns | I | :116–173 | pending row scans to zero values; corrupt sentence_id_array errors |
| 5 | GetLatestMigration_SkipsNonDone | I | :175–193 | pending/error invisible |
| 6 | GetMigrations_DoneOnly_NewestFirst | I | :195–221 | ordering + filter |
| 7 | GetActiveMigrations_PendingRunning | I | :223–246 | NULLS LAST |
| 8 | CreatePendingMigration_DupTo409 | I | :248–266 | 23505 → ErrMigrationInProgress (✓ covered by processor int. test) |
| 9 | MarkMigrationRunning_OnlyFromPendingRunning | I | :268–277 | no-op on done/error |
| 10 | MarkMigrationDone_OverwritesCommitHash | I | :279–307 | "HEAD" pending → real SHA; error cleared |
| 11 | MarkMigrationError_Truncates4000 | I | :309–326 | truncation via prod fn (existing test duplicates the arithmetic instead) |
| 12 | RecoverInterruptedMigrations_FlipsAndCounts | I | :328–342 | pending+running → error; done untouched |
| 13 | GetMigrationByID_NilForPending | I | :757–773 | the done-gate driving 404s |
| 14 | GetSentencesByMigration_OrdinalOrder | I | :775–812 | ordering + prev-id scan |

### Sentences & suggestions (:344–667)
| # | Test | Type | Covers | Behavior |
|---|---|---|---|---|
| 15 | GetSentenceTextsByIDs_EmptyAndBatch | I | :344–377 | empty slice → no query; missing ids absent |
| 16 | UpsertSuggestion_InsertThenUpdate | I | :379–397 | conflict updates text, same id (E: test-suggested-edits) |
| 17 | DeleteSuggestion_ReportsRowExisted | I | :399–409 | true/false |
| 18 | GetSuggestionsForMigration_UserScoped | I | :411–433 | other users excluded |
| 19–22 | PruneNoOp battery | I | :457–560 | exact match ✓; window join ✓; **empty-normalized never window-pruned ✗**; survivors ✓ |
| 23 | PruneNoOp_NilOrderedIDsFallsBack | I | :459–467 | post-hoc path uses stored array |
| 24 | PruneNoOp_ScopedToMigration | I | :496–501 | older migration's identical no-op untouched |
| 25 | CopySuggestionsForward(Bulk)_ConflictLoses | I | :562–600 | destination wins; empty → 0 no query; count = inserts |
| 26 | SetPreviousSentenceID/UpdateSentenceText_Validates | I | :602–630 | invalid text rejected pre-write |
| 27 | CreateSentences_ValidatesBeforeAnyWrite | I | :632–667 | one bad row → zero inserted (COPY in tx) |
| 28 | StoreCommandSlugs_IdempotentPerMigration | I | :675–705 | re-store clears+rewrites; batch dup first-wins |
| 29 | GetSlugs/ResolveSlug_MissingIsEmpty | I | :714–755 | ordering; "" for dangling |

### Notes & versions (:814–1520)
| # | Test | Type | Covers | Behavior |
|---|---|---|---|---|
| 30 | GetNotesByCommit_FiltersAndOrders | I | :814–878 | user+deleted+completed filters; (ordinal,position) |
| 31 | GetNotesBySentence_EmptyIsJSONArray | I | :949–1008 | non-nil empty; position order |
| 32 | getNoteOriginInfo_MinAggregates | I | :880–892 | origin from version 1 (invariant 2.2#-) |
| 33 | getSentenceHistory_AppendsAndRejectsCorrupt | I | :894–920 | **corrupt JSON hard-errors — critical audit invariant, untested** |
| 34 | CreateNote_FirstVersionAndOrigin | I | :1016–1115 | version=1; origin = sentence's commit/migration; manuscript stamped |
| 35 | CreateNote_PositionAfterReorderedMax | I | :1030–1039 | fractional max like "a00015" handled |
| 36 | CreateNote_ManuscriptStampFailureIsSilent ⚠ | I | :1081–1090 | decide: keep or fix silent skip |
| 37 | CreateScratchpadNote_NoVersionRow | I | :1123–1150 | pad note: no version, per-pad position, **races unguarded (vs :1014) — pin or fix** |
| 38 | UpdateScratchpadNote_GuardExcludesSentenceNotes | I | :1158–1171 | sentence-note → 0 rows; NULLIF task_type; body CASE semantics |
| 39 | UpdateNote_AppendsVersionWithHistory | I | :1174–1238 | version=max+1; history grows; origin forward |
| 40 | MigrateNotes_AllOrNothing | I | :1249–1336 | missing note mid-batch → zero rows committed |
| 41 | MigrateNotes_SkipsNullSentenceNotes | I | :1265–1272 | defense-in-depth (✓ upstream guard tested) |
| 42 | MigrateNotes_VersionFieldsFromLatestVersion | I | :1283–1326 | fields from note_version not head; confidence recorded |
| 43 | SoftDelete/CompleteNote_IdempotenceErrors | I | :1338–1388 | second call errors |
| 44 | ScorePoints_WritesEvent | I | :1360–1365 | row written |
| 45 | GetLatestNoteVersion_HistoryUnmarshal | I | :1390–1430 | latest picked; JSON round-trip |
| 46 | GetActiveNotesForSentences_BatchEqualsSingles ⚠ | I | :1436–1520 | batch == singles; **flag the missing manuscript_id/scratchpad_id columns** |

### Tags, reorder, users/access (:1522–1837)
| # | Test | Type | Covers | Behavior |
|---|---|---|---|---|
| 47 | GetOrCreateTag_PerUserNamespace | I | :1525–1561 | per-user rows; race dup errors (no ON CONFLICT — document) |
| 48 | AddTagToNote_Idempotent | I | :1563–1581 | double-add ok |
| 49 | RemoveTagFromNote_MissingErrors | I | :1583–1599 | "tag not found on note" |
| 50 | ListTagCounts_DeletedExcluded_CompletedIncluded | I | :1601–1634 | pin current (surprising) behavior |
| 51 | GetTagsForNote_NameOrder | I | :1636–1671 | ordering |
| 52 | ReorderNote_FractionalTargetSlot ⚠ | I | :1673–1717 | **pin cross-user / mismatched-sentence behavior** (not user-scoped; trusts body sentence_id) |
| 53 | GetUserByUsername_NilOnMissing | I | :1719–1741 | (nil,nil) |
| 54 | Get/HasManuscriptAccess | I | :1743–1788 | list order; EXISTS |
| 55 | Get/SetLastManuscriptName_NullHandling | I | :1790–1837 | NULL → ""; missing user → "" |
| 56 | GetMigrationIDForSentence_ZeroOnMissing | I | :1809–1824 | 0 sentinel drives 404s |

### Home/daily/task-types/actions/rules (:1839–2478)
| # | Test | Type | Covers | Behavior |
|---|---|---|---|---|
| 57 | ListNotesForHome_ContextResolution | I | :1866–1922 | sketch-home subselect; display-name fallback; json_agg tags; limit |
| 58 | ListDailyTaskNotes_Determinism | I | :1931–1988 | same seed → same order; created-today excluded; completed-today retained; done_today logic |
| 59 | GetNoteByID_ExcludesCompleted | I | :1990–2028 | completed → nil |
| 60 | SetNoteManuscript_LinkUnlink | I | :2030–2042 | nil clears |
| 61 | ListTaskTypes_IncludesSoftDeleted | I | :2061–2079 | deleted returned; (position,name) |
| 62 | AddTaskTypes_ReviveSoftDeleted | I | :2086–2098 | live dup skipped; revived with NEW category; appended position |
| 63 | DeleteTaskType_SoftAndReports | I | :2104–2112 | false when absent |
| 64 | SetTaskTypeOrder_OmittedKeepPosition | I | :2117–2129 | atomic; partial list |
| 65 | TaskTypeIsTask_EmptyAndDeleted | I | :2134–2147 | "" → false; soft-deleted answers |
| 66 | SetTaskTypeColor_Reports | I | :2150–2156 | false on missing |
| 67 | ListNoteActions_UnionOrderingAndClamp | I | :2171–2202 | 3-source UNION; LEFT(body,300); deleted points excluded |
| 68 | Delete/UpdatePointEvent_OwnershipViaNote | I | :2207–2231 | other user's → false |
| 69 | RestoreNote/UncompleteNote_OwnershipAndState | I | :2235–2257 | false unless deleted/completed AND owned |
| 70 | ListDailyPoints_TZGrouping | I | :2270–2291 | midnight-adjacent local day; deleted excluded; full history |
| 71 | SetNoteActionDate_PreservesTimeOfDay | I | :2299–2331 | **SQL timezone arithmetic, zero tests**; 3 kinds; DST edge; ownership |
| 72 | ListDailyRules/Create/Delete_TagsAggregated | I | :2347–2407 | COALESCE '{}'; position append; **GetOrCreateTag-outside-tx pinned** |
| 73 | ruleMatches_AllSelectors | **U** | :2410–2439 | pure fn — nil wildcards, all-tags, blocked tri-state (free win) |
| 74 | ApplyDailyRules_QuotaBackfill | **U** | :2445–2478 | pure fn — capped skip + backfill, −1 unlimited, limit cut (free win) |

### variations.go
| # | Test | Type | Covers | Behavior |
|---|---|---|---|---|
| 75 | newSketchID_AlphabetAndLength | U | variations.go:101–116 | 10 chars base36 |
| 76 | CreateSketch_MintsVariationA_AndNote | I | :129–170 | sketch + variation A + yellow note, one tx |
| 77 | CreateSketch_IDCollisionRetryBroken ⚠ | I | :136–148 | retry inside aborted tx can't succeed — fix (savepoint or pre-tx gen) |
| 78 | CreateVariationFrom_NextLetter_TextCopied | I | :175–214 | ordinal+1; canon source → ErrVariationNoLetter; 27th → ErrOrdinalCap |
| 79 | CreateVariationFrom_ConcurrentOrdinalRace ⚠ | I | :186–201 | two tx same sketch → unique idx violation (currently 500) — pin |
| 80 | GetVariationContext_FullPayload | I | :219–290 | siblings ordered; deleted excluded; **canon fetched even if soft-deleted — pin/fix** |
| 81 | UpdateVariationText_StateGates | I | :294–330 | frozen/superseded/canon errors; revision appended |
| 82 | SetVariationState_ValidatesAndGuardsCanon | I | :336–355 | invalid string; canon refusal |
| 83 | FreezeAllVariations_DraftsOnly | I | :359–368 | superseded untouched |
| 84 | ListVariationsForPicker_Filters | I | :375–401 | superseded+deleted+canon excluded; ILIKE; LIMIT 50 |
| 85 | SoftDelete/Restore/ListDeletedVariations | I | :416–473 | canon undeletable; restore keeps frozen |
| 86 | LinkSketch_ClearAndCanonizedRefusal | I | :477–499 | 0 clears; ErrSketchCanonized; **TOCTOU vs CanonizeVariation pinned** |
| 87 | CanonizeVariation_RepointAndLegacyDrop | I | :507–557 | linked-elsewhere refusal; re-canonize repoints + deletes legacy snapshot |
| 88 | CreateVariationFromText_SeededNextLetter | I | :563–595 | sketch lock; cap |
| 89 | CountCanonizedAmong_EmptyFastPath | I | :599–610 | 0 without query |
| 90 | VariationHomeScratchpad/SketchHome_Preference | I | :614–649 | placed-from wins, else lowest letter with pad |
| 91 | CreatePlacedSketchFromSelection_FullStroke | I | :660–734 | frozen A = canon = placed_from; ONE widget appended; malformed pad doc replaced |
| 92 | VariationsErrorMasking ⚠ | I | all owner checks | DB failure vs missing vs wrong-owner — pin or fix the ErrNotOwner collapse |

### Handlers
| # | Test | Type | Covers | Behavior |
|---|---|---|---|---|
| 93 | requireOwnedNote_GuardChain | I/E | notes.go:68–93 | 500/404/403/sentence-access ordering |
| 94 | HandleCreateNote_CSRFMissing ⚠ | E | notes.go:269 | **currently no CSRF on POST /notes — add it, then pin** |
| 95 | HandleCreateNote_ScratchpadPath | E | notes.go:301–339 | pad ownership 404; inherit; **no priority/impact validation on create — pin or fix** |
| 96 | HandleUpdateNote_VersionlessRouting | E | notes.go:434–447 | scratchpad/sketch direct; sentence versioned; invalid 400 |
| 97 | HandleDeleteNote_SketchNoteRefused | E | notes.go:529–534 | 400 |
| 98 | HandleScoreNotePoints_TaskGateAndRange | E | notes.go:598–618 | non-task 400; 1–99 |
| 99 | (tags covered) | E | notes.go:629–775 | ✓ test-tag-api/-authz |
| 100 | HandlePutSuggestion_RevertCollapsesToDelete | E | suggestions.go:160–167 | text==original → DELETE + 204 |
| 101 | HandlePutSuggestion_NilMigration ⚠ | E | suggestions.go:127–131 | currently 500 — should be 404/409 |
| 102 | HandlePushSuggestions_SegmanSibling | E | suggestions.go:440–469 | sibling staged only when present at base (happy path ✓ test-push-suggestions) |
| 103 | canonicalSuggestionsBranch/sanitize | **U** | suggestions.go:223–231, :503–509 | short-SHA; weird usernames → "-"; empty → "user" |
| 104 | segmanSiblingPath | **U** | suggestions.go:27–32 | .manuscript swap |
| 105 | HandleGetPushState_BranchExists | E | suggestions.go:236–303 | exists flag + compare URL; unconfigured 501 |
| 106 | HandleWebhook_ModifiedAddedPaths | U/E | admin.go:55–137 | Modified/Added trigger; Removed-only ignored (filter tests ✓ partial) |
| 107 | HandleSync_TokenAndRefValidation | E | admin.go:140–172 | 403; HEAD default; bad ref 400 |
| 108 | startMigration_HEADDedupe409 | I | admin.go:333–392 | concurrent "HEAD" enqueues → one 409 |
| 109 | ResegmentOnSegmenterChange_OnlyStale | I | admin.go:400–436 | same segmenter skipped; never-bootstrapped skipped |
| 110 | runMigration_LockThenTimeout | I | admin.go:453–460 | queued run gets full 5-min budget |
| 111 | HandleWordcountCompute_Auth ⚠ | E | admin.go:507–517 | **add checkSystemToken, then pin** |
| 112 | AccessHelpers_Matrix | I/E | access.go:19–109 | not-in-config 404; no-grant 404; sentence→migration→manuscript chain; pending → 404 |
| 113 | HandleGetLatestMigration_WordcountSource | E | migrations.go:58–101 | history-table vs live fallback |
| 114 | (manuscript payload covered) | E | migrations.go:107–174 | ✓ render e2e |
| 115 | HandleGetSentenceHistory_3HopBatchedWalk | I | migrations.go:190–269 | broken link truncates; ≤3 hops |
| 116 | (outline unit ✓) | — | — | endpoint E partial |
| 117 | HandleUpdateManuscriptMeta_Validation | E | migrations.go:354–403 | bad date/goal/empty 400s |
| 118–122 | HandleHome batteries | E/U | home.go:71–326 | sort nulls-last; best-effort failures; `joinContext` 4 combos (U); **HandleDailyTasks missing access check — pin** |
| 123 | HandlePlacePlan_AnchorScan ⚠ | U/E | variations.go(h):401–475 | effective-text overlay; open/end detection; **missing access+CSRF — add, then pin** |
| 124 | writeVariationError_Mapping | **U** | variations.go(h):47–63 | sentinel → status |
| 125 | HandleCreateSketch_ModeDispatch | E | variations.go(h):79–140 | "text" mode untested; inherit only on "new" |
| 126 | manuscriptDisplayName_Fallbacks | I | variations.go(h):533–548 | display → config → basename |

### processor.go / git.go / server.go
| # | Test | Type | Covers | Behavior |
|---|---|---|---|---|
| 127 | ChangesCount_IsSubUnityConfidenceCount ⚠ | I | processor.go:197–217, :239 | **write failing test, then fix** (stores `len(diff.Deleted)` today) |
| 128 | Run_MarksErrorEvenIfMarkRunningFails | I | processor.go:64–73 | deferred error-mark ordering |
| 129 | (bootstrap dispatch ✓) | — | :78–91 | int. tests |
| 130 | planMigration_ForwardThenBackwardFallback | U | :365–392 | direct unit (int. tests cover indirectly) |
| 131 | unresolvedReferences_SortedDeduped | U | :413–435 | dangling refs; known/auto skipped |
| 132 | segmentContent_MarkerCarryStableIDs | U | :445–466 | markers in text; IDs stable vs stripped |
| 133 | (fuzzy skip ✓) | — | :302–317 | int. test |
| 134 | Prepare_SoftPullHardCloneRead | I | git.go:91–122 | pull failure warns+proceeds; clone/read fatal; HEAD resolution |
| 135 | BasePathStrip_ExactAndPrefix | U | server.go:196–214 | exact → "/"; RoutePath rewritten |
| 136 | BodyLimits_ByRoute | U | server.go:170–182 | 11MB/5MB/1MB → 413 boundaries |
| 137 | Static_CachePolicyMatrix | U | server.go:377–383 | html no-store; ?v= immutable; else no-cache |
| 138 | Static_BaseHrefInjection | U | server.go:384–402 | once after `<head>`, escaped |
| 139 | readyz_DegradedVsUnhealthy | I | server.go:428–447 | DB down 503; repo missing 200-degraded |
| 140 | RunWordcountCron_DisabledNoop | U | server.go:128–153 | flag off → immediate return; ctx cancel exits |

**Rewrite-priority order:** #127 (ChangesCount), #33 (corrupt-history
hard-error), #94/#111/#123 (close the three auth/CSRF gaps FIRST, then pin),
#71 (SQL timezone rewrites), #73–74 (pure functions — free wins), #40
(MigrateNotes rollback), #21/#24 (prune edges), #92 (error masking), #77
(broken retry).

---

# AREA 3 — Render + suggestion pipeline
`web/js/renderer.js` (1,220), `web/js/suggestions.js` (621),
`web/js/pagedjs-config.js` (82), `web/js/command.js` (298),
`web/js/canonicalize.js` (105), `web/js/text-markers.js` (48),
`web/js/range-delete.js` (198)

## 3.1 What's wrong

**Dead code and lying comments** (fix before anything else):
- `suggestions.js:35–108` — `applyToSpans` + `applyStructuralSuggestion` are
  **dead** (~74 lines, zero callers; renderer.js:242–244 says so; their CSS
  classes exist in no stylesheet). **Delete them.**
- `suggestions.js:1–11` — the file header documents the dead flow and a
  function (`wrapSentences`) that no longer exists. First thing a patcher
  reads is wrong.
- `pagedjs-config.js:1` — "Must load BEFORE Paged.js" is false
  (index.html loads Paged at :27, this at :108); it works via the 100ms retry
  poll (:5–8).
- `command.js:159–167` — the leading-command split claims parity with
  canonicalize but checks `kind === 'anchor'` only, while canonicalize splits
  `&snippet`/`&sketch` too (canonicalize.js:45–47) — a real parity asymmetry,
  currently masked.

**Duplication:** HTML escaper ×2 (renderer.js:763–770 ≡ text-markers.js:41–48,
whose comment forbids exactly this); `applyInlineFormatting` ×2 with
**different semantics** under one name (renderer.js:772–793 vs
suggestions.js:554–556); PUT-suggestion ×2 with different auth paths
(suggestions.js:235–248 via authenticatedFetch vs range-delete.js:161–167 raw
fetch + hand CSRF); marker→class ternary ×3 (renderer.js:509, :546, :692);
§/¶ vocabulary ×3 files; the inline-command grammar exists as a real parser
(command.js:42–89) AND a hand-maintained regex over escaped HTML
(renderer.js:851) — adding a command keyword breaks diff rendering silently;
smartquotes invoked from 3 sites that must stay behaviorally identical;
mobile breakpoint literals 768 vs 1239×2.

**Hotspots:** `openModal` 232 lines (~25 branches); `renderSentencesToHTML`
185 lines (~40 branches) — a paragraph state machine with three pieces of
cross-iteration pending state (`openP`, `pendingMarginGlyphs`,
`pendingCarriedCls`) documented only in prose, with a `continue` at :585 that
bypasses the promoted-glyph flush via a duplicated line at :583;
`renderManuscript` 132; `renderDiffHTML` 82 with in-loop splice+rewind.

**Global coupling:** the pipeline reads 11 `window.WriteSys*` namespaces plus
bare globals (`renderDiffHTML` is defined in suggestions.js and called from
renderer.js — a backwards dependency vs script order). Nearly every access is
defensively guarded, so a misloaded module degrades silently into rendering
quirks. Cross-module writers: `currentSelectedSentenceId` written from 2
files; `bySentenceId` from 3 flows; `currentNotes` mutated in place by
notes.js; pagedjs-config stamps `_noteDeepLinkDone` onto the renderer.

**Fragility:** no reentrancy guard on `renderManuscript` (5 caller sites —
overlapping calls would strand/double-remove page trees); `_dmp()` caches
`null` forever if evaluated early (renderer.js:678–683); `CSS.escape` used in
7 selector sites, skipped in 11; `range-delete.apply()` does N sequential PUTs
with only an alert on mid-range failure (:155–177).

## 3.2 Invariants a rewrite must preserve (the 25, condensed)

1. **Diff before smartquotes** (renderer.js:553 vs :246–248) — reversed, every
   apostrophe diffs.
2. `patchSentenceInPlace` (:351–371) must replicate the full pipeline exactly;
   its one-`<p>`/one-span guard must stay equivalent to "the simple case".
3. `applyEffectiveSettings` before building HTML, every render (:215).
4. Suggestions loaded before first render (Promise.all :166–173).
5. Canonicalize before segmentation AND the committed baseline is canonicalized
   too (:474–486; pinned by test-canon-render-pipeline).
6. `&end` renders nothing in all three paths (:515–516, :716–721, :799–804).
7. **Old and new `.pagedjs_pages` coexist during re-render** (:252–288);
   `afterRendered` hooks hit the OLD tree — container-scoped work must be
   re-run post-swap (:287–299); document-wide work survives. Every new hook
   must pick a strategy; nothing enforces it.
8. Anchor offset re-measured at swap time; re-measure→scrollBy stays
   synchronous (:266–277, :318–324).
9. `document.body.dataset.paginated` is a **public contract with the test
   suite** (pagedjs-config.js:15–20 ↔ test-utils.js waitForPagination).
10. `registerHandlers` before first `Previewer` (enforced only by the poll).
11. `fonts.ready` re-pins margin glyphs (:297–300).
12. canonicalize.js ↔ canonicalize.go lockstep via the **shared corpus**
    `tests/canonicalize-scenarios.jsonl` + idempotence.
13. command.js ↔ command.go mirrors — mostly convention-enforced; only
    placeholder parsing has paired tests.
14. `segmentFragments` must mirror segman's boundaries (currently asymmetric
    for snippets — §3.1).
15. `renderInlineCommandsInHtml` regex ↔ command grammar (keyword list, ≤4
    brace groups, slug charset, sketch→snippet aliasing ×2).
16. Server contract: empty text = delete proposal; text==committed collapses
    to delete (mirrored locally, suggestions.js:246–247); PUT 409 = stale.
17. Suggestions keyed by original sentence_id, never re-keyed; all fragments
    share the id (:480–481).
18. `sentenceMap[id]` = full committed storage text; never read
    `span.textContent` (page-split fragments are partial).
19. `currentNotes` shared-object identity (renderer.js:1202–1211).
20. Leading structural marker is metadata: stripped from visible text
    (:641–648); diff coalescer refuses leading/trailing whitespace EQ
    (suggestions.js:386–395); renderStructuralMarkers drops leading EQ marker.
21. Screen-px ÷ scale inside the scaled subtree (:1027–1040;
    range-delete.js:128–132).
22. Load-order: `escapeHTML` (text-markers) before consumers; `renderDiffHTML`
    before first render (safe only because renders are async).
23. Draft key `ms-draft-suggest-<id>` shared with edit-pane.
24. `scroll_to` URL param: written :285–287, consumed by 10s poll :600–617.
25. Trailing-glyph promotion is trailing-only (:529–544); references/
    placeholders never promoted.

## 3.3 Existing coverage

test-canonicalize (+ shared corpus, Go parity), test-canon-render-pipeline,
test-placeholder-parse, test-anchor-glyph/-inline/-gutter, test-suggested-edits,
test-structural-suggestion, test-suggestion-modal-fixes/-scroll/-stale-guard,
test-suggest-edit-pane, test-range-delete, test-sketch-from-selection,
test-sketch-place-push, test-canonize-compose, test-scratchpad-canonize,
spacing-invariants, rainbow suite, test-mobile-scale-affordances,
test-responsive-layout, test-placeholder, test-landing-note-deeplink-scroll,
test-region-resolver, test-utils (the paginated-counter consumer).

**Zero-coverage hotspots:** `extractSettings`/`applySettings`, all of
text-markers.js, `renderDiffHTML`'s coalescing/leading-EQ/overflow branches,
`renderStructuralMarkers`, `pairItalicsAcrossInserts`,
`patchSentenceInPlace` guards, `renderInlineCommandsInHtml`,
`markerGlyphDiff`, the margin-glyph pending/promotion state machine, the
migration-poll banner, the snippet-split parity asymmetry.

## 3.4 Tests needed (full-coverage inventory)

### command.js
| # | Name | Type | Covers | Asserts |
|---|---|---|---|---|
| C1 | parse-keyword-gating | U | command.js:42–55 | "Smith & Sons", "R&D", `&chapterX{...}` null; every keyword + `#`/`{` parses |
| C2 | parse-sketch-normalizes-to-snippet | U | :55 | `&sketch#a{x}` → kind snippet, raw keeps spelling |
| C3 | parse-end-bare-slug-self-terminates | U | :60–68, :86 | `&end#abc.` stops at `.`; `&end{x}` null |
| C4 | parse-nested-braces-depth | U | :71–85 | `{a{b}c}` captured; unterminated null |
| C5 | parse-no-args-null | U | :86 | `&anchor#slug` (no groups) null |
| C6 | isBlockCommandText-trailing | U | :93–97 | whole-block true; trailing prose false |
| C7 | segmentFragments-blank-line-plus-tab | U | :178–183 | `"\n\n\tPara"` → marker `\n\t` |
| C8 | segmentFragments-leading-anchor-newline-form | U | :167–176 | `"&anchor{x}\nprose"` → [command, prose]; marker rides prose |
| C9 | segmentFragments-snippet-newline-asymmetry ⚠ | U | :167 vs canonicalize.js:45–47 | pin (or fix) the snippet/sketch split asymmetry |
| C10 | segmentFragments-marker-reset-and-empty-blocks | U | :143–152 | empty-piece skip; marker consumed once |
| C11 | extractSettings-vocabulary | U | :210–233 | valid applies; last-wins; unknown/out-of-range/empty dropped; non-whole-block ignored; multi-block scanned — **zero JS coverage today** |
| C12 | findInline-block-short-circuit | U | :244 | whole-block → [] |
| C13 | findInline-kinds-and-offsets | U | :246–256 | codepoint-correct offsets (astral char); block token mid-text skipped whole |
| C14 | structuralForm-all-kinds | U | :268–290 | title h1, part h2+desc, chapter h3, snippet glyph, meta/placeholder/end null |

### canonicalize.js / text-markers.js
| # | Name | Type | Covers | Asserts |
|---|---|---|---|---|
| N1 | canonicalize-null-and-empty | U | canonicalize.js:81 | null → '' |
| N2 | corpus rows: bare-newline-snippet, leading-newline-anchor | U | :71–78, :90–93 | added to the SHARED jsonl so Go stays locked |
| T1 | toGlyphs-basic | U | text-markers.js:19–22 | `\n\n`→§, `\n\t`→¶, null→'' |
| T2 | fromGlyphs-order | U | :26–33 | glyphs before escape-literals; round-trip identity |
| T3 | escapeHTML-entities | U | :41–48 | all five entities |

### renderer.js
| # | Name | Type | Covers | Asserts |
|---|---|---|---|---|
| R1 | render-paragraph-grouping | U/eval | renderer.js:425–460, :546, :643–657 | no-marker joins one `<p>`; `\n\t`→indented; `\n\n`→section-break |
| R2 | render-delete-proposal | U/eval | :464–469, :562–564 | empty suggestion renders committed struck, not blank |
| R3 | render-lone-prose-diff | U/eval | :549–558 | single-prose diffs; multi-fragment doesn't (cmd-suggested blue) |
| R4 | render-marker-glyph-diff | U/eval | :555–557, :663–676 | 4 branches: added/removed/type-change/unchanged |
| R5 | render-meta-fragment | U/eval | :708–715 | unchanged hidden; suggested visible ⚙ |
| R6 | render-end-fragment-invisible | U/eval | :515–516, :716–721, :799–804 | all three paths |
| R7 | render-placeholder-block-branches | U/eval | :693–707 | invalid → literal; paragraphs → blockHTML; sentences alone → ph-line |
| R8 | render-carried-marker-strength | U/eval | :435–441, :505–510, :566–572 | explicit indent beats carried section; strongestCls |
| R9 | render-margin-glyph-attachment-3way | U/eval | :573–591 | next-para start / OPEN para mid-flow / promoted re-queue |
| R10 | render-trailing-glyph-promotion | U/eval | :529–544 | multi promotion; `&end` vanishes; `&reference` stays; mid-text untouched |
| R11 | render-orphan-glyph-fallbacks | U/eval | :596–605 | unshift into last `<p>`; else standalone div |
| R12 | applyInlineFormatting-segmentation | U/eval | :772–793 | escape + `*x*`→em; multibyte offsets |
| R13 | renderInlineCommand-all-kinds | U/eval | :799–839 | end invisible; placeholder branches; anchor vs snippet icon; reference resolved/broken |
| R14 | renderInlineCommandsInHtml-regex | U/eval | :846–867 | escaped tokens → links; sketch alias; token straddling `<del>` left as text |
| R15 | applyEffectiveSettings-overlay | U/eval | :874–912 | suggested meta wins; removal drops attr; each data-*/--book-font |
| R16 | patchSentenceInPlace-guards | U/eval | :351–371 | success swaps + curls quotes; refusals (0/2 spans, unknown id, multi-frag, non-p) leave DOM untouched |
| R17 | renderManuscript-anchor-restore | E | :222–227, :266–277, :318–325 | y within ~1px; scroll-during-pagination still restores |
| R18 | renderManuscript-select-and-pageinfo | E | :327–339 | .selected applied; page info after preview resolves |
| R19 | renderManuscript-no-paged-fallback | U/eval | :309–312 | fallback honest or removed |
| R20 | responsive-scaling-mobile-math | E | :373–414 | scale=(vw−24)/576; negative margin equals removed height; desktop clears |
| R21 | migration-poll-banner | E | :110–157 | banner once; poll cleared; Reload works; transient error tolerated |
| R22 | info-line-format | U/eval | :90–108 | format string; null clears |
| R23 | sentence-hover-cross-fragment | E | :916–931 | page-split sentence: all fragments highlight |
| R24 | sentence-click-select-then-notes | E | :932–971 | full sentenceMap text used, not fragment textContent |
| R25 | render-reentrancy | E | :209–340 | two overlapping renders → exactly one `.pagedjs_pages` survives (pins unguarded behavior or motivates guard) |
| R26 | init-redirect-no-manuscript | E | :37–42 | no `?manuscript_id` → home.html replace |
| R27 | inline-ref-delegated-click | E | :29–35, :1179–1185 | reference click scrolls+flashes; survives re-render |

### suggestions.js
| # | Name | Type | Covers | Asserts |
|---|---|---|---|---|
| S1 | loadForMigration-map-and-failure | U/eval | suggestions.js:19–31 | keyed map; failure → {} |
| S2 | *(deletion task, not a test)* | — | :35–108, :1–11 | delete dead code + rewrite header |
| S3 | diff-word-level-basic | U | :358–372, :561–592 | tokenizer ws/word runs; del/strong tags |
| S4 | diff-no-dmp-fallback | U | :359, :554–556 | single `<strong>` + italics |
| S5 | diff-ws-coalescing | U | :384–415 | DEL-EQ-DEL merge; dels-first regroup; splice+rewind terminates |
| S6 | diff-leading-ws-eq-not-absorbed | U | :386–395 | phantom-§ regression pinned |
| S7 | diff-token-overflow-punt | U | :578–579, :588–589 | >65535 tokens → char-diff fallback, no crash |
| S8 | structural-markers-4-rules | U | :451–505 | leading EQ dropped; INS/DEL glyph no `<br>`; mid-content glyph+`<br>`; in-del struck; tag-state safe |
| S9 | italics-pairing-across-inserts | U | :518–549 | pair spans two `<strong>` blocks; in-del excluded; odd count |
| S10 | modal-singleton-and-version-rail-edge | E | :111, :123–147 | second open no-op; buttons disabled null/identical |
| S11 | modal-draft-restore | E | :221–228, :337–340 | draft ≠ server → restored + dirty |
| S12 | modal-save-mirrors-delete-collapse | U/eval | :244–248 | text==original deletes local entry |
| S13 | modal-409-copy-out-path | E | :250–260 | one alert; status pinned; close refuses while unflushed |
| S14 | modal-close-flush-or-refuse | E | :269–310 | failing save blocks close; success: no-net-change skips render; net change → scroll_to + optimistic patch + selection + render + push refresh |
| S15 | modal-tab-inserts-literal | E | :321–326 | Tab `\t`; Shift-Tab escapes |
| S16 | modal-mobile-stacking-no-autofocus | E | :186–196, :332–335 | ≤1239px: in-overlay + note stack + NOT focused; desktop focused |
| S17 | escaped-quotes-diff-stability | E | renderer.js:231–248 + pipeline | apostrophe-adjacent edit shows one-word diff (smartquotes invariant e2e) |

### pagedjs-config.js / range-delete.js
| # | Name | Type | Covers | Asserts |
|---|---|---|---|---|
| P1 | paginated-counter-monotonic | E | pagedjs-config.js:15–20 | +1 per pass — the harness contract itself |
| P2 | no-folio-divider-pages | E | :31–40 | part/title pages hide folio |
| P3 | afterRendered-rebinds-on-rerender | E | :42–54 + renderer.js:281–299 | after in-place re-render: NEW pages have spaces, hover, bars (the old-tree race pinned) |
| P4 | paged-late-load-retry | U/eval | :4–8 | registers once Paged appears; no double registration |
| D1 | range-select-order-independent | E | range-delete.js:67–84 | B-then-A same range; unknown ids no-op |
| D2 | range-native-selection-swallowed | E | :31–37 | shift-mousedown → no browser selection |
| D3 | range-exit-paths | E | :38–59, :187–192 | Escape / empty click / sentence click re-anchors / trash click stays |
| D4 | range-trash-two-click-and-rearm | E | :99–111 | arm → 2s disarm → armed click applies |
| D5 | range-apply-partial-failure | E | :155–177 | mid-range PUT abort → alert, exit, refetch, render |
| D6 | range-trash-position-scaled | E | :112–133 | position correct under transform: scale |
| D7 | orderedIds-field-contract | U/eval | :62–65 | pins (or removes) the `sentence_id` fallback |

**Rewrite-priority order:** S2 (delete dead code + fix the three stale
comments) first; then C9/C11/S5/S6/S8/R9/R10/R16 (the branches most likely to
silently regress); then P1/P3 (so every later e2e's synchronization primitive
is itself pinned).

---

# Appendix A — Runner-up: notes UI + book.css (findings preserved)

Not in the top 3, but reviewed in the same sweep; key findings so they aren't
lost. Full 53-test inventory available on request — the highest-value subset:

**Bugs / hazards found:**
- **Stale-sentence PUT** (`notes.js:827, :851`): `saveNoteText`/`updateNoteColor`
  send full-object PUTs with `sentence_id: this.currentSentenceId` — a
  blur-save firing after the user selected another sentence re-points the note.
  (`updateNoteDims` :874–887 proves the server accepts bare patches, so the
  full payloads are both redundant and dangerous.)
- **Attribute injection surface** (`note-widget.js:28, :103`): `esc()` is
  `String()` coercion, not an escaper, interpolated into `data-v="${esc(o.value)}"` —
  a task-type name containing `"` breaks the attribute.
- **~260 dead lines in book.css (7.7%)**: `.color-palette` 967–985,
  `#sticky-note-container` block 1035–1111, `.trash-icon/.cancel-delete`
  1287–1335, `.note-item` 1338–1361, `.priority-chip`/`.flag-chip` 1434–1525,
  `.palette-trash` 1974–2014, `.sn-src-note` 1690–1692, `#note-sidebar` 2505.
- **Five-way geometry constant duplication**: `SPACING` (notes.js:21–26) ↔
  `:root` vars (book.css:3–21) ↔ `576px !important` (:397–403) ↔
  `DESKTOP_MIN_WIDTH 1240` (notes.js:33) ↔ `@media 1239px` (:3056) — plus a
  third breakpoint pair 768/769 (renderer.js:377 / book.css:3278). CSS
  `≤1239px` vs JS `≥1240` leaves fractional widths (1239.5 under DPR) with
  NEITHER layout.
- `.tag-suggest` block duplicated verbatim (book.css:3343–3364 ≡
  home.css:468–489); six-color stanza repeated ~10× across 3 files; the
  z-index ladder (11→30000 across 3 files) enforced only by comments; the
  mobile `@media (max-width:1239px)` at :3056 overrides base rules from 9+
  regions spanning lines 96–3034 — any base rule appended after :3270 silently
  beats it (AGENTS N12's known trap).
- Dead code in notes.js: `createPaletteElement` :391–421 (zero callers),
  `saveTimeout` :348 (never assigned), `updateSentenceHighlights` :726
  (documented no-op, still called from 3 sites); inert `+ tag` chip
  (:484, :511 — no handler).

**Priority tests if/when this area is tackled:** stale-sentence PUT pin
(notes.js:842–869 ⚠), attribute-injection pin (widget:103 ⚠),
`criteriaMatches` unit (widget:885–896), note-api fallback unit
(note-api.js:15–28), breakpoint-boundary matrix (1239/1240/1239.5),
pane-visibility computed-display matrix (book.css:3141, :3164, :3338–3339 —
the N12 canary), z-index `elementFromPoint` ladder, tag-suggest drift check
(fail if the two copies diverge), points-star state machine
(widget:373–424), never-mind commit boundaries (notes.js:186–196, :374).

---

# Appendix B — Cross-cutting quick wins (do before/with any rewrite)

1. Close the three security gaps: system-token on wordcount-compute
   (admin.go:507), CSRF on note create (notes.go:269), access+CSRF on
   place-plan (variations.go handlers :401).
2. Fix `changes_count` (processor.go:197–217) — one-line fix + test #127.
3. Fix the doc-save in-flight data loss (editor-core:2147) — ideally by the
   DRY.md item-3 port onto `createAutosaver`.
4. Delete dead code: suggestions.js:35–108; notes.js:391–421; the ~260 dead
   book.css lines; fix the four lying comments (suggestions.js:1–11,
   pagedjs-config.js:1, text-markers.js:39–40, editor-core:1740–1742).
5. Unify the escapers (DRY.md item 1 — now counted at ×6 across the repo) and
   the CSRF/fetch helpers (DRY.md item 2).
