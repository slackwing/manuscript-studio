package migrations

// Integration tests for Processor.Run against real Postgres.
//
// Motivation: the Playwright e2e suite only exercises bootstrap — the
// annotation-repointing migrate path once shipped as `_ = newVersion` and
// nothing caught it.
//
// Connects to localhost:5433 by default; override via MANUSCRIPT_STUDIO_TEST_DB_URL.
// Tests skip (not fail) when no DB is reachable. Each test gets a unique
// manuscript; cleanup runs on entry (not exit) so failure leftovers remain
// inspectable.

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/models"
)

const defaultTestDBURL = "postgres://manuscript_dev:manuscript_dev@localhost:5433/manuscript_studio_dev"

// Atomic so each parallel subtest gets a unique manuscript id.
var testCounter int64

// connectTestDB returns a pool or skips the test if no DB is reachable.
func connectTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("MANUSCRIPT_STUDIO_TEST_DB_URL")
	if url == "" {
		url = defaultTestDBURL
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

// uniqueManuscript creates a fresh row with a URL that won't collide with
// the e2e suite's `test-manuscripts` data. Cleanup is the caller's job.
func uniqueManuscript(t *testing.T, ctx context.Context, db *database.DB) (manuscriptID int, repoURL, filePath string) {
	t.Helper()
	n := atomic.AddInt64(&testCounter, 1)
	repoURL = fmt.Sprintf("test://migrations-integration/%d-%d", time.Now().UnixNano(), n)
	filePath = "manuscript.md"

	m, err := db.CreateManuscript(ctx, repoURL, filePath)
	if err != nil {
		t.Fatalf("CreateManuscript: %v", err)
	}
	return m.ManuscriptID, repoURL, filePath
}

// nukeManuscript wipes everything tied to manuscriptID. Run at start so a
// prior crash doesn't poison the next run.
func nukeManuscript(t *testing.T, ctx context.Context, pool *pgxpool.Pool, manuscriptID int) {
	t.Helper()
	stmts := []string{
		`DELETE FROM annotation_tag WHERE annotation_id IN (
			SELECT annotation_id FROM annotation WHERE sentence_id IN (
				SELECT sentence_id FROM sentence WHERE migration_id IN (
					SELECT migration_id FROM migration WHERE manuscript_id = $1)))`,
		`DELETE FROM annotation_version WHERE annotation_id IN (
			SELECT annotation_id FROM annotation WHERE sentence_id IN (
				SELECT sentence_id FROM sentence WHERE migration_id IN (
					SELECT migration_id FROM migration WHERE manuscript_id = $1)))`,
		`DELETE FROM annotation WHERE sentence_id IN (
			SELECT sentence_id FROM sentence WHERE migration_id IN (
				SELECT migration_id FROM migration WHERE manuscript_id = $1))`,
		`DELETE FROM tag WHERE migration_id IN (
			SELECT migration_id FROM migration WHERE manuscript_id = $1)`,
		`DELETE FROM sentence WHERE migration_id IN (
			SELECT migration_id FROM migration WHERE manuscript_id = $1)`,
		`DELETE FROM migration WHERE manuscript_id = $1`,
		`DELETE FROM manuscript WHERE manuscript_id = $1`,
	}
	for _, sql := range stmts {
		if _, err := pool.Exec(ctx, sql, manuscriptID); err != nil {
			t.Fatalf("nuke %q: %v", sql[:30], err)
		}
	}
}

// The annotation table FKs to user.username, so every test annotation needs a user.
func ensureUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, username string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO "user" (username, password_hash, role)
		VALUES ($1, '$2a$10$dummy', 'author')
		ON CONFLICT (username) DO NOTHING
	`, username)
	if err != nil {
		t.Fatalf("ensureUser: %v", err)
	}
}

// Same path as the HTTP handler: insert pending row, then Processor.Run.
func runProcessor(t *testing.T, ctx context.Context, p *Processor, db *database.DB, manuscriptID int, commitHash, content string) int {
	t.Helper()
	id, err := db.CreatePendingMigration(ctx, manuscriptID, commitHash, p.SegmenterVersion())
	if err != nil {
		t.Fatalf("CreatePendingMigration: %v", err)
	}
	if _, err := p.Run(ctx, slog.Default(), id, manuscriptID, commitHash, "main", content); err != nil {
		t.Fatalf("Processor.Run: %v", err)
	}
	return id
}

// Creates an annotation + its version row via the same DB helper the API uses.
func insertAnnotation(t *testing.T, ctx context.Context, db *database.DB, sentenceID, username, note string) int {
	t.Helper()
	a := &models.Annotation{
		SentenceID: sentenceID,
		UserID:     username,
		Color:      "yellow",
		Note:       &note,
		Priority:   "none",
		Flagged:    false,
	}
	v := &models.AnnotationVersion{
		SentenceID: sentenceID,
		Color:      "yellow",
		Note:       &note,
		Priority:   "none",
		Flagged:    false,
		CreatedBy:  username,
	}
	if err := db.CreateAnnotation(ctx, a, v); err != nil {
		t.Fatalf("CreateAnnotation: %v", err)
	}
	return a.AnnotationID
}

func getAnnotationSentenceID(t *testing.T, ctx context.Context, pool *pgxpool.Pool, annotationID int) string {
	t.Helper()
	var sid string
	if err := pool.QueryRow(ctx, `SELECT sentence_id FROM annotation WHERE annotation_id = $1`, annotationID).Scan(&sid); err != nil {
		t.Fatalf("read annotation: %v", err)
	}
	return sid
}

func getLatestVersion(t *testing.T, ctx context.Context, pool *pgxpool.Pool, annotationID int) (version int, sentenceID string, confidence *float64) {
	t.Helper()
	if err := pool.QueryRow(ctx, `
		SELECT version, sentence_id, migration_confidence
		FROM annotation_version
		WHERE annotation_id = $1
		ORDER BY version DESC
		LIMIT 1
	`, annotationID).Scan(&version, &sentenceID, &confidence); err != nil {
		t.Fatalf("read latest version: %v", err)
	}
	return
}

// Returns the first sentence_id under migrationID whose text starts with prefix,
// so tests don't have to recompute the deterministic sentence-id hash by hand.
func findSentenceIDByPrefix(t *testing.T, ctx context.Context, pool *pgxpool.Pool, migrationID int, prefix string) string {
	t.Helper()
	var sid string
	err := pool.QueryRow(ctx, `
		SELECT sentence_id FROM sentence
		WHERE migration_id = $1 AND text LIKE $2
		ORDER BY ordinal LIMIT 1
	`, migrationID, prefix+"%").Scan(&sid)
	if err != nil {
		t.Fatalf("find sentence by prefix %q: %v", prefix, err)
	}
	return sid
}

type fixture struct {
	pool         *pgxpool.Pool
	db           *database.DB
	processor    *Processor
	manuscriptID int
	username     string
	ctx          context.Context
}

func newFixture(t *testing.T) *fixture {
	pool := connectTestDB(t)
	db := &database.DB{Pool: pool}
	ctx := context.Background()

	mID, _, _ := uniqueManuscript(t, ctx, db)
	username := fmt.Sprintf("test-user-%d", time.Now().UnixNano())
	ensureUser(t, ctx, pool, username)

	t.Cleanup(func() {
		nukeManuscript(t, ctx, pool, mID)
		_, _ = pool.Exec(ctx, `DELETE FROM "user" WHERE username = $1`, username)
		pool.Close()
	})

	return &fixture{
		pool:         pool,
		db:           db,
		processor:    NewProcessor(pool),
		manuscriptID: mID,
		username:     username,
		ctx:          ctx,
	}
}

// Bootstrap, then re-run with byte-identical content but a different commit
// hash. Sentence ids change (hash includes commit); annotations must follow.
func TestMigration_BootstrapThenNoOp(t *testing.T) {
	f := newFixture(t)
	content := "Sentence one is here. Sentence two follows. Sentence three is last."

	mID1 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "commitA", content)

	s2 := findSentenceIDByPrefix(t, f.ctx, f.pool, mID1, "Sentence two")
	annID := insertAnnotation(t, f.ctx, f.db, s2, f.username, "this one")

	mID2 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "commitB", content)
	s2New := findSentenceIDByPrefix(t, f.ctx, f.pool, mID2, "Sentence two")

	if s2New == s2 {
		t.Fatal("expected new sentence id (different commit), got same")
	}
	got := getAnnotationSentenceID(t, f.ctx, f.pool, annID)
	if got != s2New {
		t.Fatalf("annotation should now point to new sentence id %s, got %s", s2New, got)
	}

	v, sidV, conf := getLatestVersion(t, f.ctx, f.pool, annID)
	if v < 2 {
		t.Errorf("expected at least version 2, got %d", v)
	}
	if sidV != s2New {
		t.Errorf("latest version sentence_id = %s, want %s", sidV, s2New)
	}
	if conf == nil || *conf < 0.99 {
		t.Errorf("identical text should yield confidence ~1.0, got %v", conf)
	}
}

// A one-word edit should match with high similarity and carry the annotation.
func TestMigration_SentenceEdited(t *testing.T) {
	f := newFixture(t)
	v1 := "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. The five boxing wizards jump quickly."
	v2 := "The quick brown fox jumps over the sleepy dog. Pack my box with five dozen liquor jugs. The five boxing wizards jump quickly."

	mID1 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "v1", v1)
	target := findSentenceIDByPrefix(t, f.ctx, f.pool, mID1, "The quick brown fox")
	annID := insertAnnotation(t, f.ctx, f.db, target, f.username, "fox sentence")

	mID2 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "v2", v2)
	newTarget := findSentenceIDByPrefix(t, f.ctx, f.pool, mID2, "The quick brown fox")

	if newTarget == target {
		t.Fatal("text changed, sentence id should have changed too")
	}
	got := getAnnotationSentenceID(t, f.ctx, f.pool, annID)
	if got != newTarget {
		t.Fatalf("annotation didn't follow the edit: pointing at %s, want %s", got, newTarget)
	}
	_, _, conf := getLatestVersion(t, f.ctx, f.pool, annID)
	if conf == nil {
		t.Fatal("expected non-nil confidence on migrated version")
	}
	// ~1 of 9 words changed → similarity ≈ 0.88.
	if *conf < 0.7 {
		t.Errorf("expected high similarity for one-word edit, got %v", *conf)
	}
}

// Deleted sentence, no fuzzy match → annotation falls forward to the next
// surviving sentence, never orphans.
func TestMigration_SentenceDeleted_FallsForward(t *testing.T) {
	f := newFixture(t)
	v1 := "First sentence stays. The doomed sentence vanishes utterly. Last sentence stays."
	v2 := "First sentence stays. Last sentence stays."

	mID1 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "before-delete", v1)
	doomed := findSentenceIDByPrefix(t, f.ctx, f.pool, mID1, "The doomed")
	annID := insertAnnotation(t, f.ctx, f.db, doomed, f.username, "annotation on doomed")

	mID2 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "after-delete", v2)
	wantNext := findSentenceIDByPrefix(t, f.ctx, f.pool, mID2, "Last sentence")

	got := getAnnotationSentenceID(t, f.ctx, f.pool, annID)
	if got == doomed {
		t.Fatalf("annotation orphaned at deleted sentence %s", doomed)
	}
	if got != wantNext {
		t.Fatalf("expected fallback to following sentence %s, got %s", wantNext, got)
	}
}

// Tail deletion has no forward anchor, so the annotation falls backward to
// the previous surviving sentence.
func TestMigration_LastSentenceDeleted_FallsBackward(t *testing.T) {
	f := newFixture(t)
	v1 := "Anchor sentence stays. The trailing sentence is doomed."
	v2 := "Anchor sentence stays."

	mID1 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "v1-trailing", v1)
	doomed := findSentenceIDByPrefix(t, f.ctx, f.pool, mID1, "The trailing")
	annID := insertAnnotation(t, f.ctx, f.db, doomed, f.username, "trailing note")

	mID2 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "v2-trailing", v2)
	wantPrev := findSentenceIDByPrefix(t, f.ctx, f.pool, mID2, "Anchor sentence")

	got := getAnnotationSentenceID(t, f.ctx, f.pool, annID)
	if got != wantPrev {
		t.Fatalf("expected fallback to previous surviving sentence %s, got %s", wantPrev, got)
	}
}

// A split sentence should carry the annotation onto whichever half matches best.
func TestMigration_SentenceSplit(t *testing.T) {
	f := newFixture(t)
	v1 := "Anchor at the start. The protagonist walked into the dim hallway and considered the strange door before her. Anchor at the end."
	v2 := "Anchor at the start. The protagonist walked into the dim hallway. She considered the strange door before her. Anchor at the end."

	mID1 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "pre-split", v1)
	original := findSentenceIDByPrefix(t, f.ctx, f.pool, mID1, "The protagonist")
	annID := insertAnnotation(t, f.ctx, f.db, original, f.username, "split me")

	mID2 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "post-split", v2)
	half1 := findSentenceIDByPrefix(t, f.ctx, f.pool, mID2, "The protagonist")
	half2 := findSentenceIDByPrefix(t, f.ctx, f.pool, mID2, "She considered")

	got := getAnnotationSentenceID(t, f.ctx, f.pool, annID)
	if got != half1 && got != half2 {
		t.Fatalf("annotation should land on one half of the split (%s or %s), got %s", half1, half2, got)
	}
	// half1 shares the leading clause verbatim, so it's the expected winner.
	if got != half1 {
		t.Logf("note: split annotation landed on second half (%s) rather than first (%s)", half2, half1)
	}
}

// Two merged sentences: both annotations land on the merged result.
func TestMigration_SentencesMerged(t *testing.T) {
	f := newFixture(t)
	v1 := "Anchor at the start. The dog barked loudly. The cat hissed back. Anchor at the end."
	v2 := "Anchor at the start. The dog barked loudly and the cat hissed back. Anchor at the end."

	mID1 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "pre-merge", v1)
	dog := findSentenceIDByPrefix(t, f.ctx, f.pool, mID1, "The dog")
	cat := findSentenceIDByPrefix(t, f.ctx, f.pool, mID1, "The cat")
	annDog := insertAnnotation(t, f.ctx, f.db, dog, f.username, "dog note")
	annCat := insertAnnotation(t, f.ctx, f.db, cat, f.username, "cat note")

	mID2 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "post-merge", v2)
	merged := findSentenceIDByPrefix(t, f.ctx, f.pool, mID2, "The dog barked loudly and")

	gotDog := getAnnotationSentenceID(t, f.ctx, f.pool, annDog)
	gotCat := getAnnotationSentenceID(t, f.ctx, f.pool, annCat)
	if gotDog != merged {
		t.Errorf("dog annotation should land on merged sentence %s, got %s", merged, gotDog)
	}
	if gotCat != merged {
		t.Errorf("cat annotation should land on merged sentence %s, got %s", merged, gotCat)
	}
}

// Load-bearing check that the matcher uses normalized text (not position):
// prepending a sentence shouldn't break annotations on later ones.
func TestMigration_PrefixSentenceAdded(t *testing.T) {
	f := newFixture(t)
	v1 := "Body sentence one stays. Body sentence two stays. Body sentence three stays."
	v2 := "Brand new prepended sentence here. Body sentence one stays. Body sentence two stays. Body sentence three stays."

	mID1 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "pre-prepend", v1)
	target := findSentenceIDByPrefix(t, f.ctx, f.pool, mID1, "Body sentence two")
	annID := insertAnnotation(t, f.ctx, f.db, target, f.username, "stable")

	mID2 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "post-prepend", v2)
	newTarget := findSentenceIDByPrefix(t, f.ctx, f.pool, mID2, "Body sentence two")

	got := getAnnotationSentenceID(t, f.ctx, f.pool, annID)
	if got != newTarget {
		t.Fatalf("positional shift broke annotation: pointing at %s, want %s", got, newTarget)
	}
}

// Weaker stand-in for atomicity: bootstrap with N annotations, then edit every
// sentence. On success, every annotation must have moved.
func TestMigration_AllAnnotationsMoveTogether(t *testing.T) {
	f := newFixture(t)
	v1 := "Alpha sentence here. Bravo sentence here. Charlie sentence here. Delta sentence here. Echo sentence here."
	v2 := "Alpha line here. Bravo line here. Charlie line here. Delta line here. Echo line here."

	mID1 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "before-bulk", v1)

	prefixes := []string{"Alpha", "Bravo", "Charlie", "Delta", "Echo"}
	annIDs := make([]int, len(prefixes))
	for i, p := range prefixes {
		sid := findSentenceIDByPrefix(t, f.ctx, f.pool, mID1, p)
		annIDs[i] = insertAnnotation(t, f.ctx, f.db, sid, f.username, p+" note")
	}

	mID2 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "after-bulk", v2)

	for i, p := range prefixes {
		want := findSentenceIDByPrefix(t, f.ctx, f.pool, mID2, p)
		got := getAnnotationSentenceID(t, f.ctx, f.pool, annIDs[i])
		if got != want {
			t.Errorf("annotation %d (%s): got sentence %s, want %s", annIDs[i], p, got, want)
		}
	}
}

// Reusing a commit hash must trip the unique constraint as ErrMigrationInProgress,
// leaving the existing row untouched.
func TestMigration_DuplicateCommitConflicts(t *testing.T) {
	f := newFixture(t)
	content := "One sentence. Two sentence."

	runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "samehash", content)

	_, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "samehash", f.processor.SegmenterVersion())
	if err == nil {
		t.Fatal("expected ErrMigrationInProgress on duplicate insert, got nil")
	}
	if !strings.Contains(err.Error(), "already") && err != database.ErrMigrationInProgress {
		t.Errorf("expected dup-error wrapping ErrMigrationInProgress, got: %v", err)
	}
}
