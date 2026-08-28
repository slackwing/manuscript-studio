package models

import (
	"encoding/json"
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

// Manuscript storage modes (037-manuscript-registry).
const (
	StorageGitHub = "github" // synced clone of an external repo
	StorageLocal  = "local"  // server-owned repo under <repos_dir>/git/local/
)

type Manuscript struct {
	ManuscriptID int `json:"manuscript_id"`
	// Name is the unique slug (was implicit in config pre-037). Empty only
	// on legacy rows that predate startup reconciliation.
	Name string `json:"name"`
	// GitRepoPath is the clone URL for github mode; the sentinel
	// "local:<name>" for local mode (part of the row's unique identity —
	// it has never been a filesystem path despite the old repo_path name).
	GitRepoPath string `json:"git_repo_path"`
	FilePath    string `json:"file_path"`
	// Storage: StorageGitHub | StorageLocal.
	Storage string `json:"storage"`
	// GitRepoName keys into config's git_repos registry (github mode only).
	GitRepoName string `json:"git_repo_name,omitempty"`
	// GitBranch is the tracked branch; empty means "main".
	GitBranch string `json:"git_branch,omitempty"`
	// Human display name ("The Wildfire"); empty falls back to a prettified
	// slug (handlers.displayNameFor).
	DisplayName string    `json:"display_name"`
	CreatedAt   time.Time `json:"created_at"`
	// Birthday is the day writing began — distinct from CreatedAt because a
	// book can start on paper before entering the system. nil = never set.
	Birthday *time.Time `json:"birthday"`
	// WordGoal is the target length driving the stats-pane extrapolations.
	WordGoal int `json:"word_goal"`
}

// Branch returns the tracked branch, defaulting to "main".
func (m *Manuscript) Branch() string {
	if m.GitBranch == "" {
		return "main"
	}
	return m.GitBranch
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
	Ordinal            int       `json:"ordinal"`
	CreatedAt          time.Time `json:"created_at"`
	PreviousSentenceID *string   `json:"previous_sentence_id"` // null on bootstrap or new insertions
}

type Note struct {
	NoteID   int    `json:"note_id"`
	SentenceID   string `json:"sentence_id"`   // "" when the note has no sentence (DB col is nullable)
	ManuscriptID *int   `json:"manuscript_id"` // nullable context
	// ManuscriptName is NOT stored — the handler fills it from config at response
	// time (single source of truth, no denormalized drift). Empty when unlinked.
	ManuscriptName string `json:"manuscript_name,omitempty"`
	ScratchpadID   *int   `json:"scratchpad_id"` // nullable context
	// The sketch this note belongs to (026): every sketch mints ONE note
	// at creation. Set = the note is a sketch note (undeletable; wears the
	// derived, unremovable "sketch" chip).
	SketchID *string `json:"sketch_id"`
	UserID       string     `json:"user_id"`
	Color        string     `json:"color"`    // yellow, green, blue, purple, red, orange
	Body         *string    `json:"body"`
	Priority string `json:"priority"` // 'none' (non-tasks) | 'can' < 'would' < 'should' < 'must'
	// TaskType is the FIRST dimension: '' = untyped ('n/a', NULL in the DB,
	// the state of every new note). A type in the TASK category
	// (task_type.is_task) makes this a TASK, unlocking priority/impact/
	// blocked/points/completion; non-task types are plain categorization.
	// No type name is special in code.
	TaskType string `json:"task_type"`
	Impact   string `json:"impact"` // 'n/a' | 'sentence' | 'chapter' | 'novel' | 'recurring'
	// Blocked is an independent flag (NOT a priority): any priority/impact
	// can also be blocked on something else.
	Blocked bool `json:"blocked"`
	Position     string     `json:"position"` // fractional index
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	DeletedAt    *time.Time `json:"deleted_at"`
	CompletedAt  *time.Time `json:"completed_at"`
	// Points earned at completion. Terminology: a note with a priority
	// (P0–P3) is a TASK — only tasks can be completed, and completing one
	// may assign points (typed on the armed checkmark).
	Points *int  `json:"points"`
	Tags   []Tag `json:"tags"` // populated via JOIN; always serialize, even empty
	// Hidden is VIEWER-relative (note_hide, v3 multi-user notes): computed
	// per query, never stored on the note itself. Hidden notes render at
	// 50% opacity below unhidden ones; the owner never sees who hid.
	Hidden bool `json:"hidden"`
}

type Tag struct {
	TagID     int       `json:"tag_id"`
	TagName   string    `json:"tag_name"`
	UserID    string    `json:"user_id"`
	CreatedAt time.Time `json:"created_at"`
}

type NoteTag struct {
	NoteID    int       `json:"note_id"`
	TagID     int       `json:"tag_id"`
	CreatedAt time.Time `json:"created_at"`
}

// Suggestion review states (v3, PERMISSIONS_PLAN §4). NULL = unreviewed.
const (
	ReviewAccepted = "accepted"
	ReviewRejected = "rejected"
)

type SuggestedChange struct {
	SuggestionID int       `json:"suggestion_id"`
	SentenceID   string    `json:"sentence_id"`
	UserID       string    `json:"user_id"`
	Text         string    `json:"text"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	// ReviewStatus: nil = unreviewed; accepted/rejected otherwise. Editing
	// the text resets it. ReviewedBy/At record who decided.
	ReviewStatus *string    `json:"review_status"`
	ReviewedBy   string     `json:"reviewed_by,omitempty"`
	ReviewedAt   *time.Time `json:"reviewed_at,omitempty"`
	// Stale: carried across a migration onto a sentence whose text changed
	// — kept visible for review, but never rendered as a live diff.
	Stale bool `json:"stale"`
}

// SuggestionReviewEvent: one append-only history row per accept/reject
// verdict. Texts are snapshots taken at review time — the event stays
// readable after migrations rewrite or drop the sentence. ManuscriptName
// is display-only, filled by the handler from config (not stored).
type SuggestionReviewEvent struct {
	EventID        int64     `json:"event_id"`
	ManuscriptID   int       `json:"manuscript_id"`
	ManuscriptName string    `json:"manuscript_name,omitempty"`
	SentenceID     string    `json:"sentence_id"`
	OwnerID        string    `json:"owner_id"`
	ReviewerID     string    `json:"reviewer_id"`
	Status         string    `json:"status"`
	CommittedText  string    `json:"committed_text"`
	SuggestedText  string    `json:"suggested_text"`
	CreatedAt      time.Time `json:"created_at"`
}

type NoteVersion struct {
	NoteID              int       `json:"note_id"`
	Version             int       `json:"version"`
	SentenceID          string    `json:"sentence_id"`
	Color               string    `json:"color"`
	Body                *string   `json:"body"`
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

// Scratchpad (SCRATCHPAD_PLAN.md): DB-only, user-owned working material.
// Doc is the standard ProseMirror doc.toJSON().
type Scratchpad struct {
	ScratchpadID  int             `json:"scratchpad_id"`
	UserID        string          `json:"user_id"`
	Title         string          `json:"title"`
	Doc           json.RawMessage `json:"doc,omitempty"`
	SchemaVersion int             `json:"schema_version"`
	// LinkedManuscriptID is the pad's manuscript default (nullable). New notes
	// created in the pad inherit it. LinkedManuscriptName is NOT stored — the
	// handler resolves it from config at response time (single source of truth).
	LinkedManuscriptID   *int   `json:"linked_manuscript_id"`
	LinkedManuscriptName string `json:"linked_manuscript_name,omitempty"`
	CreatedAt            time.Time `json:"created_at"`
	UpdatedAt            time.Time `json:"updated_at"`
}

