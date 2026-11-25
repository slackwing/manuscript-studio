package database

import (
	"context"
	"fmt"
	"log"

	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// BackfillPlaceholderDetailNotes (2026-11-25, PLACEHOLDER_PLAN.md v2): the
// &placeholder grammar lost its {details} arg — what a placeholder is meant
// to become is a sticky note ON it now. For every manuscript's latest done
// migration, each placeholder token still carrying details under the old
// grammar gets a yellow note with that text, placed on the token's sentence
// and owned by the manuscript's author (first "author" role, else first
// "admin"). Idempotent: a live note with that exact body already on that
// sentence means it was done. Returns how many notes it created.
//
// The lines themselves stay the author's to trim (a four-arg placeholder
// prints literally in the book until they do); when they trim, the sentence
// changes and the migration carries the note along like any other.
func (db *DB) BackfillPlaceholderDetailNotes(ctx context.Context) (int, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT mg.manuscript_id, mg.migration_id
		FROM migration mg
		WHERE mg.migration_id IN (SELECT max(migration_id) FROM migration WHERE status = 'done' GROUP BY manuscript_id)
		ORDER BY mg.manuscript_id
	`)
	if err != nil {
		return 0, fmt.Errorf("placeholder details backfill: list migrations: %w", err)
	}
	type head struct{ manuscriptID, migrationID int }
	var heads []head
	for rows.Next() {
		var h head
		if err := rows.Scan(&h.manuscriptID, &h.migrationID); err != nil {
			rows.Close()
			return 0, err
		}
		heads = append(heads, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	created := 0
	for _, h := range heads {
		type ph struct {
			sentenceID string
			details    []string
		}
		var work []ph
		srows, err := db.Pool.Query(ctx, `
			SELECT sentence_id, text FROM sentence
			WHERE migration_id = $1 AND text LIKE '%&placeholder%'
			ORDER BY ordinal
		`, h.migrationID)
		if err != nil {
			return created, fmt.Errorf("placeholder details backfill: sentences of %d: %w", h.migrationID, err)
		}
		for srows.Next() {
			var sid, text string
			if err := srows.Scan(&sid, &text); err != nil {
				srows.Close()
				return created, err
			}
			if d := sentence.LegacyPlaceholderDetails(text); len(d) > 0 {
				work = append(work, ph{sid, d})
			}
		}
		srows.Close()
		if err := srows.Err(); err != nil {
			return created, err
		}
		if len(work) == 0 {
			continue
		}

		var owner string
		err = db.Pool.QueryRow(ctx, `
			SELECT username FROM role WHERE manuscript_id = $1 AND role = 'author' ORDER BY username LIMIT 1
		`, h.manuscriptID).Scan(&owner)
		if err != nil {
			err = db.Pool.QueryRow(ctx, `
				SELECT username FROM role WHERE manuscript_id = $1 AND role = 'admin' ORDER BY username LIMIT 1
			`, h.manuscriptID).Scan(&owner)
		}
		if err != nil || owner == "" {
			log.Printf("placeholder details backfill: manuscript %d has %d placeholder detail(s) but no author/admin role — skipped", h.manuscriptID, len(work))
			continue
		}

		for _, w := range work {
			for _, details := range w.details {
				var exists bool
				if err := db.Pool.QueryRow(ctx, `
					SELECT EXISTS (
						SELECT 1 FROM note n JOIN note_sentence ns USING (note_id)
						WHERE ns.sentence_id = $1 AND n.deleted_at IS NULL AND n.body = $2
					)
				`, w.sentenceID, details).Scan(&exists); err != nil {
					return created, fmt.Errorf("placeholder details backfill: check %s: %w", w.sentenceID, err)
				}
				if exists {
					continue
				}
				body := details
				note := &models.Note{
					SentenceID: w.sentenceID, UserID: owner,
					Color: "yellow", Body: &body, Priority: "none", Impact: "n/a",
				}
				if err := db.CreateNote(ctx, note, &models.NoteVersion{}); err != nil {
					return created, fmt.Errorf("placeholder details backfill: note on %s: %w", w.sentenceID, err)
				}
				created++
			}
		}
	}
	return created, nil
}
