package models

import (
	"time"
)

// User represents a user with authentication credentials
type User struct {
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"` // Never expose password hash in JSON
	Role         string    `json:"role"`
	CreatedAt    time.Time `json:"created_at"`
}

// ManuscriptAccess represents user access to a manuscript
type ManuscriptAccess struct {
	Username       string    `json:"username"`
	ManuscriptName string    `json:"manuscript_name"`
	CreatedAt      time.Time `json:"created_at"`
}

// Manuscript represents a manuscript being tracked
type Manuscript struct {
	ManuscriptID int       `json:"manuscript_id"`
	RepoPath     string    `json:"repo_path"`
	FilePath     string    `json:"file_path"`
	CreatedAt    time.Time `json:"created_at"`
}

// MigrationStatus values. A migration row's lifecycle is:
//   pending -> running -> done   (success path)
//   pending -> running -> error  (failure path, with .Error populated)
// Existing rows from before the status column was added default to "done".
const (
	MigrationStatusPending = "pending"
	MigrationStatusRunning = "running"
	MigrationStatusDone    = "done"
	MigrationStatusError   = "error"
)

// Migration represents a processed git commit with specific segmenter version.
// Each row represents an attempted (and possibly completed) state transition.
//
// Most result fields (BranchName, SentenceCount, *_Count, SentenceIDArray)
// are zero-valued until Status == "done". Consumers that read those fields
// must filter on Status.
type Migration struct {
	MigrationID       int        `json:"migration_id"`
	ManuscriptID      int        `json:"manuscript_id"`
	CommitHash        string     `json:"commit_hash"`
	Segmenter         string     `json:"segmenter"` // e.g. "segman-1.0.0"
	ParentMigrationID *int       `json:"parent_migration_id"`
	BranchName        string     `json:"branch_name"`
	ProcessedAt       time.Time  `json:"processed_at"`
	Status            string     `json:"status"`
	StartedAt         *time.Time `json:"started_at,omitempty"`
	FinishedAt        *time.Time `json:"finished_at,omitempty"`
	Error             *string    `json:"error,omitempty"`
	SentenceCount     int        `json:"sentence_count"`
	AdditionsCount    int        `json:"additions_count"`
	DeletionsCount    int        `json:"deletions_count"`
	ChangesCount      int        `json:"changes_count"`
	SentenceIDArray   []string   `json:"sentence_id_array"`
}

// Sentence represents a sentence instance in a specific migration
type Sentence struct {
	SentenceID  string    `json:"sentence_id"`
	MigrationID int       `json:"migration_id"` // FK to migration.migration_id
	CommitHash  string    `json:"commit_hash"`  // Denormalized for readability
	Text        string    `json:"text"`
	WordCount   int       `json:"word_count"`
	Ordinal     int       `json:"ordinal"`
	CreatedAt   time.Time `json:"created_at"`
}

// Annotation represents a user annotation (simplified: all based on highlights with color).
// Types faithful to 14.writesys: Priority/Position are strings, Note is *string.
type Annotation struct {
	AnnotationID int        `json:"annotation_id"`
	SentenceID   string     `json:"sentence_id"`
	UserID       string     `json:"user_id"` // This is username (VARCHAR)
	Color        string     `json:"color"`   // Required: yellow, green, blue, purple, red, orange
	Note         *string    `json:"note"`    // Optional
	Priority     string     `json:"priority"` // 'none', 'P0', 'P1', 'P2', 'P3'
	Flagged      bool       `json:"flagged"`
	Position     string     `json:"position"` // Fractional index for ordering annotations
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	DeletedAt    *time.Time `json:"deleted_at"`
	Tags         []Tag      `json:"tags"` // Populated via JOIN - always serialize, even if empty
}

// Tag represents a tag that can be applied to annotations
type Tag struct {
	TagID       int       `json:"tag_id"`
	TagName     string    `json:"tag_name"`
	MigrationID int       `json:"migration_id"`
	CreatedAt   time.Time `json:"created_at"`
}

// AnnotationTag represents the many-to-many relationship between annotations and tags
type AnnotationTag struct {
	AnnotationID int       `json:"annotation_id"`
	TagID        int       `json:"tag_id"`
	CreatedAt    time.Time `json:"created_at"`
}

// AnnotationVersion represents a version of an annotation.
// Types faithful to 14.writesys.
type AnnotationVersion struct {
	AnnotationID        int       `json:"annotation_id"`
	Version             int       `json:"version"`
	SentenceID          string    `json:"sentence_id"`
	Color               string    `json:"color"`
	Note                *string   `json:"note"`
	Priority            string    `json:"priority"`
	Flagged             bool      `json:"flagged"`
	SentenceIDHistory   []string  `json:"sentence_id_history"`
	MigrationConfidence *float64  `json:"migration_confidence"`
	OriginSentenceID    string    `json:"origin_sentence_id"`
	OriginMigrationID   *int      `json:"origin_migration_id"` // FK to migration.migration_id
	OriginCommitHash    string    `json:"origin_commit_hash"`  // Denormalized
	CreatedAt           time.Time `json:"created_at"`
	CreatedBy           string    `json:"created_by"`
}
