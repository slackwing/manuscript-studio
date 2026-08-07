package database

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Variations (VARIATIONS_PLAN.md, as clarified): a snippet is an abstract GROUP —
// global ID, manuscript link, canon pointer — and a variation is one flat sibling
// draft: text, integer ordinal rendered as a letter (1=A; NULL = the hidden
// canon variation), frozen flag, and a home scratchpad (where its one widget
// lives). Variations have NO parent/child lineage; siblings can variation different
// parts of a snippet and be composed freely. All functions verify ownership via
// snippet.user_id.

// Sentinel errors, mapped to HTTP statuses by the handlers.
var (
	ErrVariationFrozen     = errors.New("variation is frozen")
	ErrVariationSuperseded = errors.New("variation is superseded")
	ErrVariationCanon      = errors.New("the canon variation is permanently frozen")
	ErrOrdinalCap       = errors.New("variation limit reached (26 per snippet)")
	ErrNotOwner         = errors.New("not found")
	ErrLinkedElsewhere  = errors.New("snippet is linked to a different manuscript")
	ErrAlreadyCanonized = errors.New("snippet already has a canon variation")
	ErrSnippetCanonized = errors.New("a canonized snippet's link is permanent")
	ErrVariationNoLetter   = errors.New("cannot base a variation on the canon variation")
)

// MaxVariationOrdinal is the current letter cap (Z). The column is an integer, so
// lifting this later (AA, AB, …) is a UI concern, not a schema change.
const MaxVariationOrdinal = 26

