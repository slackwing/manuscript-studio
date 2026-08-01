package database

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Sketches (VARIATIONS_PLAN.md, as clarified): a snippet is an abstract GROUP —
// global ID, manuscript link, canon pointer — and a sketch is one flat sibling
// draft: text, integer ordinal rendered as a letter (1=A; NULL = the hidden
// canon sketch), frozen flag, and a home scratchpad (where its one widget
// lives). Sketches have NO parent/child lineage; siblings can sketch different
// parts of a snippet and be composed freely. All functions verify ownership via
// snippet.user_id.

// Sentinel errors, mapped to HTTP statuses by the handlers.
var (
	ErrSketchFrozen     = errors.New("sketch is frozen")
	ErrSketchSuperseded = errors.New("sketch is superseded")
	ErrSketchCanon      = errors.New("the canon sketch is permanently frozen")
	ErrOrdinalCap       = errors.New("sketch limit reached (26 per snippet)")
	ErrNotOwner         = errors.New("not found")
	ErrLinkedElsewhere  = errors.New("snippet is linked to a different manuscript")
	ErrAlreadyCanonized = errors.New("snippet already has a canon sketch")
	ErrSnippetCanonized = errors.New("a canonized snippet's link is permanent")
	ErrSketchNoLetter   = errors.New("cannot base a sketch on the canon sketch")
)

// MaxSketchOrdinal is the current letter cap (Z). The column is an integer, so
// lifting this later (AA, AB, …) is a UI concern, not a schema change.
const MaxSketchOrdinal = 26

type Sketch struct {
	SketchID     int       `json:"sketch_id"`
	SnippetID    string    `json:"snippet_id"`
	Ordinal      *int      `json:"ordinal"` // nil = the hidden canon sketch
	Text         string    `json:"text"`
	State        string    `json:"state"` // draft | frozen | superseded
	ScratchpadID *int      `json:"scratchpad_id,omitempty"` // the sketch's one home
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// SketchRef is the light form used for the sibling tab list.
type SketchRef struct {
	SketchID int    `json:"sketch_id"`
	Ordinal  *int   `json:"ordinal"`
	State    string `json:"state"`
}

type SnippetInfo struct {
	SnippetID            string `json:"snippet_id"`
	LinkedManuscriptID   int    `json:"linked_manuscript_id"`
	LinkedManuscriptName string `json:"linked_manuscript_name"`
	CanonSketchID        int    `json:"canon_sketch_id"` // 0 = none
}

// SketchContext is everything one widget needs in a single payload: the sketch,
// its group facts, its SIBLINGS (all lettered sketches in the group, for the
// tab list), and the canon sketch snapshot when one exists.
type SketchContext struct {
	Sketch   Sketch      `json:"sketch"`
	Snippet  SnippetInfo `json:"snippet"`
	Siblings []SketchRef `json:"siblings"`
	Canon    *Sketch     `json:"canon,omitempty"` // text = as-canonized snapshot
}

// PickerSketch is one row of the Based-on / canonize pickers. Link and canon
// facts ride along so the canonize modal can grey out ineligible rows.
type PickerSketch struct {
	SketchID             int       `json:"sketch_id"`
	SnippetID            string    `json:"snippet_id"`
	Ordinal              int       `json:"ordinal"`
	Preview              string    `json:"preview"`
	State                string    `json:"state"`
	UpdatedAt            time.Time `json:"updated_at"`
	LinkedManuscriptID   int       `json:"linked_manuscript_id"`
	LinkedManuscriptName string    `json:"linked_manuscript_name"`
	Canonized            bool      `json:"canonized"`
}

const snippetIDAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

// newSnippetID generates the globally-unique, slug-shaped snippet ID that also
// appears in the manuscript as &snippet#<id> (10 base36 chars ≈ 52 bits —
// collision-free at any personal scale, retried on conflict anyway).
func newSnippetID() (string, error) {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, len(buf))
	for i, b := range buf {
		out[i] = snippetIDAlphabet[int(b)%len(snippetIDAlphabet)]
	}
	return string(out), nil
}

