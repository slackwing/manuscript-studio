package database

// Integration tests for variations.go against the dev Postgres fixture DB
// (CODE_REVIEW_AUG_2026.md AREA 2, rows #75–92; pattern:
// internal/migrations/processor_integration_test.go).
//
// Connects to localhost:5433 by default; override via
// MANUSCRIPT_STUDIO_TEST_DB_URL. Tests skip (not fail) when no DB is
// reachable. Every test mints its own user(s) and rows and cleans them up
// with t.Cleanup — shared fixture data (manuscript_id=1, user 'test') is
// never touched.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const variationsTestDBURL = "postgres://manuscript_dev:manuscript_dev@localhost:5433/manuscript_studio_dev"

var variationsTestCounter int64

func connectVariationsTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("MANUSCRIPT_STUDIO_TEST_DB_URL")
	if url == "" {
		url = variationsTestDBURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Skipf("test DB unreachable, skipping integration test: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("test DB ping failed, skipping integration test: %v", err)
	}
	return pool
}

type varFixture struct {
	pool  *pgxpool.Pool
	db    *DB
	ctx   context.Context
	user  string // owner of everything under test
	other string // a second user for ownership checks
}

func newVarFixture(t *testing.T) *varFixture {
	t.Helper()
	pool := connectVariationsTestDB(t)
	ctx := context.Background()
	n := atomic.AddInt64(&variationsTestCounter, 1)
	user := fmt.Sprintf("var-test-%d-%d", time.Now().UnixNano(), n)
	other := user + "-other"
	f := &varFixture{pool: pool, db: &DB{Pool: pool}, ctx: ctx, user: user, other: other}
	for _, u := range []string{user, other} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO "user" (username, password_hash, role)
			VALUES ($1, '$2a$10$dummy', 'author')
			ON CONFLICT (username) DO NOTHING
		`, u); err != nil {
			t.Fatalf("ensure user %s: %v", u, err)
		}
	}
	t.Cleanup(func() {
		f.cleanup(t)
		pool.Close()
	})
	return f
}

// cleanup removes everything the fixture's users created, FK-safely, and
// nothing else. Runs at exit (unlike the migration tests' clean-on-entry,
// usernames here are unique per run so there's nothing stale to clear).
func (f *varFixture) cleanup(t *testing.T) {
	t.Helper()
	stmts := []string{
		`UPDATE sketch SET canon_variation_id = NULL, placed_from_variation_id = NULL WHERE user_id = $1 OR user_id = $2`,
		`DELETE FROM variation_revision WHERE variation_id IN (
			SELECT v.variation_id FROM variation v JOIN sketch s ON s.sketch_id = v.sketch_id
			WHERE s.user_id = $1 OR s.user_id = $2)`,
		`DELETE FROM note WHERE user_id = $1 OR user_id = $2`,
		`DELETE FROM variation WHERE sketch_id IN (SELECT sketch_id FROM sketch WHERE user_id = $1 OR user_id = $2)`,
		`DELETE FROM sketch WHERE user_id = $1 OR user_id = $2`,
		`DELETE FROM scratchpad_revision WHERE scratchpad_id IN (
			SELECT scratchpad_id FROM scratchpad WHERE user_id = $1 OR user_id = $2)`,
		`DELETE FROM scratchpad WHERE user_id = $1 OR user_id = $2`,
		`DELETE FROM manuscript WHERE repo_path LIKE 'test://variations/' || $1 || '/%'
			OR repo_path LIKE 'test://variations/' || $2 || '/%'`,
		`DELETE FROM "user" WHERE username = $1 OR username = $2`,
	}
	for _, sql := range stmts {
		if _, err := f.pool.Exec(f.ctx, sql, f.user, f.other); err != nil {
			t.Errorf("cleanup %q: %v", sql[:40], err)
		}
	}
}

// newManuscript creates a manuscript row unique to this fixture (cleaned up
// by repo_url prefix).
func (f *varFixture) newManuscript(t *testing.T) int {
	t.Helper()
	n := atomic.AddInt64(&variationsTestCounter, 1)
	m, err := f.db.CreateManuscript(f.ctx, fmt.Sprintf("test://variations/%s/%d", f.user, n), "manuscript.md")
	if err != nil {
		t.Fatalf("CreateManuscript: %v", err)
	}
	return m.ManuscriptID
}

func (f *varFixture) newPad(t *testing.T, title string) int {
	t.Helper()
	s, err := f.db.CreateScratchpad(f.ctx, f.user, title)
	if err != nil {
		t.Fatalf("CreateScratchpad: %v", err)
	}
	return s.ScratchpadID
}

func (f *varFixture) newSketch(t *testing.T, padID *int) *VariationContext {
	t.Helper()
	vc, err := f.db.CreateSketch(f.ctx, f.user, padID)
	if err != nil {
		t.Fatalf("CreateSketch: %v", err)
	}
	return vc
}

// insertVariation writes a variation row directly (for canon NULL-ordinal
// rows and ordinal-cap seeding that the public API can't produce).
func (f *varFixture) insertVariation(t *testing.T, sketchID string, ordinal *int, text, state string) int {
	t.Helper()
	var id int
	if err := f.pool.QueryRow(f.ctx, `
		INSERT INTO variation (sketch_id, ordinal, text, state) VALUES ($1, $2, $3, $4)
		RETURNING variation_id
	`, sketchID, ordinal, text, state).Scan(&id); err != nil {
		t.Fatalf("insert variation: %v", err)
	}
	return id
}

func intPtr(n int) *int { return &n }

// ---------------------------------------------------------------- #75

func TestNewSketchID_AlphabetAndLength(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 200; i++ {
		id, err := newSketchID()
		if err != nil {
			t.Fatalf("newSketchID: %v", err)
		}
		if len(id) != 10 {
			t.Fatalf("id %q: want 10 chars, got %d", id, len(id))
		}
		for _, c := range id {
			if !strings.ContainsRune(sketchIDAlphabet, c) {
				t.Fatalf("id %q contains %q outside the base36 alphabet", id, c)
			}
		}
		if seen[id] {
			t.Fatalf("duplicate id %q in 200 draws (52 bits should never collide here)", id)
		}
		seen[id] = true
	}
}

// ---------------------------------------------------------------- #76

func TestCreateSketch_MintsVariationA_AndNote(t *testing.T) {
	f := newVarFixture(t)
	mID := f.newManuscript(t)
	padID := f.newPad(t, "home pad")
	if err := f.db.LinkScratchpad(f.ctx, padID, &mID); err != nil {
		t.Fatalf("link pad: %v", err)
	}

	vc := f.newSketch(t, &padID)

	if vc.Variation.Ordinal == nil || *vc.Variation.Ordinal != 1 {
		t.Errorf("variation A ordinal = %v, want 1", vc.Variation.Ordinal)
	}
	if vc.Variation.State != "draft" {
		t.Errorf("variation A state = %q, want draft", vc.Variation.State)
	}
	if vc.Variation.ScratchpadID == nil || *vc.Variation.ScratchpadID != padID {
		t.Errorf("variation A home = %v, want %d", vc.Variation.ScratchpadID, padID)
	}
	if len(vc.Siblings) != 1 || vc.Siblings[0].VariationID != vc.Variation.VariationID {
		t.Errorf("siblings = %+v, want just variation A", vc.Siblings)
	}
	if vc.Sketch.CanonVariationID != 0 {
		t.Errorf("fresh sketch canon = %d, want 0", vc.Sketch.CanonVariationID)
	}

	// The sketch note (026): minted with the sketch, yellow, manuscript
	// inherited (copied) from the host pad's link.
	if vc.Note == nil {
		t.Fatal("context should carry the sketch note")
	}
	if vc.Note.Color != "yellow" || vc.Note.Completed {
		t.Errorf("sketch note = %+v, want yellow / not completed", vc.Note)
	}
	var noteManuscript *int
	if err := f.pool.QueryRow(f.ctx, `
		SELECT manuscript_id FROM note WHERE sketch_id = $1 AND deleted_at IS NULL
	`, vc.Sketch.SketchID).Scan(&noteManuscript); err != nil {
		t.Fatalf("read sketch note: %v", err)
	}
	if noteManuscript == nil || *noteManuscript != mID {
		t.Errorf("note manuscript = %v, want inherited %d", noteManuscript, mID)
	}

	// Homeless sketch (nil pad): still one variation + one note, no manuscript.
	vc2 := f.newSketch(t, nil)
	if vc2.Variation.ScratchpadID != nil {
		t.Errorf("homeless variation has scratchpad %v", vc2.Variation.ScratchpadID)
	}
	if vc2.Note == nil {
		t.Error("homeless sketch should still carry a note")
	}
}

// ---------------------------------------------------------------- #77 ⚠

// The retry loop at variations.go:136–148 re-runs the INSERT inside the SAME
// transaction that the collision just aborted, so every retry dies with
// 25P02 ("current transaction is aborted"). Intended semantics: an ID
// collision is retriable. This test pins the mechanism the loop depends on.
func TestCreateSketch_IDCollisionRetryWorks(t *testing.T) {
	t.Skip("PENDING-FIX: newSketchID collision retry re-INSERTs inside the aborted tx (variations.go:136–148) and always fails with 25P02; use a savepoint or generate/insert before the tx — enable after fix")

	f := newVarFixture(t)
	existing := f.newSketch(t, nil) // occupies one sketch_id

	// Replicate exactly what CreateSketch's retry loop does: a failed INSERT
	// followed by another INSERT in the same tx. For the retry to ever
	// succeed, the second INSERT must work.
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(f.ctx)
	if _, err := tx.Exec(f.ctx, `INSERT INTO sketch (sketch_id, user_id) VALUES ($1, $2)`,
		existing.Sketch.SketchID, f.user); err == nil {
		t.Fatal("duplicate sketch_id insert should have failed")
	}
	freshID, err := newSketchID()
	if err != nil {
		t.Fatalf("newSketchID: %v", err)
	}
	if _, err := tx.Exec(f.ctx, `INSERT INTO sketch (sketch_id, user_id) VALUES ($1, $2)`,
		freshID, f.user); err != nil {
		t.Fatalf("retry insert after collision must succeed, got: %v", err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

// ---------------------------------------------------------------- #78

func TestCreateVariationFrom_NextLetter_TextCopied(t *testing.T) {
	f := newVarFixture(t)
	a := f.newSketch(t, nil)
	aID := a.Variation.VariationID
	if err := f.db.UpdateVariationText(f.ctx, f.user, aID, "the source text"); err != nil {
		t.Fatalf("seed A text: %v", err)
	}

	padID := f.newPad(t, "b home")
	b, err := f.db.CreateVariationFrom(f.ctx, f.user, aID, &padID)
	if err != nil {
		t.Fatalf("CreateVariationFrom: %v", err)
	}
	if b.Variation.Ordinal == nil || *b.Variation.Ordinal != 2 {
		t.Errorf("B ordinal = %v, want 2", b.Variation.Ordinal)
	}
	if b.Variation.Text != "the source text" {
		t.Errorf("B text = %q, want the source's text copied", b.Variation.Text)
	}
	if b.Variation.ScratchpadID == nil || *b.Variation.ScratchpadID != padID {
		t.Errorf("B home = %v, want %d", b.Variation.ScratchpadID, padID)
	}
	// Source untouched: no lineage, no freezing.
	src, err := f.db.GetVariationContext(f.ctx, f.user, aID)
	if err != nil {
		t.Fatalf("re-read A: %v", err)
	}
	if src.Variation.State != "draft" || src.Variation.Text != "the source text" {
		t.Errorf("source changed: %+v", src.Variation)
	}
	if len(b.Siblings) != 2 {
		t.Errorf("siblings = %d, want 2", len(b.Siblings))
	}

	// Basing on the canon variation (NULL ordinal) is refused.
	canonID := f.insertVariation(t, a.Sketch.SketchID, nil, "snapshot", "frozen")
	if _, err := f.db.CreateVariationFrom(f.ctx, f.user, canonID, nil); !errors.Is(err, ErrVariationNoLetter) {
		t.Errorf("canon source: err = %v, want ErrVariationNoLetter", err)
	}

	// 27th letter is refused.
	capSketch := f.newSketch(t, nil)
	f.insertVariation(t, capSketch.Sketch.SketchID, intPtr(MaxVariationOrdinal), "z text", "draft")
	if _, err := f.db.CreateVariationFrom(f.ctx, f.user, capSketch.Variation.VariationID, nil); !errors.Is(err, ErrOrdinalCap) {
		t.Errorf("27th variation: err = %v, want ErrOrdinalCap", err)
	}

	// Someone else's variation reads as not-found.
	if _, err := f.db.CreateVariationFrom(f.ctx, f.other, aID, nil); !errors.Is(err, ErrNotOwner) {
		t.Errorf("other user: err = %v, want ErrNotOwner", err)
	}
}

// ---------------------------------------------------------------- #79 ⚠

// Two concurrent CreateVariationFrom calls on DIFFERENT siblings of the same
// sketch both compute MAX(ordinal)+1 outside any sketch-level lock
// (variations.go:186–201 locks only the source row), collide on
// idx_variation_sketch_ordinal, and one caller gets a raw unique-violation
// (surfaced as a 500). Intended semantics: both succeed with distinct
// ordinals (or at worst a clean, mappable sentinel).
func TestCreateVariationFrom_ConcurrentOrdinalRace(t *testing.T) {
	t.Skip("PENDING-FIX: concurrent next-ordinal computation races (variations.go:186–201; unique idx violation surfaces as 500); lock the sketch row (as CreateVariationFromText does) — enable after fix")

	f := newVarFixture(t)
	a := f.newSketch(t, nil)
	aID := a.Variation.VariationID
	b, err := f.db.CreateVariationFrom(f.ctx, f.user, aID, nil)
	if err != nil {
		t.Fatalf("create B: %v", err)
	}
	bID := b.Variation.VariationID

	var wg sync.WaitGroup
	errs := make([]error, 2)
	ords := make([]int, 2)
	for i, src := range []int{aID, bID} {
		wg.Add(1)
		go func(i, src int) {
			defer wg.Done()
			vc, err := f.db.CreateVariationFrom(f.ctx, f.user, src, nil)
			errs[i] = err
			if err == nil && vc.Variation.Ordinal != nil {
				ords[i] = *vc.Variation.Ordinal
			}
		}(i, src)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent CreateVariationFrom[%d] failed: %v", i, err)
		}
	}
	if ords[0] == ords[1] {
		t.Fatalf("both new variations got ordinal %d", ords[0])
	}
}

// ---------------------------------------------------------------- #80

func TestGetVariationContext_FullPayload(t *testing.T) {
	f := newVarFixture(t)
	mID := f.newManuscript(t)
	a := f.newSketch(t, nil)
	aID := a.Variation.VariationID
	sketchID := a.Sketch.SketchID

	b, err := f.db.CreateVariationFrom(f.ctx, f.user, aID, nil)
	if err != nil {
		t.Fatalf("create B: %v", err)
	}
	bID := b.Variation.VariationID
	c, err := f.db.CreateVariationFrom(f.ctx, f.user, aID, nil)
	if err != nil {
		t.Fatalf("create C: %v", err)
	}
	// C soft-deleted → must vanish from siblings.
	if err := f.db.SoftDeleteVariation(f.ctx, f.user, c.Variation.VariationID); err != nil {
		t.Fatalf("delete C: %v", err)
	}
	// B placed → canon pointer, link, placed-from.
	if _, err := f.db.CanonizeVariation(f.ctx, f.user, bID, mID, "My Book"); err != nil {
		t.Fatalf("canonize B: %v", err)
	}
	// The sketch note completed → square state rides along.
	if _, err := f.pool.Exec(f.ctx, `UPDATE note SET completed_at = NOW() WHERE sketch_id = $1`, sketchID); err != nil {
		t.Fatalf("complete note: %v", err)
	}

	vc, err := f.db.GetVariationContext(f.ctx, f.user, aID)
	if err != nil {
		t.Fatalf("GetVariationContext: %v", err)
	}
	if len(vc.Siblings) != 2 {
		t.Fatalf("siblings = %+v, want [A B] (deleted C excluded)", vc.Siblings)
	}
	if *vc.Siblings[0].Ordinal != 1 || *vc.Siblings[1].Ordinal != 2 {
		t.Errorf("siblings not letter-ordered: %+v", vc.Siblings)
	}
	if vc.Sketch.CanonVariationID != bID || vc.Sketch.PlacedFromVariationID != bID {
		t.Errorf("sketch facts = %+v, want canon/placed-from = %d", vc.Sketch, bID)
	}
	if vc.Sketch.LinkedManuscriptID != mID || vc.Sketch.LinkedManuscriptName != "My Book" {
		t.Errorf("link = %d/%q, want %d/My Book", vc.Sketch.LinkedManuscriptID, vc.Sketch.LinkedManuscriptName, mID)
	}
	if vc.Canon == nil || vc.Canon.VariationID != bID {
		t.Errorf("canon = %+v, want variation %d", vc.Canon, bID)
	}
	if vc.Note == nil || !vc.Note.Completed {
		t.Errorf("note = %+v, want completed sketch note", vc.Note)
	}

	// Missing, soft-deleted, and foreign ids all read as not-found.
	if _, err := f.db.GetVariationContext(f.ctx, f.user, c.Variation.VariationID); !errors.Is(err, ErrNotOwner) {
		t.Errorf("deleted variation: err = %v, want ErrNotOwner", err)
	}
	if _, err := f.db.GetVariationContext(f.ctx, f.other, aID); !errors.Is(err, ErrNotOwner) {
		t.Errorf("other user: err = %v, want ErrNotOwner", err)
	}
	if _, err := f.db.GetVariationContext(f.ctx, f.user, 0); !errors.Is(err, ErrNotOwner) {
		t.Errorf("missing id: err = %v, want ErrNotOwner", err)
	}
}

// #80's ⚠ half: the canon fetch (variations.go:281–288) has no deleted_at
// filter, and SoftDeleteVariation happily deletes the placed lettered
// variation the canon pointer targets. Intended semantics (invariant 2.2#8:
// "canon variation frozen/immutable/undeletable"): deleting the current
// canon variation is refused.
func TestGetVariationContext_CanonUndeletable(t *testing.T) {
	t.Skip("PENDING-FIX: SoftDeleteVariation only guards NULL-ordinal rows (variations.go:426), so the placed/canon lettered variation can be soft-deleted while GetVariationContext keeps serving it as canon (:281–288); refuse deleting the canon variation — enable after fix")

	f := newVarFixture(t)
	mID := f.newManuscript(t)
	a := f.newSketch(t, nil)
	aID := a.Variation.VariationID
	if _, err := f.db.CanonizeVariation(f.ctx, f.user, aID, mID, "My Book"); err != nil {
		t.Fatalf("canonize A: %v", err)
	}

	if err := f.db.SoftDeleteVariation(f.ctx, f.user, aID); !errors.Is(err, ErrVariationCanon) {
		t.Fatalf("deleting the placed canon variation: err = %v, want ErrVariationCanon", err)
	}
}

// ---------------------------------------------------------------- #81

func TestUpdateVariationText_StateGates(t *testing.T) {
	f := newVarFixture(t)
	a := f.newSketch(t, nil)
	aID := a.Variation.VariationID

	// Happy path: text set, revision appended, updated_at bumped.
	if err := f.db.UpdateVariationText(f.ctx, f.user, aID, "draft one"); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := f.db.UpdateVariationText(f.ctx, f.user, aID, "draft two"); err != nil {
		t.Fatalf("update 2: %v", err)
	}
	vc, err := f.db.GetVariationContext(f.ctx, f.user, aID)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if vc.Variation.Text != "draft two" {
		t.Errorf("text = %q, want draft two", vc.Variation.Text)
	}
	var revisions int
	if err := f.pool.QueryRow(f.ctx, `SELECT COUNT(*) FROM variation_revision WHERE variation_id = $1`, aID).Scan(&revisions); err != nil {
		t.Fatalf("count revisions: %v", err)
	}
	if revisions != 2 {
		t.Errorf("revisions = %d, want 2 (append-only house pattern)", revisions)
	}

	// Frozen refuses.
	if err := f.db.SetVariationState(f.ctx, f.user, aID, "frozen"); err != nil {
		t.Fatalf("freeze: %v", err)
	}
	if err := f.db.UpdateVariationText(f.ctx, f.user, aID, "sneaky"); !errors.Is(err, ErrVariationFrozen) {
		t.Errorf("frozen: err = %v, want ErrVariationFrozen", err)
	}

	// Superseded refuses.
	if err := f.db.SetVariationState(f.ctx, f.user, aID, "superseded"); err != nil {
		t.Fatalf("supersede: %v", err)
	}
	if err := f.db.UpdateVariationText(f.ctx, f.user, aID, "sneaky"); !errors.Is(err, ErrVariationSuperseded) {
		t.Errorf("superseded: err = %v, want ErrVariationSuperseded", err)
	}

	// Canon (NULL ordinal) refuses.
	canonID := f.insertVariation(t, a.Sketch.SketchID, nil, "snapshot", "frozen")
	if err := f.db.UpdateVariationText(f.ctx, f.user, canonID, "sneaky"); !errors.Is(err, ErrVariationCanon) {
		t.Errorf("canon: err = %v, want ErrVariationCanon", err)
	}

	// No refusal wrote anything.
	if err := f.pool.QueryRow(f.ctx, `SELECT COUNT(*) FROM variation_revision WHERE variation_id = $1`, aID).Scan(&revisions); err != nil {
		t.Fatalf("recount revisions: %v", err)
	}
	if revisions != 2 {
		t.Errorf("refused updates appended revisions: %d, want still 2", revisions)
	}

	if err := f.db.UpdateVariationText(f.ctx, f.other, aID, "sneaky"); !errors.Is(err, ErrNotOwner) {
		t.Errorf("other user: err = %v, want ErrNotOwner", err)
	}
}

// ---------------------------------------------------------------- #82

func TestSetVariationState_ValidatesAndGuardsCanon(t *testing.T) {
	f := newVarFixture(t)
	a := f.newSketch(t, nil)
	aID := a.Variation.VariationID

	if err := f.db.SetVariationState(f.ctx, f.user, aID, "banana"); err == nil ||
		!strings.Contains(err.Error(), "invalid variation state") {
		t.Errorf("invalid state: err = %v, want invalid-state error", err)
	}

	// One column: frozen and superseded are mutually exclusive by construction.
	for _, state := range []string{"frozen", "superseded", "draft"} {
		if err := f.db.SetVariationState(f.ctx, f.user, aID, state); err != nil {
			t.Fatalf("set %s: %v", state, err)
		}
		vc, err := f.db.GetVariationContext(f.ctx, f.user, aID)
		if err != nil {
			t.Fatalf("re-read: %v", err)
		}
		if vc.Variation.State != state {
			t.Errorf("state = %q, want %q", vc.Variation.State, state)
		}
	}

	canonID := f.insertVariation(t, a.Sketch.SketchID, nil, "snapshot", "frozen")
	if err := f.db.SetVariationState(f.ctx, f.user, canonID, "draft"); !errors.Is(err, ErrVariationCanon) {
		t.Errorf("canon: err = %v, want ErrVariationCanon", err)
	}

	if err := f.db.SetVariationState(f.ctx, f.other, aID, "frozen"); !errors.Is(err, ErrNotOwner) {
		t.Errorf("other user: err = %v, want ErrNotOwner", err)
	}
}

// ---------------------------------------------------------------- #83

func TestFreezeAllVariations_DraftsOnly(t *testing.T) {
	f := newVarFixture(t)
	a := f.newSketch(t, nil)
	sketchID := a.Sketch.SketchID
	b, err := f.db.CreateVariationFrom(f.ctx, f.user, a.Variation.VariationID, nil)
	if err != nil {
		t.Fatalf("create B: %v", err)
	}
	if err := f.db.SetVariationState(f.ctx, f.user, b.Variation.VariationID, "superseded"); err != nil {
		t.Fatalf("supersede B: %v", err)
	}

	if err := f.db.FreezeAllVariations(f.ctx, f.user, sketchID); err != nil {
		t.Fatalf("FreezeAllVariations: %v", err)
	}

	states := map[int]string{}
	rows, err := f.pool.Query(f.ctx, `SELECT ordinal, state FROM variation WHERE sketch_id = $1 AND ordinal IS NOT NULL`, sketchID)
	if err != nil {
		t.Fatalf("read states: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var ord int
		var state string
		if err := rows.Scan(&ord, &state); err != nil {
			t.Fatalf("scan: %v", err)
		}
		states[ord] = state
	}
	if states[1] != "frozen" {
		t.Errorf("draft A = %q, want frozen", states[1])
	}
	if states[2] != "superseded" {
		t.Errorf("superseded B = %q, want untouched", states[2])
	}

	if err := f.db.FreezeAllVariations(f.ctx, f.other, sketchID); !errors.Is(err, ErrNotOwner) {
		t.Errorf("other user: err = %v, want ErrNotOwner", err)
	}
}

// ---------------------------------------------------------------- #84

func TestListVariationsForPicker_Filters(t *testing.T) {
	f := newVarFixture(t)
	mID := f.newManuscript(t)

	// Sketch 1: canonized via A → canonized flag rides on every row.
	s1 := f.newSketch(t, nil)
	if err := f.db.UpdateVariationText(f.ctx, f.user, s1.Variation.VariationID, "the NEEDLE hides here"); err != nil {
		t.Fatalf("seed s1: %v", err)
	}
	if _, err := f.db.CanonizeVariation(f.ctx, f.user, s1.Variation.VariationID, mID, "Book One"); err != nil {
		t.Fatalf("canonize s1: %v", err)
	}
	// Canonize freezes nothing by itself but mints no snapshot rows either;
	// add a legacy-style canon row to prove NULL ordinals never list.
	// (idx_variation_sketch_canon allows one per sketch.)
	s2 := f.newSketch(t, nil)
	f.insertVariation(t, s2.Sketch.SketchID, nil, "hidden canon needle", "frozen")
	if err := f.db.UpdateVariationText(f.ctx, f.user, s2.Variation.VariationID, "plain draft, no match"); err != nil {
		t.Fatalf("seed s2: %v", err)
	}
	// Superseded and deleted rows never list.
	sup, err := f.db.CreateVariationFrom(f.ctx, f.user, s2.Variation.VariationID, nil)
	if err != nil {
		t.Fatalf("create sup: %v", err)
	}
	if err := f.db.UpdateVariationText(f.ctx, f.user, sup.Variation.VariationID, "superseded needle"); err != nil {
		t.Fatalf("seed sup: %v", err)
	}
	if err := f.db.SetVariationState(f.ctx, f.user, sup.Variation.VariationID, "superseded"); err != nil {
		t.Fatalf("supersede: %v", err)
	}
	del, err := f.db.CreateVariationFrom(f.ctx, f.user, s2.Variation.VariationID, nil)
	if err != nil {
		t.Fatalf("create del: %v", err)
	}
	if err := f.db.UpdateVariationText(f.ctx, f.user, del.Variation.VariationID, "deleted needle"); err != nil {
		t.Fatalf("seed del: %v", err)
	}
	if err := f.db.SoftDeleteVariation(f.ctx, f.user, del.Variation.VariationID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	all, err := f.db.ListVariationsForPicker(f.ctx, f.user, "")
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	byID := map[int]PickerVariation{}
	for _, p := range all {
		byID[p.VariationID] = p
	}
	if len(all) != 2 {
		t.Fatalf("list = %+v, want exactly [s1.A s2.A] (no canon/superseded/deleted rows)", all)
	}
	if p, ok := byID[s1.Variation.VariationID]; !ok || !p.Canonized || p.LinkedManuscriptID != mID {
		t.Errorf("s1.A row = %+v, want canonized + linked to %d", p, mID)
	}
	if p, ok := byID[s2.Variation.VariationID]; !ok || p.Canonized {
		t.Errorf("s2.A row = %+v, want not canonized", p)
	}

	// Case-insensitive contiguous substring filter.
	got, err := f.db.ListVariationsForPicker(f.ctx, f.user, "needle")
	if err != nil {
		t.Fatalf("list filtered: %v", err)
	}
	if len(got) != 1 || got[0].VariationID != s1.Variation.VariationID {
		t.Errorf("filter 'needle' = %+v, want only s1.A", got)
	}

	// Foreign users see nothing.
	foreign, err := f.db.ListVariationsForPicker(f.ctx, f.other, "")
	if err != nil {
		t.Fatalf("foreign list: %v", err)
	}
	if len(foreign) != 0 {
		t.Errorf("other user sees %d rows, want 0", len(foreign))
	}

	// LIMIT 50.
	if _, err := f.pool.Exec(f.ctx, `
		INSERT INTO sketch (sketch_id, user_id)
		SELECT 'lim' || lpad(i::text, 7, '0'), $1 FROM generate_series(1, 55) i
	`, f.user); err != nil {
		t.Fatalf("bulk sketches: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx, `
		INSERT INTO variation (sketch_id, ordinal, text)
		SELECT 'lim' || lpad(i::text, 7, '0'), 1, 'limit filler ' || i FROM generate_series(1, 55) i
	`); err != nil {
		t.Fatalf("bulk variations: %v", err)
	}
	limited, err := f.db.ListVariationsForPicker(f.ctx, f.user, "limit filler")
	if err != nil {
		t.Fatalf("list limited: %v", err)
	}
	if len(limited) != 50 {
		t.Errorf("limit = %d rows, want 50", len(limited))
	}
}

// ---------------------------------------------------------------- #85

func TestSoftDeleteRestoreListDeletedVariations(t *testing.T) {
	f := newVarFixture(t)
	a := f.newSketch(t, nil)
	aID := a.Variation.VariationID
	b, err := f.db.CreateVariationFrom(f.ctx, f.user, aID, nil)
	if err != nil {
		t.Fatalf("create B: %v", err)
	}
	bID := b.Variation.VariationID
	if err := f.db.UpdateVariationText(f.ctx, f.user, bID, "restorable text"); err != nil {
		t.Fatalf("seed B: %v", err)
	}
	if err := f.db.SetVariationState(f.ctx, f.user, bID, "frozen"); err != nil {
		t.Fatalf("freeze B: %v", err)
	}

	// The canon variation (NULL ordinal) can't be deleted.
	canonID := f.insertVariation(t, a.Sketch.SketchID, nil, "snapshot", "frozen")
	if err := f.db.SoftDeleteVariation(f.ctx, f.user, canonID); !errors.Is(err, ErrVariationCanon) {
		t.Errorf("canon delete: err = %v, want ErrVariationCanon", err)
	}

	if err := f.db.SoftDeleteVariation(f.ctx, f.user, bID); err != nil {
		t.Fatalf("delete B: %v", err)
	}
	// Idempotent.
	if err := f.db.SoftDeleteVariation(f.ctx, f.user, bID); err != nil {
		t.Errorf("second delete: %v", err)
	}
	// Push B's stamp back, then delete A too — list is newest-deleted first.
	if _, err := f.pool.Exec(f.ctx, `UPDATE variation SET deleted_at = NOW() - interval '1 hour' WHERE variation_id = $1`, bID); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	if err := f.db.SoftDeleteVariation(f.ctx, f.user, aID); err != nil {
		t.Fatalf("delete A: %v", err)
	}

	deleted, err := f.db.ListDeletedVariations(f.ctx, f.user, "")
	if err != nil {
		t.Fatalf("list deleted: %v", err)
	}
	if len(deleted) != 2 || deleted[0].VariationID != aID || deleted[1].VariationID != bID {
		t.Fatalf("deleted list = %+v, want [A B] newest-deleted first", deleted)
	}
	// Text filter.
	filtered, err := f.db.ListDeletedVariations(f.ctx, f.user, "restorable")
	if err != nil {
		t.Fatalf("filtered deleted: %v", err)
	}
	if len(filtered) != 1 || filtered[0].VariationID != bID {
		t.Errorf("filtered = %+v, want only B", filtered)
	}

	// Restore keeps the frozen state and leaves the deleted list.
	if err := f.db.RestoreVariation(f.ctx, f.user, bID); err != nil {
		t.Fatalf("restore B: %v", err)
	}
	vc, err := f.db.GetVariationContext(f.ctx, f.user, bID)
	if err != nil {
		t.Fatalf("re-read B: %v", err)
	}
	if vc.Variation.State != "frozen" {
		t.Errorf("restored B state = %q, want still frozen", vc.Variation.State)
	}
	deleted, err = f.db.ListDeletedVariations(f.ctx, f.user, "")
	if err != nil {
		t.Fatalf("relist deleted: %v", err)
	}
	if len(deleted) != 1 || deleted[0].VariationID != aID {
		t.Errorf("after restore, deleted = %+v, want only A", deleted)
	}

	if err := f.db.SoftDeleteVariation(f.ctx, f.other, bID); !errors.Is(err, ErrNotOwner) {
		t.Errorf("foreign delete: err = %v, want ErrNotOwner", err)
	}
	if err := f.db.RestoreVariation(f.ctx, f.other, aID); !errors.Is(err, ErrNotOwner) {
		t.Errorf("foreign restore: err = %v, want ErrNotOwner", err)
	}
}

// ---------------------------------------------------------------- #86

func TestLinkSketch_ClearAndCanonizedRefusal(t *testing.T) {
	f := newVarFixture(t)
	mID := f.newManuscript(t)
	a := f.newSketch(t, nil)
	sketchID := a.Sketch.SketchID

	if err := f.db.LinkSketch(f.ctx, f.user, sketchID, mID, "Book One"); err != nil {
		t.Fatalf("link: %v", err)
	}
	vc, err := f.db.GetVariationContext(f.ctx, f.user, a.Variation.VariationID)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if vc.Sketch.LinkedManuscriptID != mID || vc.Sketch.LinkedManuscriptName != "Book One" {
		t.Errorf("link = %d/%q, want %d/Book One", vc.Sketch.LinkedManuscriptID, vc.Sketch.LinkedManuscriptName, mID)
	}

	// 0 clears.
	if err := f.db.LinkSketch(f.ctx, f.user, sketchID, 0, ""); err != nil {
		t.Fatalf("clear link: %v", err)
	}
	vc, err = f.db.GetVariationContext(f.ctx, f.user, a.Variation.VariationID)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if vc.Sketch.LinkedManuscriptID != 0 || vc.Sketch.LinkedManuscriptName != "" {
		t.Errorf("after clear: %d/%q, want 0/\"\"", vc.Sketch.LinkedManuscriptID, vc.Sketch.LinkedManuscriptName)
	}

	// Canonized pins the link permanently.
	if _, err := f.db.CanonizeVariation(f.ctx, f.user, a.Variation.VariationID, mID, "Book One"); err != nil {
		t.Fatalf("canonize: %v", err)
	}
	if err := f.db.LinkSketch(f.ctx, f.user, sketchID, 0, ""); !errors.Is(err, ErrSketchCanonized) {
		t.Errorf("relink canonized: err = %v, want ErrSketchCanonized", err)
	}

	if err := f.db.LinkSketch(f.ctx, f.other, sketchID, mID, "x"); !errors.Is(err, ErrNotOwner) {
		t.Errorf("foreign link: err = %v, want ErrNotOwner", err)
	}
}

// ---------------------------------------------------------------- #87

func TestCanonizeVariation_RepointAndLegacyDrop(t *testing.T) {
	f := newVarFixture(t)
	mID := f.newManuscript(t)
	a := f.newSketch(t, nil)
	aID := a.Variation.VariationID
	sketchID := a.Sketch.SketchID
	b, err := f.db.CreateVariationFrom(f.ctx, f.user, aID, nil)
	if err != nil {
		t.Fatalf("create B: %v", err)
	}
	bID := b.Variation.VariationID

	// Seed a legacy hidden snapshot (ordinal NULL) as the current canon.
	legacyID := f.insertVariation(t, sketchID, nil, "old snapshot copy", "frozen")
	if _, err := f.pool.Exec(f.ctx, `
		UPDATE sketch SET canon_variation_id = $2, linked_manuscript_id = $3, linked_manuscript_name = 'Book One'
		WHERE sketch_id = $1
	`, sketchID, legacyID, mID); err != nil {
		t.Fatalf("seed legacy canon: %v", err)
	}

	// Canonize A: pointer → A, placed-from → A, legacy snapshot dropped.
	vc, err := f.db.CanonizeVariation(f.ctx, f.user, aID, mID, "Book One")
	if err != nil {
		t.Fatalf("canonize A: %v", err)
	}
	if vc.Sketch.CanonVariationID != aID || vc.Sketch.PlacedFromVariationID != aID {
		t.Errorf("after canonize: %+v, want canon/placed-from = A(%d)", vc.Sketch, aID)
	}
	var legacyLeft int
	if err := f.pool.QueryRow(f.ctx, `SELECT COUNT(*) FROM variation WHERE variation_id = $1`, legacyID).Scan(&legacyLeft); err != nil {
		t.Fatalf("count legacy: %v", err)
	}
	if legacyLeft != 0 {
		t.Errorf("legacy NULL-ordinal snapshot survived re-canonize")
	}

	// Re-canonize with B just repoints; A (lettered) is NOT deleted.
	vc, err = f.db.CanonizeVariation(f.ctx, f.user, bID, mID, "Book One")
	if err != nil {
		t.Fatalf("re-canonize B: %v", err)
	}
	if vc.Sketch.CanonVariationID != bID || vc.Sketch.PlacedFromVariationID != bID {
		t.Errorf("after re-canonize: %+v, want canon/placed-from = B(%d)", vc.Sketch, bID)
	}
	if _, err := f.db.GetVariationContext(f.ctx, f.user, aID); err != nil {
		t.Errorf("A should survive being replaced as canon: %v", err)
	}

	// Linked-elsewhere refusal.
	m2 := f.newManuscript(t)
	s2 := f.newSketch(t, nil)
	if err := f.db.LinkSketch(f.ctx, f.user, s2.Sketch.SketchID, mID, "Book One"); err != nil {
		t.Fatalf("link s2: %v", err)
	}
	if _, err := f.db.CanonizeVariation(f.ctx, f.user, s2.Variation.VariationID, m2, "Book Two"); !errors.Is(err, ErrLinkedElsewhere) {
		t.Errorf("cross-manuscript canonize: err = %v, want ErrLinkedElsewhere", err)
	}

	// Canonizing a NULL-ordinal row is refused.
	canonID := f.insertVariation(t, s2.Sketch.SketchID, nil, "snap", "frozen")
	if _, err := f.db.CanonizeVariation(f.ctx, f.user, canonID, mID, "Book One"); !errors.Is(err, ErrVariationCanon) {
		t.Errorf("canonize canon row: err = %v, want ErrVariationCanon", err)
	}

	if _, err := f.db.CanonizeVariation(f.ctx, f.other, bID, mID, "Book One"); !errors.Is(err, ErrNotOwner) {
		t.Errorf("foreign canonize: err = %v, want ErrNotOwner", err)
	}
}

// ---------------------------------------------------------------- #88

func TestCreateVariationFromText_SeededNextLetter(t *testing.T) {
	f := newVarFixture(t)
	a := f.newSketch(t, nil)
	sketchID := a.Sketch.SketchID
	padID := f.newPad(t, "seed home")

	vc, err := f.db.CreateVariationFromText(f.ctx, f.user, sketchID, "seeded from the book", &padID)
	if err != nil {
		t.Fatalf("CreateVariationFromText: %v", err)
	}
	if vc.Variation.Ordinal == nil || *vc.Variation.Ordinal != 2 {
		t.Errorf("ordinal = %v, want 2", vc.Variation.Ordinal)
	}
	if vc.Variation.Text != "seeded from the book" {
		t.Errorf("text = %q, want the seed", vc.Variation.Text)
	}
	if vc.Variation.ScratchpadID == nil || *vc.Variation.ScratchpadID != padID {
		t.Errorf("home = %v, want %d", vc.Variation.ScratchpadID, padID)
	}

	// Cap.
	capSketch := f.newSketch(t, nil)
	f.insertVariation(t, capSketch.Sketch.SketchID, intPtr(MaxVariationOrdinal), "z", "draft")
	if _, err := f.db.CreateVariationFromText(f.ctx, f.user, capSketch.Sketch.SketchID, "x", nil); !errors.Is(err, ErrOrdinalCap) {
		t.Errorf("cap: err = %v, want ErrOrdinalCap", err)
	}

	if _, err := f.db.CreateVariationFromText(f.ctx, f.other, sketchID, "x", nil); !errors.Is(err, ErrNotOwner) {
		t.Errorf("foreign: err = %v, want ErrNotOwner", err)
	}
}

// ---------------------------------------------------------------- #89

func TestCountCanonizedAmong_EmptyFastPath(t *testing.T) {
	f := newVarFixture(t)

	n, err := f.db.CountCanonizedAmong(f.ctx, nil)
	if err != nil || n != 0 {
		t.Errorf("empty: (%d, %v), want (0, nil)", n, err)
	}

	mID := f.newManuscript(t)
	placed := f.newSketch(t, nil)
	if _, err := f.db.CanonizeVariation(f.ctx, f.user, placed.Variation.VariationID, mID, "Book"); err != nil {
		t.Fatalf("canonize: %v", err)
	}
	// A sibling of the canonized group also counts — membership is by group.
	sib, err := f.db.CreateVariationFrom(f.ctx, f.user, placed.Variation.VariationID, nil)
	if err != nil {
		t.Fatalf("create sibling: %v", err)
	}
	loose := f.newSketch(t, nil)

	n, err = f.db.CountCanonizedAmong(f.ctx, []int{sib.Variation.VariationID, loose.Variation.VariationID})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Errorf("count = %d, want 1 (sibling of canonized group only)", n)
	}
}

// ---------------------------------------------------------------- #90

func TestVariationHomeScratchpad_And_SketchHome(t *testing.T) {
	f := newVarFixture(t)
	mID := f.newManuscript(t)
	pad1 := f.newPad(t, "pad one")
	pad2 := f.newPad(t, "pad two")

	a := f.newSketch(t, &pad1)
	aID := a.Variation.VariationID
	sketchID := a.Sketch.SketchID
	b, err := f.db.CreateVariationFrom(f.ctx, f.user, aID, &pad2)
	if err != nil {
		t.Fatalf("create B: %v", err)
	}
	bID := b.Variation.VariationID

	// VariationHomeScratchpad: the variation's own home; 0 when homeless.
	got, err := f.db.VariationHomeScratchpad(f.ctx, f.user, aID)
	if err != nil || got != pad1 {
		t.Errorf("A home = (%d, %v), want (%d, nil)", got, err, pad1)
	}
	homeless, err := f.db.CreateVariationFrom(f.ctx, f.user, aID, nil)
	if err != nil {
		t.Fatalf("create homeless C: %v", err)
	}
	got, err = f.db.VariationHomeScratchpad(f.ctx, f.user, homeless.Variation.VariationID)
	if err != nil || got != 0 {
		t.Errorf("homeless home = (%d, %v), want (0, nil)", got, err)
	}
	if _, err := f.db.VariationHomeScratchpad(f.ctx, f.other, aID); !errors.Is(err, ErrNotOwner) {
		t.Errorf("foreign: err = %v, want ErrNotOwner", err)
	}

	// SketchHome without a placement: lowest letter that has a pad.
	spid, ord, err := f.db.SketchHome(f.ctx, f.user, sketchID)
	if err != nil || spid != pad1 || ord != 1 {
		t.Errorf("no placement: (%d, %d, %v), want (%d, 1, nil)", spid, ord, err, pad1)
	}

	// Placed-from wins over the lowest letter.
	if _, err := f.db.CanonizeVariation(f.ctx, f.user, bID, mID, "Book"); err != nil {
		t.Fatalf("canonize B: %v", err)
	}
	spid, ord, err = f.db.SketchHome(f.ctx, f.user, sketchID)
	if err != nil || spid != pad2 || ord != 2 {
		t.Errorf("placed-from: (%d, %d, %v), want (%d, 2, nil)", spid, ord, err, pad2)
	}

	// A sketch with no homed variations resolves to (0, 0).
	bare := f.newSketch(t, nil)
	spid, ord, err = f.db.SketchHome(f.ctx, f.user, bare.Sketch.SketchID)
	if err != nil || spid != 0 || ord != 0 {
		t.Errorf("bare sketch: (%d, %d, %v), want (0, 0, nil)", spid, ord, err)
	}

	if _, _, err := f.db.SketchHome(f.ctx, f.other, sketchID); !errors.Is(err, ErrNotOwner) {
		t.Errorf("foreign SketchHome: err = %v, want ErrNotOwner", err)
	}
}

// ---------------------------------------------------------------- #91

func TestCreatePlacedSketchFromSelection_FullStroke(t *testing.T) {
	f := newVarFixture(t)
	mID := f.newManuscript(t)
	padID := f.newPad(t, "workbench")

	vc, err := f.db.CreatePlacedSketchFromSelection(f.ctx, f.user, mID, "Book One", "the selected passage", padID)
	if err != nil {
		t.Fatalf("CreatePlacedSketchFromSelection: %v", err)
	}
	aID := vc.Variation.VariationID

	// A = the frozen as-placed baseline; canon = placed-from = A; linked.
	if vc.Variation.Ordinal == nil || *vc.Variation.Ordinal != 1 {
		t.Errorf("ordinal = %v, want 1", vc.Variation.Ordinal)
	}
	if vc.Variation.State != "frozen" {
		t.Errorf("state = %q, want frozen (the as-placed baseline)", vc.Variation.State)
	}
	if vc.Variation.Text != "the selected passage" {
		t.Errorf("text = %q, want the selection", vc.Variation.Text)
	}
	if vc.Sketch.CanonVariationID != aID || vc.Sketch.PlacedFromVariationID != aID {
		t.Errorf("sketch = %+v, want canon = placed-from = A(%d)", vc.Sketch, aID)
	}
	if vc.Sketch.LinkedManuscriptID != mID || vc.Sketch.LinkedManuscriptName != "Book One" {
		t.Errorf("link = %d/%q, want %d/Book One", vc.Sketch.LinkedManuscriptID, vc.Sketch.LinkedManuscriptName, mID)
	}
	if vc.Note == nil {
		t.Error("placed sketch should carry its note from birth")
	}

	// Exactly ONE widget node appended to the pad doc, after the seed content.
	countWidgets := func(padID int) (total int, widgetIDs []int64, lastIsWidget bool) {
		t.Helper()
		var docJSON []byte
		if err := f.pool.QueryRow(f.ctx, `SELECT doc FROM scratchpad WHERE scratchpad_id = $1`, padID).Scan(&docJSON); err != nil {
			t.Fatalf("read pad doc: %v", err)
		}
		var doc struct {
			Type    string `json:"type"`
			Content []struct {
				Type  string `json:"type"`
				Attrs struct {
					VariationID int64 `json:"variationId"`
				} `json:"attrs"`
			} `json:"content"`
		}
		if err := json.Unmarshal(docJSON, &doc); err != nil {
			t.Fatalf("parse pad doc: %v", err)
		}
		if doc.Type != "doc" {
			t.Fatalf("pad doc type = %q, want doc", doc.Type)
		}
		for i, n := range doc.Content {
			if n.Type == "snippet" {
				widgetIDs = append(widgetIDs, n.Attrs.VariationID)
				lastIsWidget = i == len(doc.Content)-1
			}
		}
		return len(doc.Content), widgetIDs, lastIsWidget
	}
	total, widgets, lastIsWidget := countWidgets(padID)
	if len(widgets) != 1 || widgets[0] != int64(aID) {
		t.Errorf("pad widgets = %v, want exactly one for A(%d)", widgets, aID)
	}
	if total != 2 || !lastIsWidget {
		t.Errorf("pad doc: %d nodes, widget last = %v; want the seed paragraph + appended widget", total, lastIsWidget)
	}

	// Malformed pad doc is replaced with a fresh skeleton holding the widget.
	badPad := f.newPad(t, "corrupted")
	if _, err := f.pool.Exec(f.ctx, `UPDATE scratchpad SET doc = '"garbage"'::jsonb WHERE scratchpad_id = $1`, badPad); err != nil {
		t.Fatalf("corrupt pad: %v", err)
	}
	vc2, err := f.db.CreatePlacedSketchFromSelection(f.ctx, f.user, mID, "Book One", "other passage", badPad)
	if err != nil {
		t.Fatalf("place into corrupted pad: %v", err)
	}
	total, widgets, _ = countWidgets(badPad)
	if total != 1 || len(widgets) != 1 || widgets[0] != int64(vc2.Variation.VariationID) {
		t.Errorf("corrupted pad rebuilt as %d nodes, widgets %v; want a fresh doc with just the widget", total, widgets)
	}

	// A pad you don't own reads as not-found, and nothing is created.
	if _, err := f.db.CreatePlacedSketchFromSelection(f.ctx, f.other, mID, "Book One", "steal", padID); !errors.Is(err, ErrNotOwner) {
		t.Errorf("foreign pad: err = %v, want ErrNotOwner", err)
	}
	var foreignSketches int
	if err := f.pool.QueryRow(f.ctx, `SELECT COUNT(*) FROM sketch WHERE user_id = $1`, f.other).Scan(&foreignSketches); err != nil {
		t.Fatalf("count: %v", err)
	}
	if foreignSketches != 0 {
		t.Errorf("refused placement still created %d sketch(es)", foreignSketches)
	}
}

// ---------------------------------------------------------------- #92 ⚠

// variations.go collapses every error from its owner-check scans into
// ErrNotOwner (`if err != nil || owner != userID`), so a dropped connection
// or canceled query reads as 404 "Not found" with zero logging. Intended
// semantics: only "no such row" and "wrong owner" map to ErrNotOwner;
// genuine DB failures must surface as themselves (→ 500, logged).
func TestVariations_DBErrorsNotMaskedAsNotOwner(t *testing.T) {
	t.Skip("PENDING-FIX: owner-check error collapse (variations.go, ~12 sites: `if err != nil || owner != userID { return ErrNotOwner }`) turns real DB failures into 404s; distinguish pgx.ErrNoRows/wrong-owner from other errors — enable after fix")

	f := newVarFixture(t)
	a := f.newSketch(t, nil)
	aID := a.Variation.VariationID

	canceled, cancel := context.WithCancel(f.ctx)
	cancel()

	if _, err := f.db.GetVariationContext(canceled, f.user, aID); err == nil || errors.Is(err, ErrNotOwner) {
		t.Errorf("GetVariationContext with dead ctx: err = %v, want a real error, not ErrNotOwner", err)
	}
	if err := f.db.UpdateVariationText(canceled, f.user, aID, "x"); err == nil || errors.Is(err, ErrNotOwner) {
		t.Errorf("UpdateVariationText with dead ctx: err = %v, want a real error, not ErrNotOwner", err)
	}
	if err := f.db.SoftDeleteVariation(canceled, f.user, aID); err == nil || errors.Is(err, ErrNotOwner) {
		t.Errorf("SoftDeleteVariation with dead ctx: err = %v, want a real error, not ErrNotOwner", err)
	}
}