type Variation struct {
	VariationID     int       `json:"variation_id"`
	SnippetID    string    `json:"snippet_id"`
	Ordinal      *int      `json:"ordinal"` // nil = the hidden canon variation
	Text         string    `json:"text"`
	State        string    `json:"state"` // draft | frozen | superseded
	ScratchpadID *int      `json:"scratchpad_id,omitempty"` // the variation's one home
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// VariationRef is the light form used for the sibling tab list.
type VariationRef struct {
	VariationID int    `json:"variation_id"`
	Ordinal  *int   `json:"ordinal"`
	State    string `json:"state"`
}

type SnippetInfo struct {
	SnippetID            string `json:"snippet_id"`
	LinkedManuscriptID   int    `json:"linked_manuscript_id"`
	LinkedManuscriptName string `json:"linked_manuscript_name"`
	CanonVariationID        int    `json:"canon_variation_id"` // 0 = none
}

// VariationContext is everything one widget needs in a single payload: the variation,
// its group facts, its SIBLINGS (all lettered variations in the group, for the
// tab list), and the canon variation snapshot when one exists.
type VariationContext struct {
	Variation   Variation      `json:"variation"`
	Snippet  SnippetInfo `json:"snippet"`
	Siblings []VariationRef `json:"siblings"`
	Canon    *Variation     `json:"canon,omitempty"` // text = as-canonized snapshot
	// The snippet's note (026) — just what the widget's square needs; the
	// float fetches the full note (with tags) through the notes API.
	Note *SnippetNoteInfo `json:"note,omitempty"`
}

// SnippetNoteInfo is the square's slice of the snippet note.
type SnippetNoteInfo struct {
	NoteID    int    `json:"note_id"`
	Color     string `json:"color"`
	Completed bool   `json:"completed"`
}

// PickerVariation is one row of the Based-on / canonize pickers. Link and canon
// facts ride along so the canonize modal can grey out ineligible rows.
type PickerVariation struct {
	VariationID             int       `json:"variation_id"`
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

func scanVariation(row pgx.Row) (Variation, error) {
	var s Variation
	err := row.Scan(&s.VariationID, &s.SnippetID, &s.Ordinal, &s.Text, &s.State,
		&s.ScratchpadID, &s.CreatedAt, &s.UpdatedAt)
	return s, err
}

const variationCols = `variation_id, snippet_id, ordinal, text, state, scratchpad_id, created_at, updated_at`

// CreateSnippet makes a fresh group: snippet row + variation A. scratchpadID is
// the variation's home (the scratchpad whose widget is being created).
func (db *DB) CreateSnippet(ctx context.Context, userID string, scratchpadID *int) (*VariationContext, error) {
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
	s, err := scanVariation(tx.QueryRow(ctx, `
		INSERT INTO variation (snippet_id, ordinal, scratchpad_id) VALUES ($1, 1, $2)
		RETURNING `+variationCols, snippetID, scratchpadID))
	if err != nil {
		return nil, fmt.Errorf("create variation A: %w", err)
	}
	// Every snippet carries ONE note (026), minted with it — blank, yellow,
	// manuscript inherited from the host pad's link (a copy, not synced).
	if _, err := tx.Exec(ctx, `
		INSERT INTO note (manuscript_id, user_id, color, priority, flagged, position, snippet_id)
		SELECT (SELECT linked_manuscript_id FROM scratchpad WHERE scratchpad_id = $1),
		       $2, 'yellow', 'none', false, 'a0', $3
	`, scratchpadID, userID, snippetID); err != nil {
		return nil, fmt.Errorf("create snippet note: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return db.GetVariationContext(ctx, userID, s.VariationID)
}

// CreateVariationFrom adds the next-letter sibling variation based on source: text
// copied, home = the new widget's scratchpad. No lineage, no source freezing —
// the source is left exactly as-is.
func (db *DB) CreateVariationFrom(ctx context.Context, userID string, sourceID int, scratchpadID *int) (*VariationContext, error) {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var srcSnippet, owner, srcText string
	var srcOrdinal *int
	err = tx.QueryRow(ctx, `
		SELECT v.snippet_id, v.ordinal, v.text, s.user_id
		FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = $1 FOR UPDATE OF v
	`, sourceID).Scan(&srcSnippet, &srcOrdinal, &srcText, &owner)
	if err != nil || owner != userID {
		return nil, ErrNotOwner
	}
	if srcOrdinal == nil {
		return nil, ErrVariationNoLetter
	}
	var next int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(ordinal), 0) + 1 FROM variation WHERE snippet_id = $1
	`, srcSnippet).Scan(&next); err != nil {
		return nil, err
	}
	if next > MaxVariationOrdinal {
		return nil, ErrOrdinalCap
	}
	s, err := scanVariation(tx.QueryRow(ctx, `
		INSERT INTO variation (snippet_id, ordinal, text, scratchpad_id)
		VALUES ($1, $2, $3, $4)
		RETURNING `+variationCols, srcSnippet, next, srcText, scratchpadID))
	if err != nil {
		return nil, fmt.Errorf("create variation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return db.GetVariationContext(ctx, userID, s.VariationID)
}

// GetVariationContext returns the widget payload: the variation, its group facts, its
// SIBLINGS (all lettered variations in the group, for the tab list, ordered by
// letter), and the canon variation (when one exists).
func (db *DB) GetVariationContext(ctx context.Context, userID string, id int) (*VariationContext, error) {
	out := &VariationContext{Siblings: []VariationRef{}}
	var owner string
	var linkedID, canonID *int
	err := db.Pool.QueryRow(ctx, `
		SELECT v.variation_id, v.snippet_id, v.ordinal, v.text, v.state, v.scratchpad_id, v.created_at, v.updated_at,
		       s.user_id, s.linked_manuscript_id, s.linked_manuscript_name, s.canon_variation_id
		FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = $1 AND v.deleted_at IS NULL
	`, id).Scan(&out.Variation.VariationID, &out.Variation.SnippetID, &out.Variation.Ordinal,
		&out.Variation.Text, &out.Variation.State, &out.Variation.ScratchpadID,
		&out.Variation.CreatedAt, &out.Variation.UpdatedAt,
		&owner, &linkedID, &out.Snippet.LinkedManuscriptName, &canonID)
	if err != nil || owner != userID {
		return nil, ErrNotOwner
	}
	out.Snippet.SnippetID = out.Variation.SnippetID
	if linkedID != nil {
		out.Snippet.LinkedManuscriptID = *linkedID
	}
	if canonID != nil {
		out.Snippet.CanonVariationID = *canonID
	}

	// Siblings = every lettered variation in this group (including this one), by
	// letter — the tab list. The frontend orders "current first, then others".
	rows, err := db.Pool.Query(ctx, `
		SELECT variation_id, ordinal, state FROM variation
		WHERE snippet_id = $1 AND ordinal IS NOT NULL AND deleted_at IS NULL
		ORDER BY ordinal
	`, out.Variation.SnippetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ref VariationRef
		if err := rows.Scan(&ref.VariationID, &ref.Ordinal, &ref.State); err != nil {
			return nil, err
		}
		out.Siblings = append(out.Siblings, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// The snippet's note (026) — the square's color + completed state. Old
	// snippets without one (pre-backfill edge) just omit it.
	var sn SnippetNoteInfo
	var completedAt *time.Time
	err = db.Pool.QueryRow(ctx, `
		SELECT note_id, color, completed_at FROM note
		WHERE snippet_id = $1 AND deleted_at IS NULL
	`, out.Variation.SnippetID).Scan(&sn.NoteID, &sn.Color, &completedAt)
	if err == nil {
		sn.Completed = completedAt != nil
		out.Note = &sn
	}

	if out.Snippet.CanonVariationID != 0 {
		canon, err := scanVariation(db.Pool.QueryRow(ctx, `
			SELECT `+variationCols+` FROM variation WHERE variation_id = $1
		`, out.Snippet.CanonVariationID))
		if err == nil {
			out.Canon = &canon
		}
	}
	return out, nil
}

// UpdateVariationText autosaves an edit: refused while frozen (or canon), bumps
// updated_at, appends a revision (house pattern).
func (db *DB) UpdateVariationText(ctx context.Context, userID string, id int, text string) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var owner, state string
	var ordinal *int
	err = tx.QueryRow(ctx, `
		SELECT s.user_id, v.state, v.ordinal
		FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = $1 FOR UPDATE OF v
	`, id).Scan(&owner, &state, &ordinal)
	if err != nil || owner != userID {
		return ErrNotOwner
	}
	if ordinal == nil {
		return ErrVariationCanon
	}
	if state == "frozen" {
		return ErrVariationFrozen
	}
	if state == "superseded" {
		return ErrVariationSuperseded
	}
	if _, err := tx.Exec(ctx, `
		UPDATE variation SET text = $2, updated_at = NOW() WHERE variation_id = $1
	`, id, text); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO variation_revision (variation_id, text) VALUES ($1, $2)
	`, id, text); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SetVariationState sets the lifecycle state (draft | frozen | superseded).
// frozen and superseded are mutually exclusive by construction — one column,
// so setting either cancels the other. The canon variation is permanently frozen
// — its snapshot is immutable by design.
func (db *DB) SetVariationState(ctx context.Context, userID string, id int, state string) error {
	if state != "draft" && state != "frozen" && state != "superseded" {
		return fmt.Errorf("invalid variation state %q", state)
	}
	var owner string
	var ordinal *int
	err := db.Pool.QueryRow(ctx, `
		SELECT s.user_id, v.ordinal
		FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = $1
	`, id).Scan(&owner, &ordinal)
	if err != nil || owner != userID {
		return ErrNotOwner
	}
	if ordinal == nil {
		return ErrVariationCanon
	}
	_, err = db.Pool.Exec(ctx, `UPDATE variation SET state = $2 WHERE variation_id = $1`, id, state)
	return err
}

// FreezeAllVariations freezes every lettered variation in a snippet group (the
// canonize "Freeze all variations?" option). Owner-checked via the snippet.
func (db *DB) FreezeAllVariations(ctx context.Context, userID, snippetID string) error {
	var owner string
	if err := db.Pool.QueryRow(ctx, `SELECT user_id FROM snippet WHERE snippet_id = $1`, snippetID).Scan(&owner); err != nil || owner != userID {
		return ErrNotOwner
	}
	_, err := db.Pool.Exec(ctx, `
		UPDATE variation SET state = 'frozen' WHERE snippet_id = $1 AND ordinal IS NOT NULL AND state = 'draft'
	`, snippetID)
	return err
}

// ListVariationsForPicker feeds the Based-on picker: the user's lettered
// variations, most recently updated first. q filters on text (contiguous
// case-insensitive substring). Superseded variations are excluded — they're
// explicitly "no longer the preferred variation", so neither a base for new
// related variations nor a canonize candidate (un-supersede first).
func (db *DB) ListVariationsForPicker(ctx context.Context, userID, q string) ([]PickerVariation, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT v.variation_id, v.snippet_id, v.ordinal, LEFT(v.text, 160), v.state, v.updated_at,
		       COALESCE(s.linked_manuscript_id, 0), s.linked_manuscript_name,
		       (s.canon_variation_id IS NOT NULL) AS canonized
		FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
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
	out := []PickerVariation{}
	for rows.Next() {
		var p PickerVariation
		if err := rows.Scan(&p.VariationID, &p.SnippetID, &p.Ordinal, &p.Preview, &p.State, &p.UpdatedAt,
			&p.LinkedManuscriptID, &p.LinkedManuscriptName, &p.Canonized); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DeletedVariation is a soft-deleted variation shown in the Restore… picker.
type DeletedVariation struct {
	VariationID             int       `json:"variation_id"`
	SnippetID            string    `json:"snippet_id"`
	Ordinal              int       `json:"ordinal"`
	Preview              string    `json:"preview"`
	State                string    `json:"state"`
	DeletedAt            time.Time `json:"deleted_at"`
	LinkedManuscriptName string    `json:"linked_manuscript_name"`
}

// SoftDeleteVariation marks a lettered variation deleted (owner-checked). The canon
// variation (NULL ordinal) can't be deleted this way. Idempotent.
func (db *DB) SoftDeleteVariation(ctx context.Context, userID string, id int) error {
	var owner string
	var ordinal *int
	err := db.Pool.QueryRow(ctx, `
		SELECT s.user_id, v.ordinal FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = $1
	`, id).Scan(&owner, &ordinal)
	if err != nil || owner != userID {
		return ErrNotOwner
	}
	if ordinal == nil {
		return ErrVariationCanon
	}
	_, err = db.Pool.Exec(ctx, `UPDATE variation SET deleted_at = NOW() WHERE variation_id = $1`, id)
	return err
}

// RestoreVariation clears deleted_at (owner-checked). A frozen variation stays frozen.
func (db *DB) RestoreVariation(ctx context.Context, userID string, id int) error {
	var owner string
	err := db.Pool.QueryRow(ctx, `
		SELECT s.user_id FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = $1
	`, id).Scan(&owner)
	if err != nil || owner != userID {
		return ErrNotOwner
	}
	_, err = db.Pool.Exec(ctx, `UPDATE variation SET deleted_at = NULL WHERE variation_id = $1`, id)
	return err
}

// ListDeletedVariations feeds the Restore… picker: the user's soft-deleted
// lettered variations, most recently DELETED first. q filters on text.
func (db *DB) ListDeletedVariations(ctx context.Context, userID, q string) ([]DeletedVariation, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT v.variation_id, v.snippet_id, v.ordinal, LEFT(v.text, 160), v.state,
		       v.deleted_at, s.linked_manuscript_name
		FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE s.user_id = $1 AND v.ordinal IS NOT NULL AND v.deleted_at IS NOT NULL
		  AND ($2 = '' OR v.text ILIKE '%' || $2 || '%')
		ORDER BY v.deleted_at DESC
		LIMIT 50
	`, userID, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeletedVariation{}
	for rows.Next() {
		var d DeletedVariation
		if err := rows.Scan(&d.VariationID, &d.SnippetID, &d.Ordinal, &d.Preview, &d.State,
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
		SELECT user_id, canon_variation_id FROM snippet WHERE snippet_id = $1
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

// CanonizeVariation dubs a variation canon: creates the hidden canon variation (no
// letter, permanently frozen, text = the immutable as-canonized snapshot), sets
// the group's canon pointer, and auto-links the group to the manuscript. The
// manuscript text itself is inserted client-side as a suggestion wrapping the
// text in &snippet#<snippet-id>{label} … &end#<snippet-id> (canon truth stays
// in the manuscript — VARIATIONS_PLAN.md §2).
func (db *DB) CanonizeVariation(ctx context.Context, userID string, variationID, manuscriptID int, manuscriptName string) (*VariationContext, error) {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var owner, snippetID, text string
	var ordinal, linkedID, canonID *int
	err = tx.QueryRow(ctx, `
		SELECT s.user_id, s.snippet_id, s.linked_manuscript_id, s.canon_variation_id, v.ordinal, v.text
		FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = $1 FOR UPDATE OF s
	`, variationID).Scan(&owner, &snippetID, &linkedID, &canonID, &ordinal, &text)
	if err != nil || owner != userID {
		return nil, ErrNotOwner
	}
	if ordinal == nil {
		return nil, ErrVariationCanon
	}
	if canonID != nil {
		return nil, ErrAlreadyCanonized
	}
	if linkedID != nil && *linkedID != manuscriptID {
		return nil, ErrLinkedElsewhere
	}
	var newCanonID int
	if err := tx.QueryRow(ctx, `
		INSERT INTO variation (snippet_id, ordinal, text, state)
		VALUES ($1, NULL, $2, 'frozen')
		RETURNING variation_id
	`, snippetID, text).Scan(&newCanonID); err != nil {
		return nil, fmt.Errorf("create canon variation: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE snippet SET canon_variation_id = $2, linked_manuscript_id = $3, linked_manuscript_name = $4
		WHERE snippet_id = $1
	`, snippetID, newCanonID, manuscriptID, manuscriptName); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return db.GetVariationContext(ctx, userID, variationID)
}

// CountCanonizedAmong reports how many of the given placed variations belong to a
// canonized group — the home card's ⧉ x/y badge.
func (db *DB) CountCanonizedAmong(ctx context.Context, variationIDs []int) (int, error) {
	if len(variationIDs) == 0 {
		return 0, nil
	}
	var n int
	err := db.Pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM variation v
		JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = ANY($1) AND s.canon_variation_id IS NOT NULL
	`, variationIDs).Scan(&n)
	return n, err
}

// SnippetHomeScratchpad returns the home scratchpad id for the variation that is a
// snippet group's given... (helper for navigate-to-source). Returns 0 if none.
func (db *DB) VariationHomeScratchpad(ctx context.Context, userID string, variationID int) (int, error) {
	var owner string
	var spid *int
	err := db.Pool.QueryRow(ctx, `
		SELECT s.user_id, v.scratchpad_id FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = $1
	`, variationID).Scan(&owner, &spid)
	if err != nil || owner != userID {
		return 0, ErrNotOwner
	}
	if spid == nil {
		return 0, nil
	}
	return *spid, nil
}
