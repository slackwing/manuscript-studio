package database

// queries.go was the package's 2,478-line god-file. It was split (2026-08,
// CODE_REVIEW_AUG_2026.md §2.1) into cohesive files — pure code motion, one
// package, zero behavior change:
//
//	manuscripts.go      manuscript rows
//	migrations_store.go migration lifecycle rows
//	sentences.go        sentence rows + command-slug index
//	suggestions.go      suggested_change rows
//	notes.go            note + note_version rows (incl. reorder, lifecycle)
//	tags.go             tag + note_tag rows
//	users_access.go     user rows + manuscript_access grants
//	home_notes.go       HomeNote readers (landing grid, daily tasks)
//	tasktypes.go        task_type rows (031/032)
//	note_actions.go     point events + settings audit table
//	daily_rules.go      daily_rule rows + the pure in-memory rule engine
//
// The shared DB type lives in db.go; variations in variations.go;
// scratchpads in scratchpads.go; wordcount in wordcount.go.
