package database

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Variations (VARIATIONS_PLAN.md): a snippet is an abstract GROUP — global
// ID, manuscript link, canon pointer — and a variation is the real content:
// text, integer ordinal rendered as a letter (1=A; NULL = the hidden canon
// variation), parent lineage, frozen flag. All functions verify ownership
// via snippet.user_id.

// Sentinel errors, mapped to HTTP statuses by the handlers.
var (
	ErrVariationFrozen   = errors.New("variation is frozen")
	ErrVariationCanon    = errors.New("the canon variation is permanently frozen")
	ErrOrdinalCap        = errors.New("variation limit reached (26 per snippet)")
	ErrNotOwner          = errors.New("not found")
	ErrLinkedElsewhere   = errors.New("snippet is linked to a different manuscript")
	ErrAlreadyCanonized  = errors.New("snippet already has a canon variation")
	ErrSnippetCanonized  = errors.New("a canonized snippet's link is permanent")
	ErrVariationNoLetter = errors.New("cannot base a variation on the canon variation")
)

// MaxVariationOrdinal is the current letter cap (Z). The column is an
// integer, so lifting this later (AA, AB, …) is a UI concern, not a schema
// change.
const MaxVariationOrdinal = 26

type Variation struct {
	VariationID       int       `json:"variation_id"`
	SnippetID         string    `json:"snippet_id"`
	Ordinal           *int      `json:"ordinal"` // nil = the hidden canon variation
	ParentVariationID *int      `json:"parent_variation_id,omitempty"`
	Text              string    `json:"text"`
	Frozen            bool      `json:"frozen"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

// VariationRef is the light form used for parent/children tab lists.
type VariationRef struct {
	VariationID int  `json:"variation_id"`
	Ordinal     *int `json:"ordinal"`
	Frozen      bool `json:"frozen"`
}

type SnippetInfo struct {
	SnippetID            string `json:"snippet_id"`
	LinkedManuscriptID   int    `json:"linked_manuscript_id"`
	LinkedManuscriptName string `json:"linked_manuscript_name"`
	CanonVariationID     int    `json:"canon_variation_id"` // 0 = none
}

// VariationContext is everything one widget needs in a single payload.
type VariationContext struct {
	Variation Variation      `json:"variation"`
	Snippet   SnippetInfo    `json:"snippet"`
	Parent    *VariationRef  `json:"parent,omitempty"`
	Children  []VariationRef `json:"children"`
	Canon     *Variation     `json:"canon,omitempty"` // text = as-canonized snapshot
}

// PickerVariation is one row of the Based-on / canonize pickers. Link and
// canon facts ride along so the canonize modal can grey out ineligible rows.
type PickerVariation struct {
	VariationID          int       `json:"variation_id"`
	SnippetID            string    `json:"snippet_id"`
	Ordinal              int       `json:"ordinal"`
	Preview              string    `json:"preview"`
	Frozen               bool      `json:"frozen"`
	UpdatedAt            time.Time `json:"updated_at"`
	LinkedManuscriptID   int       `json:"linked_manuscript_id"`
	LinkedManuscriptName string    `json:"linked_manuscript_name"`
	Canonized            bool      `json:"canonized"`
}

const snippetIDAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

// newSnippetID generates the globally-unique, slug-shaped snippet ID that
// also appears in the manuscript as &snippet#<id> (10 base36 chars ≈ 52
// bits — collision-free at any personal scale, retried on conflict anyway).
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
	var v Variation
	err := row.Scan(&v.VariationID, &v.SnippetID, &v.Ordinal, &v.ParentVariationID,
		&v.Text, &v.Frozen, &v.CreatedAt, &v.UpdatedAt)
	return v, err
}

const variationCols = `variation_id, snippet_id, ordinal, parent_variation_id, text, frozen, created_at, updated_at`

// CreateSnippet makes a fresh group: snippet row + variation A.
func (db *DB) CreateSnippet(ctx context.Context, userID string) (*VariationContext, error) {
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
	v, err := scanVariation(tx.QueryRow(ctx, `
		INSERT INTO variation (snippet_id, ordinal) VALUES ($1, 1)
		RETURNING `+variationCols, snippetID))
	if err != nil {
		return nil, fmt.Errorf("create variation A: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return db.GetVariationContext(ctx, userID, v.VariationID)
}

// CreateVariationFrom adds the next-letter variation based on source:
// text copied, parent recorded, source optionally frozen.
func (db *DB) CreateVariationFrom(ctx context.Context, userID string, sourceID int, freezeSource bool) (*VariationContext, error) {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var src Variation
	var owner string
	err = tx.QueryRow(ctx, `
		SELECT v.variation_id, v.snippet_id, v.ordinal, v.parent_variation_id, v.text, v.frozen, v.created_at, v.updated_at, s.user_id
		FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = $1 FOR UPDATE OF v
	`, sourceID).Scan(&src.VariationID, &src.SnippetID, &src.Ordinal, &src.ParentVariationID,
		&src.Text, &src.Frozen, &src.CreatedAt, &src.UpdatedAt, &owner)
	if err != nil {
		return nil, ErrNotOwner
	}
	if owner != userID {
		return nil, ErrNotOwner
	}
	if src.Ordinal == nil {
		return nil, ErrVariationNoLetter
	}
	var next int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(ordinal), 0) + 1 FROM variation WHERE snippet_id = $1
	`, src.SnippetID).Scan(&next); err != nil {
		return nil, err
	}
	if next > MaxVariationOrdinal {
		return nil, ErrOrdinalCap
	}
	v, err := scanVariation(tx.QueryRow(ctx, `
		INSERT INTO variation (snippet_id, ordinal, parent_variation_id, text)
		VALUES ($1, $2, $3, $4)
		RETURNING `+variationCols, src.SnippetID, next, sourceID, src.Text))
	if err != nil {
		return nil, fmt.Errorf("create variation: %w", err)
	}
	if freezeSource && !src.Frozen {
		if _, err := tx.Exec(ctx, `UPDATE variation SET frozen = true WHERE variation_id = $1`, sourceID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return db.GetVariationContext(ctx, userID, v.VariationID)
}

// GetVariationContext returns the widget payload: the variation, its group
// facts, parent/children refs, and the canon variation (when one exists).
func (db *DB) GetVariationContext(ctx context.Context, userID string, id int) (*VariationContext, error) {
	out := &VariationContext{Children: []VariationRef{}}
	var owner string
	var linkedID, canonID *int
	err := db.Pool.QueryRow(ctx, `
		SELECT v.variation_id, v.snippet_id, v.ordinal, v.parent_variation_id, v.text, v.frozen, v.created_at, v.updated_at,
		       s.user_id, s.linked_manuscript_id, s.linked_manuscript_name, s.canon_variation_id
		FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = $1
	`, id).Scan(&out.Variation.VariationID, &out.Variation.SnippetID, &out.Variation.Ordinal,
		&out.Variation.ParentVariationID, &out.Variation.Text, &out.Variation.Frozen,
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

	if out.Variation.ParentVariationID != nil {
		var ref VariationRef
		if err := db.Pool.QueryRow(ctx, `
			SELECT variation_id, ordinal, frozen FROM variation WHERE variation_id = $1
		`, *out.Variation.ParentVariationID).Scan(&ref.VariationID, &ref.Ordinal, &ref.Frozen); err == nil {
			out.Parent = &ref
		}
	}
	rows, err := db.Pool.Query(ctx, `
		SELECT variation_id, ordinal, frozen FROM variation
		WHERE parent_variation_id = $1 AND ordinal IS NOT NULL
		ORDER BY ordinal
	`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ref VariationRef
		if err := rows.Scan(&ref.VariationID, &ref.Ordinal, &ref.Frozen); err != nil {
			return nil, err
		}
		out.Children = append(out.Children, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, err
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

// UpdateVariationText autosaves an edit: refused while frozen (or canon),
// bumps updated_at, appends a revision (house pattern).
func (db *DB) UpdateVariationText(ctx context.Context, userID string, id int, text string) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var owner string
	var frozen bool
	var ordinal *int
	err = tx.QueryRow(ctx, `
		SELECT s.user_id, v.frozen, v.ordinal
		FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE v.variation_id = $1 FOR UPDATE OF v
	`, id).Scan(&owner, &frozen, &ordinal)
	if err != nil || owner != userID {
		return ErrNotOwner
	}
	if ordinal == nil {
		return ErrVariationCanon
	}
	if frozen {
		return ErrVariationFrozen
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

// SetVariationFrozen toggles the snowflake. The canon variation is
// permanently frozen — its snapshot is immutable by design.
func (db *DB) SetVariationFrozen(ctx context.Context, userID string, id int, frozen bool) error {
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
	_, err = db.Pool.Exec(ctx, `UPDATE variation SET frozen = $2 WHERE variation_id = $1`, id, frozen)
	return err
}

// ListVariationsForPicker feeds the Based-on picker: the user's lettered
// variations, most recently updated first. q filters on text.
func (db *DB) ListVariationsForPicker(ctx context.Context, userID, q string) ([]PickerVariation, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT v.variation_id, v.snippet_id, v.ordinal, LEFT(v.text, 160), v.frozen, v.updated_at,
		       COALESCE(s.linked_manuscript_id, 0), s.linked_manuscript_name,
		       (s.canon_variation_id IS NOT NULL) AS canonized
		FROM variation v JOIN snippet s ON s.snippet_id = v.snippet_id
		WHERE s.user_id = $1 AND v.ordinal IS NOT NULL
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
		if err := rows.Scan(&p.VariationID, &p.SnippetID, &p.Ordinal, &p.Preview, &p.Frozen, &p.UpdatedAt,
			&p.LinkedManuscriptID, &p.LinkedManuscriptName, &p.Canonized); err != nil {
			return nil, err
		}
		out = append(out, p)
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

// CanonizeVariation dubs a variation canon: creates the hidden canon
// variation (no letter, permanently frozen, text = the immutable
// as-canonized snapshot, parent = the dubbed variation), sets the group's
// canon pointer, and auto-links the group to the manuscript. The manuscript
// text itself is inserted client-side as a suggestion wrapping the text in
// &snippet#<snippet-id>{label} … &end#<snippet-id> (canon truth stays in
// the manuscript — VARIATIONS_PLAN.md §2).
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
		INSERT INTO variation (snippet_id, ordinal, parent_variation_id, text, frozen)
		VALUES ($1, NULL, $2, $3, true)
		RETURNING variation_id
	`, snippetID, variationID, text).Scan(&newCanonID); err != nil {
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

// CountCanonizedAmong reports how many of the given placed variations
// belong to a canonized group — the home card's ⧉ x/y badge.
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
