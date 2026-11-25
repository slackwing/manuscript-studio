package database

// Boards (059, BOARDS_PLAN.md): a user's saved view of their notes — a name,
// the manuscripts it looks at (empty = all) and rules (daily_rule rows with
// board_id). The board page lists the live, uncompleted notes the viewer
// owns that match: no rules → every one; else a note shows when ANY rule
// matches it (a rule ANDs its selectors; max_per_day caps how many notes
// that rule admits, -1 = unlimited). Newest-updated first.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

type Board struct {
	BoardID       int       `json:"board_id"`
	Name          string    `json:"name"`
	ManuscriptIDs []int     `json:"manuscript_ids"`
	Sort          string    `json:"sort"` // 060: "recent" | "manuscript"
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// BoardSorts: the sort orders a board offers (see SortBoardNotes).
var BoardSorts = map[string]bool{"recent": true, "manuscript": true}

func (db *DB) ListBoards(ctx context.Context, username string) ([]Board, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT board_id, name, manuscript_ids, sort, created_at, updated_at
		FROM board WHERE user_id = $1 AND deleted_at IS NULL
		ORDER BY created_at, board_id`, username)
	if err != nil {
		return nil, fmt.Errorf("list boards: %w", err)
	}
	defer rows.Close()
	out := []Board{}
	for rows.Next() {
		var b Board
		if err := rows.Scan(&b.BoardID, &b.Name, &b.ManuscriptIDs, &b.Sort, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan board: %w", err)
		}
		if b.ManuscriptIDs == nil {
			b.ManuscriptIDs = []int{}
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// GetBoard: the viewer's live board, or nil.
func (db *DB) GetBoard(ctx context.Context, username string, boardID int) (*Board, error) {
	var b Board
	err := db.Pool.QueryRow(ctx, `
		SELECT board_id, name, manuscript_ids, sort, created_at, updated_at
		FROM board WHERE board_id = $1 AND user_id = $2 AND deleted_at IS NULL`, boardID, username).
		Scan(&b.BoardID, &b.Name, &b.ManuscriptIDs, &b.Sort, &b.CreatedAt, &b.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("get board %d: %w", boardID, err)
	}
	if b.ManuscriptIDs == nil {
		b.ManuscriptIDs = []int{}
	}
	return &b, nil
}

func (db *DB) CreateBoard(ctx context.Context, username, name string, manuscriptIDs []int) (*Board, error) {
	if manuscriptIDs == nil {
		manuscriptIDs = []int{}
	}
	var id int
	if err := db.Pool.QueryRow(ctx, `
		INSERT INTO board (user_id, name, manuscript_ids) VALUES ($1, $2, $3) RETURNING board_id`,
		username, name, manuscriptIDs).Scan(&id); err != nil {
		return nil, fmt.Errorf("create board: %w", err)
	}
	return db.GetBoard(ctx, username, id)
}

// UpdateBoard patches name, manuscript_ids and/or sort (nil = unchanged).
func (db *DB) UpdateBoard(ctx context.Context, username string, boardID int, name *string, manuscriptIDs []int, sortOrder *string) (*Board, error) {
	if _, err := db.Pool.Exec(ctx, `
		UPDATE board SET name = COALESCE($3, name),
		                 manuscript_ids = COALESCE($4, manuscript_ids),
		                 sort = COALESCE($5, sort),
		                 updated_at = now()
		WHERE board_id = $1 AND user_id = $2 AND deleted_at IS NULL`, boardID, username, name, manuscriptIDs, sortOrder); err != nil {
		return nil, fmt.Errorf("update board %d: %w", boardID, err)
	}
	return db.GetBoard(ctx, username, boardID)
}

func (db *DB) DeleteBoard(ctx context.Context, username string, boardID int) (bool, error) {
	tag, err := db.Pool.Exec(ctx, `UPDATE board SET deleted_at = now() WHERE board_id = $1 AND user_id = $2 AND deleted_at IS NULL`, boardID, username)
	if err != nil {
		return false, fmt.Errorf("delete board %d: %w", boardID, err)
	}
	return tag.RowsAffected() > 0, nil
}

// ListBoardNotes: the viewer's live, uncompleted notes on the board's
// manuscripts (a note's manuscript is its stamped manuscript_id, else the
// book of its primary sentence placement; an empty board list means all),
// newest-updated first, BEFORE the rules — ApplyBoardRules cuts them.
func (db *DB) ListBoardNotes(ctx context.Context, username string, b *Board) ([]HomeNote, error) {
	rows, err := db.Pool.Query(ctx, homeNoteSelect+`,
		       (SELECT t.touched_at FROM note_touch t WHERE t.note_id = n.note_id AND t.username = $1) AS touched_at,
		       ps.manuscript_id, ps.migration_id, ps.ordinal`+homeNoteFrom+`
		LEFT JOIN LATERAL (
		    SELECT s.ordinal, s.migration_id, mg.manuscript_id
		    FROM sentence s JOIN migration mg ON mg.migration_id = s.migration_id
		    WHERE s.sentence_id = place.sentence_id
		) ps ON true
		WHERE n.user_id = $1
		  AND n.deleted_at IS NULL
		  AND n.completed_at IS NULL
		  AND (cardinality($2::int[]) = 0 OR COALESCE(n.manuscript_id, ps.manuscript_id) = ANY($2::int[]))
		ORDER BY n.updated_at DESC
	`, username, b.ManuscriptIDs)
	if err != nil {
		return nil, fmt.Errorf("list board notes: %w", err)
	}
	defer rows.Close()
	var out []HomeNote
	for rows.Next() {
		var h HomeNote
		var tagsJSON []byte
		if err := rows.Scan(&h.NoteID, &h.Color, &h.Body, &h.DefaultBody, &h.Priority, &h.TaskType, &h.Impact, &h.Blocked, &h.UpdatedAt,
			&h.ManuscriptID, &h.ScratchpadID, &h.SentenceID, &h.Context, &h.ScratchpadTitle, &h.SketchID, &tagsJSON, &h.CompletedAt, &h.PinnedAt,
			&h.TouchedAt, &h.PlacedManuscriptID, &h.PlaceMigrationID, &h.PlaceOrdinal); err != nil {
			return nil, fmt.Errorf("scan board note: %w", err)
		}
		if len(tagsJSON) > 0 {
			_ = json.Unmarshal(tagsJSON, &h.Tags)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// ApplyBoardRules: no rules → every candidate; else a candidate shows when
// some rule matches it and that rule still has quota (max_per_day; -1 =
// unlimited). Order is preserved.
func ApplyBoardRules(rules []DailyRule, candidates []HomeNote) []HomeNote {
	if len(rules) == 0 {
		return candidates
	}
	quota := make([]int, len(rules))
	for i, r := range rules {
		quota[i] = r.MaxPerDay
	}
	out := []HomeNote{}
	for _, n := range candidates {
		for i, r := range rules {
			if !ruleMatches(r, n) || quota[i] == 0 {
				continue
			}
			if quota[i] > 0 {
				quota[i]--
			}
			out = append(out, n)
			break
		}
	}
	return out
}

// SortBoardNotes (060) orders a board's notes AFTER its rules:
//   - "recent": the viewer's last-touched notes first (newest touch first —
//     note_touch holds at most 3), then newest-updated — the ↗ picker's order;
//   - "manuscript": notes placed on a sentence first, by manuscript (the
//     board's picked order, else id), the current text before older
//     versions, then sentence order; then everything else in "recent" order.
func SortBoardNotes(b *Board, notes []HomeNote) {
	rank := map[int]int{}
	for i, id := range b.ManuscriptIDs {
		rank[id] = i
	}
	recentLess := func(a, c *HomeNote) bool {
		switch {
		case a.TouchedAt != nil && c.TouchedAt == nil:
			return true
		case a.TouchedAt == nil && c.TouchedAt != nil:
			return false
		case a.TouchedAt != nil && c.TouchedAt != nil && !a.TouchedAt.Equal(*c.TouchedAt):
			return a.TouchedAt.After(*c.TouchedAt)
		}
		return a.UpdatedAt.After(c.UpdatedAt)
	}
	sort.SliceStable(notes, func(i, j int) bool {
		a, c := &notes[i], &notes[j]
		if b.Sort == "manuscript" {
			ap, cp := a.PlaceOrdinal != nil, c.PlaceOrdinal != nil
			if ap != cp {
				return ap
			}
			if ap {
				am, cm := *a.PlacedManuscriptID, *c.PlacedManuscriptID
				if am != cm {
					ra, oka := rank[am]
					rc, okc := rank[cm]
					if oka != okc {
						return oka
					}
					if oka && ra != rc {
						return ra < rc
					}
					return am < cm
				}
				if *a.PlaceMigrationID != *c.PlaceMigrationID {
					return *a.PlaceMigrationID > *c.PlaceMigrationID
				}
				if *a.PlaceOrdinal != *c.PlaceOrdinal {
					return *a.PlaceOrdinal < *c.PlaceOrdinal
				}
			}
		}
		return recentLess(a, c)
	})
}

// BoardNotes: the board's page — ListBoardNotes under the board's rules,
// in the board's sort.
func (db *DB) BoardNotes(ctx context.Context, username string, b *Board) ([]HomeNote, error) {
	candidates, err := db.ListBoardNotes(ctx, username, b)
	if err != nil {
		return nil, err
	}
	rules, err := db.ListBoardRules(ctx, username, b.BoardID)
	if err != nil {
		return nil, err
	}
	out := ApplyBoardRules(rules, candidates)
	SortBoardNotes(b, out)
	return out, nil
}
