package sentence

import (
	"testing"
)

func TestSplitIntoSentences(t *testing.T) {
	tokenizer := NewTokenizer()

	tests := []struct {
		name     string
		input    string
		expected []string
	}{
		{
			name:     "Simple sentence",
			input:    "Kostya looked around.",
			expected: []string{"Kostya looked around."},
		},
		{
			name:     "Multiple sentences",
			input:    "Kostya looked around. It was empty. He left.",
			expected: []string{"Kostya looked around.", "It was empty.", "He left."},
		},
		{
			name:     "Dialogue with interruption",
			input:    `"I can't," he said, "believe this."`,
			expected: []string{`"I can't," he said, "believe this."`},
		},
		{
			name:     "Stylistic fragments",
			input:    "Gone. All of it.",
			expected: []string{"Gone.", "All of it."},
		},
		{
			name:     "Question and exclamation",
			input:    "What happened? Nothing!",
			expected: []string{"What happened?", "Nothing!"},
		},
		{
			name:     "Em-dash interruption",
			input:    "She turned—quickly, too quickly—toward the door.",
			expected: []string{"She turned—quickly, too quickly—toward the door."},
		},
		{
			name:     "Single word",
			input:    "V",
			expected: []string{"V"},
		},
		{
			name:     "Empty text",
			input:    "",
			expected: []string{},
		},
		{
			name:     "Whitespace only",
			input:    "   \n\t  ",
			expected: []string{},
		},
		{
			name:     "Paragraph with multiple sentences",
			input:    "The sun was setting. Birds chirped in the distance. It was peaceful.",
			expected: []string{"The sun was setting.", "Birds chirped in the distance.", "It was peaceful."},
		},
		{
			name:     "Abbreviations (should handle correctly)",
			input:    "Dr. Smith arrived at 3 p.m. yesterday.",
			expected: []string{"Dr. Smith arrived at 3 p.m. yesterday."},
		},
		{
			name:     "Ellipsis continuation lowercase",
			input:    "He wondered... could it be true?",
			expected: []string{"He wondered... could it be true?"},
		},
		{
			name:     "Multiple exclamations",
			input:    "No! Stop! Wait!",
			expected: []string{"No!", "Stop!", "Wait!"},
		},
		{
			name:     "Dialogue at start",
			input:    `"Hello," she said.`,
			expected: []string{`"Hello," she said.`},
		},
		{
			name:     "Mixed punctuation",
			input:    "Is this real? Yes. Absolutely!",
			expected: []string{"Is this real?", "Yes.", "Absolutely!"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tokenizer.SplitIntoSentences(tt.input)

			if len(got) != len(tt.expected) {
				t.Errorf("Expected %d sentences, got %d\nExpected: %v\nGot: %v",
					len(tt.expected), len(got), tt.expected, got)
				return
			}

			for i := range got {
				if got[i] != tt.expected[i] {
					t.Errorf("Sentence %d mismatch:\nExpected: %q\nGot: %q",
						i, tt.expected[i], got[i])
				}
			}
		})
	}
}

func TestNormalizeText(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "Remove punctuation",
			input:    "Hello, world!",
			expected: "hello world",
		},
		{
			name:     "Lowercase",
			input:    "KOSTYA Looked Around",
			expected: "kostya looked around",
		},
		{
			name:     "Multiple spaces",
			input:    "Hello    world",
			expected: "hello world",
		},
		{
			name:     "Trim spaces",
			input:    "  hello world  ",
			expected: "hello world",
		},
		{
			name:     "Mixed case and punctuation",
			input:    "She said, \"Hello!\"",
			expected: "she said hello",
		},
		{
			name:     "Numbers preserved",
			input:    "Room 101",
			expected: "room 101",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := NormalizeText(tt.input)
			if got != tt.expected {
				t.Errorf("Expected %q, got %q", tt.expected, got)
			}
		})
	}
}

func TestExtractWords(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []string
	}{
		{
			name:     "Simple sentence",
			input:    "Kostya looked around.",
			expected: []string{"kostya", "looked", "around"},
		},
		{
			name:     "Single word",
			input:    "V",
			expected: []string{"v"},
		},
		{
			name:     "With punctuation",
			input:    "Gone. All of it.",
			expected: []string{"gone", "all", "of", "it"},
		},
		{
			name:     "Empty string",
			input:    "",
			expected: []string{},
		},
		{
			name:     "Numbers included",
			input:    "Room 101",
			expected: []string{"room", "101"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractWords(tt.input)

			if len(got) != len(tt.expected) {
				t.Errorf("Expected %d words, got %d\nExpected: %v\nGot: %v",
					len(tt.expected), len(got), tt.expected, got)
				return
			}

			for i := range got {
				if got[i] != tt.expected[i] {
					t.Errorf("Word %d mismatch: expected %q, got %q",
						i, tt.expected[i], got[i])
				}
			}
		})
	}
}

// Regression: a failed locateSegment used to poison cursor with -1, and the
// next call indexed source[-1] — a panic that killed the whole server since
// migrations run in a bare goroutine.
func TestLocateSegmentNegativeCursorDoesNotPanic(t *testing.T) {
	start, end := locateSegment("some source text", -1, "source")
	if start < 0 || end < 0 {
		t.Fatalf("expected to find segment from clamped cursor, got (%d, %d)", start, end)
	}
}

// Regression: rune(trimmed[0]) decoded only the first byte, so the
// curly-quote guards never fired on their own comparisons. A leading em
// dash is PROSE, not a joining artifact — it stays (owner's report,
// 2026-10-11: suggested sentences opening with "—" lost the dash; the
// 2026-07-24 rune fix had turned on a strip that was dead code before).
func TestCleanSentenceBoundariesMultibyte(t *testing.T) {
	cases := []struct{ in, want string }{
		{"—He paused.", "—He paused."},                     // em-dash kept
		{"— He paused.", "— He paused."},                   // em-dash + space kept
		{"“Hello,” she said.", "“Hello,” she said."},       // opening curly quote preserved
		{"„Guten Tag.“", "„Guten Tag.“"},                   // low-9 quote preserved
		{". Stray period lead-in", "Stray period lead-in"}, // ASCII path unchanged
		{"-dash lead", "dash lead"},                        // ASCII dash unchanged
	}
	for _, c := range cases {
		if got := cleanSentenceBoundaries(c.in); got != c.want {
			t.Errorf("cleanSentenceBoundaries(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// A sentence that opens with an em dash survives the whole loop: segman
// keeps the dash on its segment (paragraph, section, file start — mid-
// paragraph ". —" is one sentence to segman, dash intact), the migration's
// tokenizer must too, the rows reconstruct byte-equal, and a SUGGESTED
// dash-led sentence comes back from push (RebuildManuscript) + re-migration
// with its dash. Before the fix the rows lost it, and the next push rebuilt
// the file from those rows — the dash left git too.
func TestEmDashLeadSurvivesTokenizeRebuild(t *testing.T) {
	tk := NewTokenizer()
	src := "—The file opens on a dash. Before it.\n\t—He paused, then went on.\n\n—A section opens on a dash.\n"
	got := tk.TokenizeWithMarkers(src)
	want := []string{"—The file opens on a dash.", "Before it.", "\n\t—He paused, then went on.", "\n\n—A section opens on a dash."}
	if len(got) != len(want) {
		t.Fatalf("TokenizeWithMarkers = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("sentence %d = %q, want %q", i, got[i], want[i])
		}
	}
	if back := Reconstruct(got); back != src {
		t.Errorf("round trip lost bytes:\n  src:  %q\n  back: %q", src, back)
	}

	// Push → PR file → re-migration.
	ids := []string{"a", "b"}
	committed := map[string]string{"a": "Before it.", "b": "\n\tHe paused."}
	sugs := map[string]string{"b": "\n\t—He paused, the dash his own."}
	file := RebuildManuscript(ids, committed, sugs)
	rows := tk.TokenizeWithMarkers(file)
	if len(rows) != 2 || rows[1] != "\n\t—He paused, the dash his own." {
		t.Errorf("suggested dash lead after push + migration = %q (file %q)", rows, file)
	}
}
