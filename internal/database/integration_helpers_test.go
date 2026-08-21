package database

// Shared fixture plumbing for the dev-DB integration tests in this package
// (CODE_REVIEW_AUG_2026.md AREA 2, §2.4 rows #1–#74).
//
// Follows internal/migrations/processor_integration_test.go: connects to the
// DEV fixture Postgres at localhost:5433 (override via
// MANUSCRIPT_STUDIO_TEST_DB_URL) and SKIPS — never fails — when unreachable.
// Every test gets its own manuscript + user with unique names; nothing here
// touches the e2e suite's shared fixtures (manuscript_id=1 / user 'test').
// Cleanup runs via t.Cleanup.

import (
	"context"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/slackwing/manuscript-studio/internal/models"
)

const itDefaultDBURL = "postgres://manuscript_dev:manuscript_dev@localhost:5433/manuscript_studio_dev"

// Atomic counter so every fixture object in the run gets a unique name.
var itCounter int64

func itNext() int64 { return atomic.AddInt64(&itCounter, 1) }

// connectITDB returns a pool or skips the test if no DB is reachable.
func connectITDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("MANUSCRIPT_STUDIO_TEST_DB_URL")
	if url == "" {
		url = itDefaultDBURL
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

type itFixture struct {
	pool *pgxpool.Pool
	db   *DB
	ctx  context.Context

	manuscriptID int
	repoPath     string
	username     string

	// Extra rows registered for cleanup.
	extraManuscripts []int
	extraUsers       []string
	taskTypeNames    []string
}

func newITFixture(t *testing.T) *itFixture {
	t.Helper()
	pool := connectITDB(t)
	db := &DB{Pool: pool}
	ctx := context.Background()

	f := &itFixture{pool: pool, db: db, ctx: ctx}
	f.repoPath = fmt.Sprintf("test://database-integration/%d-%d", time.Now().UnixNano(), itNext())
	m, err := db.CreateManuscript(ctx, f.repoPath, "manuscript.md")
	if err != nil {
		t.Fatalf("CreateManuscript: %v", err)
	}
	f.manuscriptID = m.ManuscriptID
	f.username = f.newUser(t)

	t.Cleanup(func() {
		f.nuke(t)
		pool.Close()
	})
	return f
}

// newUser inserts a fresh uniquely-named user and registers it for cleanup.
func (f *itFixture) newUser(t *testing.T) string {
	t.Helper()
	// note_version.created_by is varchar(50); keep the name short.
	name := fmt.Sprintf("t-dbit-%d-%d", time.Now().UnixNano()%1e12, itNext())
	if _, err := f.pool.Exec(f.ctx, `
		INSERT INTO "user" (username, password_hash, role)
		VALUES ($1, '$2a$10$dummy', 'author')
		ON CONFLICT (username) DO NOTHING
	`, name); err != nil {
		t.Fatalf("insert user %s: %v", name, err)
	}
	f.extraUsers = append(f.extraUsers, name)
	return name
}

// newManuscript creates an additional manuscript and registers it for cleanup.
func (f *itFixture) newManuscript(t *testing.T, repoPath string) *models.Manuscript {
	t.Helper()
	m, err := f.db.CreateManuscript(f.ctx, repoPath, "manuscript.md")
	if err != nil {
		t.Fatalf("CreateManuscript(%s): %v", repoPath, err)
	}
	f.extraManuscripts = append(f.extraManuscripts, m.ManuscriptID)
	return m
}

// newTaskType creates a uniquely-named task type and registers it for cleanup.
// task_type is a GLOBAL table shared with the e2e fixtures — tests must only
// ever touch names minted here.
func (f *itFixture) newTaskType(t *testing.T, isTask bool) string {
	t.Helper()
	name := f.reserveTaskTypeName()
	if err := f.db.AddTaskTypes(f.ctx, []string{name}, isTask); err != nil {
		t.Fatalf("AddTaskTypes(%s): %v", name, err)
	}
	return name
}

// reserveTaskTypeName registers a unique name for cleanup without creating it
// (for tests that exercise AddTaskTypes themselves). varchar(40) budget.
func (f *itFixture) reserveTaskTypeName() string {
	name := fmt.Sprintf("tt-%d-%d", time.Now().UnixNano()%1e12, itNext())
	f.taskTypeNames = append(f.taskTypeNames, name)
	return name
}

// nuke deletes everything the fixture (or the test through it) created, in
// FK-safe order. It deletes by this fixture's unique user/manuscript keys
// only — the e2e suite's shared rows are untouchable from here.
func (f *itFixture) nuke(t *testing.T) {
	t.Helper()
	users := f.extraUsers
	manuscripts := append([]int{f.manuscriptID}, f.extraManuscripts...)

	for _, u := range users {
		userStmts := []string{
			`DELETE FROM point_event WHERE note_id IN (SELECT note_id FROM note WHERE user_id = $1)`,
			`DELETE FROM note_tag WHERE note_id IN (SELECT note_id FROM note WHERE user_id = $1)`,
			`DELETE FROM note_version WHERE note_id IN (SELECT note_id FROM note WHERE user_id = $1)`,
			`DELETE FROM note WHERE user_id = $1`,
			`DELETE FROM suggested_change WHERE user_id = $1`,
			`DELETE FROM daily_rule WHERE user_id = $1`, // cascades daily_rule_tag
			`UPDATE sketch SET canon_variation_id = NULL, placed_from_variation_id = NULL WHERE user_id = $1`,
			`DELETE FROM variation WHERE sketch_id IN (SELECT sketch_id FROM sketch WHERE user_id = $1)`,
			`DELETE FROM sketch WHERE user_id = $1`,
			`DELETE FROM scratchpad WHERE user_id = $1`,
			`DELETE FROM manuscript_access WHERE username = $1`,
			`DELETE FROM role WHERE username = $1`,
			`DELETE FROM people_order WHERE username = $1`,
			`DELETE FROM note_hide WHERE username = $1`,
		}
		for _, sql := range userStmts {
			if _, err := f.pool.Exec(f.ctx, sql, u); err != nil {
				t.Errorf("nuke user %s %q: %v", u, sql[:40], err)
			}
		}
	}
	for _, m := range manuscripts {
		mStmts := []string{
			`DELETE FROM role WHERE manuscript_id = $1`,
			`DELETE FROM people_order WHERE manuscript_id = $1`,
			`DELETE FROM command_slug WHERE migration_id IN (SELECT migration_id FROM migration WHERE manuscript_id = $1)`,
			`DELETE FROM migration WHERE manuscript_id = $1`, // cascades sentence
			`DELETE FROM manuscript WHERE manuscript_id = $1`,
		}
		for _, sql := range mStmts {
			if _, err := f.pool.Exec(f.ctx, sql, m); err != nil {
				t.Errorf("nuke manuscript %d %q: %v", m, sql[:40], err)
			}
		}
	}
	// After notes and rules are gone the FK references to task_type are clear.
	if len(f.taskTypeNames) > 0 {
		if _, err := f.pool.Exec(f.ctx, `DELETE FROM task_type WHERE name = ANY($1)`, f.taskTypeNames); err != nil {
			t.Errorf("nuke task types: %v", err)
		}
	}
	for _, u := range users {
		// Cascades the user's tags via tag_user_id_fkey.
		if _, err := f.pool.Exec(f.ctx, `DELETE FROM "user" WHERE username = $1`, u); err != nil {
			t.Errorf("nuke user row %s: %v", u, err)
		}
	}
}

// makeDoneMigration inserts a done migration with one sentence per text (via
// the same prod fns the processor uses) and returns (migrationID, sentenceIDs).
func (f *itFixture) makeDoneMigration(t *testing.T, commit string, texts ...string) (int, []string) {
	return f.makeDoneMigrationFor(t, f.manuscriptID, commit, texts...)
}

func (f *itFixture) makeDoneMigrationFor(t *testing.T, manuscriptID int, commit string, texts ...string) (int, []string) {
	t.Helper()
	migID, err := f.db.CreatePendingMigration(f.ctx, manuscriptID, commit, "segman-test")
	if err != nil {
		t.Fatalf("CreatePendingMigration(%s): %v", commit, err)
	}
	ids := make([]string, len(texts))
	sentences := make([]models.Sentence, len(texts))
	for i, text := range texts {
		ids[i] = fmt.Sprintf("tsid-%d-%d-%d", migID, i, itNext())
		sentences[i] = models.Sentence{
			SentenceID:  ids[i],
			MigrationID: migID,
			CommitHash:  commit,
			Text:        text,
			Ordinal:     i,
		}
	}
	if len(sentences) > 0 {
		if err := f.db.CreateSentences(f.ctx, sentences); err != nil {
			t.Fatalf("CreateSentences(%s): %v", commit, err)
		}
	}
	if err := f.db.MarkMigrationDone(f.ctx, &models.Migration{
		MigrationID:     migID,
		CommitHash:      commit,
		BranchName:      "main",
		SentenceCount:   len(texts),
		SentenceIDArray: ids,
	}); err != nil {
		t.Fatalf("MarkMigrationDone(%s): %v", commit, err)
	}
	return migID, ids
}

// createNote inserts a sentence note + its version 1 via the prod path.
func (f *itFixture) createNote(t *testing.T, sentenceID, body string) *models.Note {
	return f.createNoteAs(t, f.username, sentenceID, body)
}

func (f *itFixture) createNoteAs(t *testing.T, username, sentenceID, body string) *models.Note {
	t.Helper()
	b := body
	note := &models.Note{
		SentenceID: sentenceID,
		UserID:     username,
		Color:      "yellow",
		Body:       &b,
		Priority:   "none",
		TaskType:   "",
		Impact:     "n/a",
	}
	version := &models.NoteVersion{}
	if err := f.db.CreateNote(f.ctx, note, version); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	return note
}

// createPadNote inserts a scratchpad note via the prod path.
func (f *itFixture) createPadNote(t *testing.T, scratchpadID int, body string) *models.Note {
	t.Helper()
	b := body
	note := &models.Note{
		UserID:   f.username,
		Color:    "green",
		Body:     &b,
		Priority: "none",
		TaskType: "",
		Impact:   "n/a",
	}
	if err := f.db.CreateScratchpadNote(f.ctx, note, scratchpadID); err != nil {
		t.Fatalf("CreateScratchpadNote: %v", err)
	}
	return note
}

// noteVersionCount returns how many note_version rows the note has.
func (f *itFixture) noteVersionCount(t *testing.T, noteID int) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT count(*) FROM note_version WHERE note_id = $1`, noteID).Scan(&n); err != nil {
		t.Fatalf("count versions for note %d: %v", noteID, err)
	}
	return n
}

// noteSentenceID reads the head row's sentence_id (nil when the note has none).
func (f *itFixture) noteSentenceID(t *testing.T, noteID int) *string {
	t.Helper()
	var sid *string
	if err := f.pool.QueryRow(f.ctx,
		`SELECT sentence_id FROM note WHERE note_id = $1`, noteID).Scan(&sid); err != nil {
		t.Fatalf("read note %d: %v", noteID, err)
	}
	return sid
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }
