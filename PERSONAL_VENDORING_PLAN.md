# Plan: Personal vendor repos (segman + tuft)

**Status: SHIPPED 2026-04-24.**

- segman v1.0.0 lives at github.com/slackwing/segman (clean layout,
  package renamed from `senseg`, version exported as `const Version`).
- tuft v0.1.0 lives at github.com/slackwing/tuft.
- manuscript-studio vendors both via `scripts/vendor-{segman,tuft}.sh`,
  pinned to tags by default.
- `migrations.SegmenterVersion` reads from upstream's exported `Version`
  constant — vendor refresh automatically updates the migration stamp.

The plan below is preserved as a record of how it was done. The
"deep refactor in Phase 6" was abandoned mid-execution and folded
into the upstream repo's first proper release; manuscript-studio was
re-vendored against that release rather than the messy first import.

Goal: extract `segman` (sentence segmenter) and `rainbow-slice.js` into
their own GitHub repos, then re-import them into manuscript-studio via a
clean vendor-by-copy workflow.

Both repos already exist on disk:
- `~/src/segman/` (LICENSE only)
- `~/src/tuft/` (LICENSE only)

Source-of-truth for segman: `~/src/feathers/15.segman/`. **Do not modify**
that directory — copy out, never edit in place.

Source-of-truth for rainbow-slice: `web/js/rainbow-slice.js` here in
manuscript-studio.

---

## Phase 1 — Bootstrap segman repo

### 1.1 Copy source

Copy these from `~/src/feathers/15.segman/` to `~/src/segman/`:

- `src/` — language sources
- `exports/` — built artifacts (`lib/{go,js,rust}` + CLIs)
- `tests/` — test scenarios + harnesses
- `reference/` — `the-wildfire.manuscript`
- `build-segman`, `build-tools`, `run-tests` — build scripts
- `AGENTS.md`, `SPECS.md`, `VERSION.json`

### 1.2 Skip / repurpose dev journal docs

Files that look like build-time scratchpads (`PLAN_V3.md`, `SUMMARY.md`):

- If they contain only "what I did during this session" history → **skip**.
- If they contain unimplemented TODOs / open questions → distill those
  into `DEVELOPMENT_NOTES.md` (standard name; see also `HACKING.md`,
  `NOTES.md` — but `DEVELOPMENT_NOTES.md` is the most searchable).
- Defer to user-confirmation on which.

### 1.3 First commit

```
chore: import segman v1.0.0 from ~/src/feathers/15.segman
```

Push to `github.com/slackwing/segman` `main`.

### 1.4 Verify tests pass

Run `~/src/segman/run-tests` (or whatever the entry script is). Capture
any failures BEFORE touching code — these are pre-existing, not caused
by the move.

---

## Phase 2 — Bootstrap tuft repo

### 2.1 Copy `rainbow-slice.js`

Copy `web/js/rainbow-slice.js` and the matching test
`tests/test-rainbow-slice.js` from manuscript-studio to `~/src/tuft/`.

### 2.2 Repo structure (open the door for any language)

```
tuft/
├── LICENSE
├── README.md
├── lib/
│   └── js/
│       └── rainbow-slice.js
├── tests/
│   └── js/
│       └── test-rainbow-slice.js
└── package.json   # for `node tests/js/test-rainbow-slice.js`
```

The `lib/{lang}/` and `tests/{lang}/` shape leaves room for
`lib/go/`, `lib/rust/`, etc. without restructuring later.

### 2.3 First commit

```
chore: import rainbow-slice.js from manuscript-studio
```

Push to `github.com/slackwing/tuft` `main`.

### 2.4 Verify tests pass

Run `node tests/js/test-rainbow-slice.js`.

---

## Phase 3 — Vendor scripts in manuscript-studio

Two scripts under `scripts/` (this is a new directory — keep deploy
scripts in repo root as today). Both are vendor-by-copy, idempotent,
and stamp the upstream commit + version into the vendored tree so
re-vendoring is reproducible.

### 3.1 `scripts/vendor-segman.sh`

```
Usage: scripts/vendor-segman.sh [--ref=<git-ref>] [--source=<path>]
```

Behaviour:

1. Default `--source=~/src/segman` (local clone), default `--ref=main`.
2. `git -C $source fetch && git -C $source checkout $ref` (so re-vendor
   from a specific tag is one flag).
3. Copy `lib/{go,js}/segman.{go,js}` over `internal/segman/segman.go`
   and `web/js/segman.js`.