func scanSketch(row pgx.Row) (Sketch, error) {
	var s Sketch
	err := row.Scan(&s.SketchID, &s.SnippetID, &s.Ordinal, &s.Text, &s.State,
		&s.ScratchpadID, &s.CreatedAt, &s.UpdatedAt)
	return s, err
}

const sketchCols = `sketch_id, snippet_id, ordinal, text, state, scratchpad_id, created_at, updated_at`

// CreateSnippet makes a fresh group: snippet row + sketch A. scratchpadID is
// the sketch's home (the scratchpad whose widget is being created).
func (db *DB) CreateSnippet(ctx context.Context, userID string, scratchpadID *int) (*SketchContext, error) {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var snippetID string
	for attempt := 0; ; attempt++ {
		snippetID, err = newSnippetID()
		if err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, `INSERT INTO snippet (snippet_id, user_id) VALUES ($1, $2)`, snippetID, userID)
		if err == nil {
			break
		}
		if attempt >= 3 {
			return nil, fmt.Errorf("create snippet: %w", err)
		}
	}
	s, err := scanSketch(tx.QueryRow(ctx, `
		INSERT INTO sketch (snippet_id, ordinal, scratchpad_id) VALUES ($1, 1, $2)
		RETURNING `+sketchCols, snippetID, scratchpadID))
	if err != nil {
		return nil, fmt.Errorf("create sketch A: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return db.GetSketchContext(ctx, userID, s.SketchID)
}

// CreateSketchFrom adds the next-letter sibling sketch based on source: text
// copied, home = the new widget's scratchpad. No lineage, no source freezing —
// the source is left exactly as-is.
func (db *DB) CreateSketchFrom(ctx context.Context, userID string, sourceID int, scratchpadID *int) (*SketchContext, error) {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var srcSnippet, owner, srcText string
	var srcOrdinal *int
	err = tx.QueryRow(ctx, `
		SELECT v.snippet_id, v.ordinal, v.text, s.user_id
		FROM sketch v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.sketch_id = $1 FOR UPDATE OF v
	`, sourceID).Scan(&srcSnippet, &srcOrdinal, &srcText, &owner)
	if err != nil || owner != userID {
		return nil, ErrNotOwner
	}
	if srcOrdinal == nil {
		return nil, ErrSketchNoLetter
	}
	var next int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(ordinal), 0) + 1 FROM sketch WHERE snippet_id = $1
	`, srcSnippet).Scan(&next); err != nil {
		return nil, err
	}
	if next > MaxSketchOrdinal {
		return nil, ErrOrdinalCap
	}
	s, err := scanSketch(tx.QueryRow(ctx, `
		INSERT INTO sketch (snippet_id, ordinal, text, scratchpad_id)
		VALUES ($1, $2, $3, $4)
		RETURNING `+sketchCols, srcSnippet, next, srcText, scratchpadID))
	if err != nil {
		return nil, fmt.Errorf("create sketch: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return db.GetSketchContext(ctx, userID, s.SketchID)
}

// GetSketchContext returns the widget payload: the sketch, its group facts, its
// SIBLINGS (all lettered sketches in the group, for the tab list, ordered by
// letter), and the canon sketch (when one exists).
func (db *DB) GetSketchContext(ctx context.Context, userID string, id int) (*SketchContext, error) {
	out := &SketchContext{Siblings: []SketchRef{}}
	var owner string
	var linkedID, canonID *int
	err := db.Pool.QueryRow(ctx, `
		SELECT v.sketch_id, v.snippet_id, v.ordinal, v.text, v.state, v.scratchpad_id, v.created_at, v.updated_at,
		       s.user_id, s.linked_manuscript_id, s.linked_manuscript_name, s.canon_sketch_id
		FROM sketch v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.sketch_id = $1 AND v.deleted_at IS NULL
	`, id).Scan(&out.Sketch.SketchID, &out.Sketch.SnippetID, &out.Sketch.Ordinal,
		&out.Sketch.Text, &out.Sketch.State, &out.Sketch.ScratchpadID,
		&out.Sketch.CreatedAt, &out.Sketch.UpdatedAt,
		&owner, &linkedID, &out.Snippet.LinkedManuscriptName, &canonID)
	if err != nil || owner != userID {
		return nil, ErrNotOwner
	}
	out.Snippet.SnippetID = out.Sketch.SnippetID
	if linkedID != nil {
		out.Snippet.LinkedManuscriptID = *linkedID
	}
	if canonID != nil {
		out.Snippet.CanonSketchID = *canonID
	}

	// Siblings = every lettered sketch in this group (including this one), by
	// letter — the tab list. The frontend orders "current first, then others".
	rows, err := db.Pool.Query(ctx, `
		SELECT sketch_id, ordinal, state FROM sketch
		WHERE snippet_id = $1 AND ordinal IS NOT NULL AND deleted_at IS NULL
		ORDER BY ordinal
	`, out.Sketch.SnippetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ref SketchRef
		if err := rows.Scan(&ref.SketchID, &ref.Ordinal, &ref.State); err != nil {
			return nil, err
		}
		out.Siblings = append(out.Siblings, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if out.Snippet.CanonSketchID != 0 {
		canon, err := scanSketch(db.Pool.QueryRow(ctx, `
			SELECT `+sketchCols+` FROM sketch WHERE sketch_id = $1
		`, out.Snippet.CanonSketchID))
		if err == nil {
			out.Canon = &canon
		}
	}
	return out, nil
}

// UpdateSketchText autosaves an edit: refused while frozen (or canon), bumps
// updated_at, appends a revision (house pattern).
func (db *DB) UpdateSketchText(ctx context.Context, userID string, id int, text string) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var owner, state string
	var ordinal *int
	err = tx.QueryRow(ctx, `
		SELECT s.user_id, v.state, v.ordinal
		FROM sketch v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.sketch_id = $1 FOR UPDATE OF v
	`, id).Scan(&owner, &state, &ordinal)
	if err != nil || owner != userID {
		return ErrNotOwner
	}
	if ordinal == nil {
		return ErrSketchCanon
	}
	if state == "frozen" {
		return ErrSketchFrozen
	}
	if state == "superseded" {
		return ErrSketchSuperseded
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sketch SET text = $2, updated_at = NOW() WHERE sketch_id = $1
	`, id, text); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sketch_revision (sketch_id, text) VALUES ($1, $2)
	`, id, text); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SetSketchState sets the lifecycle state (draft | frozen | superseded).
// frozen and superseded are mutually exclusive by construction — one column,
// so setting either cancels the other. The canon sketch is permanently frozen
// — its snapshot is immutable by design.
func (db *DB) SetSketchState(ctx context.Context, userID string, id int, state string) error {
	if state != "draft" && state != "frozen" && state != "superseded" {
		return fmt.Errorf("invalid sketch state %q", state)
	}
	var owner string
	var ordinal *int
	err := db.Pool.QueryRow(ctx, `
		SELECT s.user_id, v.ordinal
		FROM sketch v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.sketch_id = $1
	`, id).Scan(&owner, &ordinal)
	if err != nil || owner != userID {
		return ErrNotOwner
	}
	if ordinal == nil {
		return ErrSketchCanon
	}
	_, err = db.Pool.Exec(ctx, `UPDATE sketch SET state = $2 WHERE sketch_id = $1`, id, state)
	return err
}

// FreezeAllSketches freezes every lettered sketch in a snippet group (the
// canonize "Freeze all sketches?" option). Owner-checked via the snippet.
func (db *DB) FreezeAllSketches(ctx context.Context, userID, snippetID string) error {
	var owner string
	if err := db.Pool.QueryRow(ctx, `SELECT user_id FROM snippet WHERE snippet_id = $1`, snippetID).Scan(&owner); err != nil || owner != userID {
		return ErrNotOwner
	}
	_, err := db.Pool.Exec(ctx, `
		UPDATE sketch SET state = 'frozen' WHERE snippet_id = $1 AND ordinal IS NOT NULL AND state = 'draft'
	`, snippetID)
	return err
}

// ListSketchesForPicker feeds the Based-on picker: the user's lettered
// sketches, most recently updated first. q filters on text (contiguous
// case-insensitive substring). Superseded sketches are excluded — they're
// explicitly "no longer the preferred sketch", so neither a base for new
// related sketches nor a canonize candidate (un-supersede first).
func (db *DB) ListSketchesForPicker(ctx context.Context, userID, q string) ([]PickerSketch, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT v.sketch_id, v.snippet_id, v.ordinal, LEFT(v.text, 160), v.state, v.updated_at,
		       COALESCE(s.linked_manuscript_id, 0), s.linked_manuscript_name,
		       (s.canon_sketch_id IS NOT NULL) AS canonized
		FROM sketch v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE s.user_id = $1 AND v.ordinal IS NOT NULL AND v.deleted_at IS NULL
		  AND v.state <> 'superseded'
		  AND ($2 = '' OR v.text ILIKE '%' || $2 || '%')
		ORDER BY v.updated_at DESC
		LIMIT 50
	`, userID, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PickerSketch{}
	for rows.Next() {
		var p PickerSketch
		if err := rows.Scan(&p.SketchID, &p.SnippetID, &p.Ordinal, &p.Preview, &p.State, &p.UpdatedAt,
			&p.LinkedManuscriptID, &p.LinkedManuscriptName, &p.Canonized); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DeletedSketch is a soft-deleted sketch shown in the Restore… picker.
type DeletedSketch struct {
	SketchID             int       `json:"sketch_id"`
	SnippetID            string    `json:"snippet_id"`
	Ordinal              int       `json:"ordinal"`
	Preview              string    `json:"preview"`
	State                string    `json:"state"`
	DeletedAt            time.Time `json:"deleted_at"`
	LinkedManuscriptName string    `json:"linked_manuscript_name"`
}

// SoftDeleteSketch marks a lettered sketch deleted (owner-checked). The canon
// sketch (NULL ordinal) can't be deleted this way. Idempotent.
func (db *DB) SoftDeleteSketch(ctx context.Context, userID string, id int) error {
	var owner string
	var ordinal *int
	err := db.Pool.QueryRow(ctx, `
		SELECT s.user_id, v.ordinal FROM sketch v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.sketch_id = $1
	`, id).Scan(&owner, &ordinal)
	if err != nil || owner != userID {
		return ErrNotOwner
	}
	if ordinal == nil {
		return ErrSketchCanon
	}
	_, err = db.Pool.Exec(ctx, `UPDATE sketch SET deleted_at = NOW() WHERE sketch_id = $1`, id)
	return err
}

// RestoreSketch clears deleted_at (owner-checked). A frozen sketch stays frozen.
func (db *DB) RestoreSketch(ctx context.Context, userID string, id int) error {
	var owner string
	err := db.Pool.QueryRow(ctx, `
		SELECT s.user_id FROM sketch v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.sketch_id = $1
	`, id).Scan(&owner)
	if err != nil || owner != userID {
		return ErrNotOwner
	}
	_, err = db.Pool.Exec(ctx, `UPDATE sketch SET deleted_at = NULL WHERE sketch_id = $1`, id)
	return err
}

// ListDeletedSketches feeds the Restore… picker: the user's soft-deleted
// lettered sketches, most recently DELETED first. q filters on text.
func (db *DB) ListDeletedSketches(ctx context.Context, userID, q string) ([]DeletedSketch, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT v.sketch_id, v.snippet_id, v.ordinal, LEFT(v.text, 160), v.state,
		       v.deleted_at, s.linked_manuscript_name
		FROM sketch v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE s.user_id = $1 AND v.ordinal IS NOT NULL AND v.deleted_at IS NOT NULL
		  AND ($2 = '' OR v.text ILIKE '%' || $2 || '%')
		ORDER BY v.deleted_at DESC
		LIMIT 50
	`, userID, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeletedSketch{}
	for rows.Next() {
		var d DeletedSketch
		if err := rows.Scan(&d.SketchID, &d.SnippetID, &d.Ordinal, &d.Preview, &d.State,
			&d.DeletedAt, &d.LinkedManuscriptName); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// LinkSnippet sets (or, with manuscriptID 0, clears) the group's manuscript
// link. Refused once canonized — canon pins the link permanently.
func (db *DB) LinkSnippet(ctx context.Context, userID, snippetID string, manuscriptID int, manuscriptName string) error {
	var owner string
	var canonID *int
	err := db.Pool.QueryRow(ctx, `
		SELECT user_id, canon_sketch_id FROM snippet WHERE snippet_id = $1
	`, snippetID).Scan(&owner, &canonID)
	if err != nil || owner != userID {
		return ErrNotOwner
	}
	if canonID != nil {
		return ErrSnippetCanonized
	}
	if manuscriptID == 0 {
		_, err = db.Pool.Exec(ctx, `
			UPDATE snippet SET linked_manuscript_id = NULL, linked_manuscript_name = '' WHERE snippet_id = $1
		`, snippetID)
		return err
	}
	_, err = db.Pool.Exec(ctx, `
		UPDATE snippet SET linked_manuscript_id = $2, linked_manuscript_name = $3 WHERE snippet_id = $1
	`, snippetID, manuscriptID, manuscriptName)
	return err
}

// CanonizeSketch dubs a sketch canon: creates the hidden canon sketch (no
// letter, permanently frozen, text = the immutable as-canonized snapshot), sets
// the group's canon pointer, and auto-links the group to the manuscript. The
// manuscript text itself is inserted client-side as a suggestion wrapping the
// text in &snippet#<snippet-id>{label} … &end#<snippet-id> (canon truth stays
// in the manuscript — VARIATIONS_PLAN.md §2).
func (db *DB) CanonizeSketch(ctx context.Context, userID string, sketchID, manuscriptID int, manuscriptName string) (*SketchContext, error) {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var owner, snippetID, text string
	var ordinal, linkedID, canonID *int
	err = tx.QueryRow(ctx, `
		SELECT s.user_id, s.snippet_id, s.linked_manuscript_id, s.canon_sketch_id, v.ordinal, v.text
		FROM sketch v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.sketch_id = $1 FOR UPDATE OF s
	`, sketchID).Scan(&owner, &snippetID, &linkedID, &canonID, &ordinal, &text)
	if err != nil || owner != userID {
		return nil, ErrNotOwner
	}
	if ordinal == nil {
		return nil, ErrSketchCanon
	}
	if canonID != nil {
		return nil, ErrAlreadyCanonized
	}
	if linkedID != nil && *linkedID != manuscriptID {
		return nil, ErrLinkedElsewhere
	}
	var newCanonID int
	if err := tx.QueryRow(ctx, `
		INSERT INTO sketch (snippet_id, ordinal, text, state)
		VALUES ($1, NULL, $2, 'frozen')
		RETURNING sketch_id
	`, snippetID, text).Scan(&newCanonID); err != nil {
		return nil, fmt.Errorf("create canon sketch: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE snippet SET canon_sketch_id = $2, linked_manuscript_id = $3, linked_manuscript_name = $4
		WHERE snippet_id = $1
	`, snippetID, newCanonID, manuscriptID, manuscriptName); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return db.GetSketchContext(ctx, userID, sketchID)
}

// CountCanonizedAmong reports how many of the given placed sketches belong to a
// canonized group — the home card's ⧉ x/y badge.
func (db *DB) CountCanonizedAmong(ctx context.Context, sketchIDs []int) (int, error) {
	if len(sketchIDs) == 0 {
		return 0, nil
	}
	var n int
	err := db.Pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM sketch v
		JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.sketch_id = ANY($1) AND s.canon_sketch_id IS NOT NULL
	`, sketchIDs).Scan(&n)
	return n, err
}

// SnippetHomeScratchpad returns the home scratchpad id for the sketch that is a
// snippet group's given... (helper for navigate-to-source). Returns 0 if none.
func (db *DB) SketchHomeScratchpad(ctx context.Context, userID string, sketchID int) (int, error) {
	var owner string
	var spid *int
	err := db.Pool.QueryRow(ctx, `
		SELECT s.user_id, v.scratchpad_id FROM sketch v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.sketch_id = $1
	`, sketchID).Scan(&owner, &spid)
	if err != nil || owner != userID {
		return 0, ErrNotOwner
	}
	if spid == nil {
		return 0, nil
	}
	return *spid, nil
}
