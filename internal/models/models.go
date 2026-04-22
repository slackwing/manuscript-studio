package models

import (
	"time"
)

type User struct {
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	Role         string    `json:"role"`
	CreatedAt    time.Time `json:"created_at"`
}

type ManuscriptAccess struct {
	Username       string    `json:"username"`
	ManuscriptName string    `json:"manuscript_name"`
	CreatedAt      time.Time `json:"created_at"`
}

type Manuscript struct {
	ManuscriptID int       `json:"manuscript_id"`
	RepoPath     string    `json:"repo_path"`
	FilePath     string    `json:"file_path"`
	CreatedAt    time.Time `json:"created_at"`
}

// Lifecycle: pending → running → done | error (.Error set on error).
const (
	MigrationStatusPending = "pending"
	MigrationStatusRunning = "running"
	MigrationStatusDone    = "done"
	MigrationStatusError   = "error"
)

// Result fields (BranchName, SentenceCount, *_Count, SentenceIDArray) are
// zero until Status == "done"; consumers must filter.
type Migration struct {
	MigrationID       int        `json:"migration_id"`
	ManuscriptID      int        `json:"manuscript_id"`
	CommitHash        string     `json:"commit_hash"`
	Segmenter         string     `json:"segmenter"`
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

type Sentence struct {
	SentenceID         string    `json:"sentence_id"`
	MigrationID        int       `json:"migration_id"`
	CommitHash         string    `json:"commit_hash"`
	Text               string    `json:"text"`
	WordCount          int       `json:"word_count"`
	Ordinal            int       `json:"ordinal"`
	CreatedAt          time.Time `json:"created_at"`
	PreviousSentenceID *string   `json:"previous_sentence_id"` // null on bootstrap or new insertions
}

type Annotation struct {
	AnnotationID int        `json:"annotation_id"`
	SentenceID   string     `json:"sentence_id"`
	UserID       string     `json:"user_id"`
	Color        string     `json:"color"`    // yellow, green, blue, purple, red, orange
	Note         *string    `json:"note"`
	Priority     string     `json:"priority"` // 'none', 'P0', 'P1', 'P2', 'P3'
	Flagged      bool       `json:"flagged"`
	Position     string     `json:"position"` // fractional index
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	DeletedAt    *time.Time `json:"deleted_at"`
	CompletedAt  *time.Time `json:"completed_at"`
	Tags         []Tag      `json:"tags"` // populated via JOIN; always serialize, even empty
}

type Tag struct {
	TagID       int       `json:"tag_id"`
	TagName     string    `json:"tag_name"`
	MigrationID int       `json:"migration_id"`
	CreatedAt   time.Time `json:"created_at"`
}

type AnnotationTag struct {
	AnnotationID int       `json:"annotation_id"`
	TagID        int       `json:"tag_id"`
	CreatedAt    time.Time `json:"created_at"`
}

type SuggestedChange struct {
	SuggestionID int       `json:"suggestion_id"`
	SentenceID   string    `json:"sentence_id"`
	UserID       string    `json:"user_id"`
	Text         string    `json:"text"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

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
	OriginMigrationID   *int      `json:"origin_migration_id"`
	OriginCommitHash    string    `json:"origin_commit_hash"`
	CreatedAt           time.Time `json:"created_at"`
	CreatedBy           string    `json:"created_by"`
}