4. **Critical**: also copy `VERSION.json` to a manuscript-studio path
   that the Go code reads (see Phase 4 for how this gets picked up).
5. Stamp a `internal/segman/UPSTREAM` text file with: source ref +
   short SHA + vendored-at timestamp. Diff in PRs reads
   "vendored segman <sha> at <ts>" — easy review.
6. Run `go build ./...` to verify the vendored code still compiles.
7. Print a one-line summary; non-zero exit on any step failure.

### 3.2 `scripts/vendor-tuft.sh`

Same shape as vendor-segman, but only copies JS files. No version
propagation needed (tuft utilities don't affect DB hashes).

### 3.3 What we WON'T do

- No npm publish, no Go modules publish — vendor-by-copy is the contract.
- No git submodules — they're a footgun for this scale.

---

## Phase 4 — Auto-flow segman version into manuscript-studio

**Today**: `internal/migrations/processor.go:15` has
`const SegmenterVersion = "segman-1.0.0"` — hand-edited.

**Goal**: vendor upgrade alone updates the version that lands on the
`migration.segmenter` DB column. No manual edit needed.

**Implementation**:

1. `vendor-segman.sh` copies the upstream `VERSION.json` to
   `internal/segman/VERSION.json` (alongside the vendored `segman.go`).
2. New `internal/segman/version.go` reads it at startup via `embed`:

   ```go
   //go:embed VERSION.json
   var versionJSON []byte

   var Version = func() string {
       var v struct{ Version string `json:"version"` }
       _ = json.Unmarshal(versionJSON, &v)
       return "segman-" + v.Version  // matches existing format
   }()
   ```
3. `internal/migrations/processor.go`: replace
   `const SegmenterVersion = "segman-1.0.0"` with
   `var SegmenterVersion = segman.Version`.
4. Test: bumping `VERSION.json` to `"version":"1.0.1"` and rebuilding
   produces `migration.segmenter = "segman-1.0.1"` on the next bootstrap.

**JS side** (segman.js): the JS segmenter doesn't write to the DB — Go
owns that. JS just needs to produce the same sentence IDs. Since the
hash inputs (`normalizedText + ordinal + commitHash`) don't include
the segmenter version (verified — see id.go), the JS side has nothing
to do. The migration row records the version that segmented; the IDs
themselves are version-agnostic by design.

### ⚠️ Known divergence risk — separate plan needed

The user flagged this and is correct: **two different segmenter
versions can produce different sentences for the same commit**, which
means **different sentence_ids for the "same" text** even though the
commit hash going into the hash is identical. The `migration.segmenter`
column tells you which segmenter ran, but the IDs themselves carry no
version info, so cross-version comparisons can silently wrong-match.

Concrete failure modes (all dormant at v1.0.0 with one version live):

- A vendor upgrade rebuilds the same commit → new migration → new IDs
  → old annotations/suggestions only reachable via
  `previous_sentence_id` chain.
- Browser JS segmenter (vendored to one version) disagreeing with
  server Go segmenter (vendored to another) during a partial deploy.

Out of scope for this plan. The right fix is one of:
1. Mix `segmenterVersion` into `GenerateSentenceID`'s hash. (Most
   correct; existing sentence_ids change meaning, so do a one-shot
   ID backfill if you care.)
2. Refuse to bootstrap a commit that already has a migration with a
   different segmenter.
3. Pin segmenter version per manuscript in config.

Track this as `SEGMENTER_VERSION_HARDENING_PLAN.md` once segman is
properly extracted.

---

## Phase 5 — Re-vendor into manuscript-studio "from scratch"

Delete the existing vendored files first so this is a real cold start:

1. `rm internal/segmenter/segman.go web/js/segmenter.js
   web/js/rainbow-slice.js`
2. `rmdir internal/segmenter` (replaced by `internal/segman/`).
3. Run `scripts/vendor-segman.sh` and `scripts/vendor-tuft.sh`.
4. Update import paths: `internal/segmenter` → `internal/segman` in all
   Go files. Web script tag: `web/js/segmenter.js` → `web/js/segman.js`.
   (Cache-bust both via the `?v=` query in `web/index.html`.)
5. Run all tests:
   - `go test ./...`
   - `./test-all.sh fast` and `./test-all.sh slow`
6. Commit:
   ```
   chore: vendor segman + tuft from new upstream repos

   - segman from github.com/slackwing/segman
   - rainbow-slice from github.com/slackwing/tuft
   - vendor-{segman,tuft}.sh added under scripts/
   - SegmenterVersion now sourced from segman/VERSION.json (auto-bumps
     on vendor upgrade)
   ```
7. Push + deploy.

---

## Phase 6 — "Deep pass" on each repo (separate from manuscript-studio)

Do this AFTER Phase 5 so manuscript-studio is using the new repos
end-to-end first. Iterate freely on the upstream repos without any
fear of breaking the consumer; re-vendor only when ready.

### 6.1 segman

Audit and refactor for "professional library" feel:

- **README.md**: install/usage/version policy. Currently doesn't exist
  in the repo proper.
- **Export pattern**: each language's `lib/` should expose ONE clear
  surface (e.g. `Segment(text) -> []Sentence` in Go, `segment(text)`
  in JS). Avoid scope sprawl — the CLI tools live separately under
  `exports/cli/` and consume the lib.
- **File organization**: today the layout mixes `src/`, `exports/`,
  `build-segman` script. Decide: do consumers vendor from `exports/lib/`
  (today) or from `lib/` at repo root (more standard)? Most JS libs
  publish from a top-level `dist/` or just root `index.js`. For Go,
  the import path BECOMES the directory, so the tree shape matters.
  Propose: flatten to
  ```
  segman/
  ├── go/segman.go        # github.com/slackwing/segman/go
  ├── js/segman.js        # @slackwing/segman/js (if ever published)
  ├── rust/...
  ├── tests/
  ├── reference/
  └── tools/              # was exports/cli — internal dev tools
  ```
  Update `vendor-segman.sh` accordingly. Bump segman to 1.1.0 (minor
  bump signals "no behavior change, just structural").
- **Test coverage audit (Phase 6 part b)**: `~/src/feathers/15.segman/
  tests/scenarios.jsonl` is the regression corpus. Audit:
  - Every segmentation rule has at least one positive + one negative
    case?
  - Every recent bug-fix has a test pinning it (per the SUMMARY.md
    notes about RULE 3 dialogue attribution — that should have a test)?
  - Test runner reports per-language coverage so go/js/rust drift is
    visible?
  Add tests for any gaps found.
- **VERSION.json** stays at `1.0.0` for the import. The 1.1.0 bump
  happens at the structural-refactor commit (Phase 6).
- **AGENTS.md** stays as-is unless it references paths that changed.

### 6.2 tuft

Smaller scope:

- **README.md**: state the scope discipline ("small, generic JS
  utilities — no DOM, no project-specific code"). Without this written
  down it'll drift into the attic problem.
- **Export pattern**: `lib/js/index.js` re-exports each utility, so
  consumers can `require('tuft')` and get `{rainbowSlice}` — the
  start of a coherent public surface. Keep individual files too.
- **Test runner**: `npm test` runs all `tests/js/test-*.js`. Today
  rainbow-slice's test file exists in manuscript-studio's style (a
  standalone `node test-rainbow-slice.js` script); keep that style
  for now to avoid inventing an unjustified test framework.
- **Add a CONTRIBUTING.md** with the rule "extract on the second use,
  not the first." Future-you needs this.

---

## Order of operations

1. **Phase 1** (segman bootstrap) → push.
2. **Phase 2** (tuft bootstrap) → push.
3. **Phase 3** (vendor scripts in manuscript-studio).
4. **Phase 4** (version flow).
5. **Phase 5** (re-vendor from scratch + commit + deploy).
6. **Phase 6** (deep refactor of segman + tuft, then re-vendor v1.1.0
   if structural changes).

Phases 1–5 are mechanical and testable. Phase 6 is iterative.

---

## Rollback plan

If anything in Phase 5 breaks manuscript-studio:

- The vendored files are tracked in git → `git revert` the vendor commit.
- Re-vendoring is idempotent → running the script again with an older
  ref restores the old state.
- Per-language tests in segman repo verify the library in isolation, so
  a regression there is caught before it can be vendored.

---

## Open questions resolved (per user)

| Q | Resolution |
|---|---|
| Segman languages? | All three: go, js, rust. |
| Distribution? | Vendor-by-copy via script; no npm/Go-modules publish. |
| Version stays at? | 1.0.0 for import. Auto-flow into manuscript-studio. |
| Tuft languages? | Open the door for all (`lib/{lang}/` shape). |
| PLAN_V3.md / SUMMARY.md? | Skip if dev-journal; distill TODOs into DEVELOPMENT_NOTES.md if any. |
| Test coverage scope? | (a) verify pass on copy, (b) audit + add in Phase 6. |
