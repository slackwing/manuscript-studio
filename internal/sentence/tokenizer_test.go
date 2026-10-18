package sentence

import (
	"strings"
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

// cleanSentenceBoundaries trims whitespace and NOTHING else: punctuation a
// sentence opens with is the author's (owner's reports — em dash
// 2026-10-11, ellipsis 2026-10-18; the strip also dropped it from the file
// on the next push).
func TestCleanSentenceBoundariesMultibyte(t *testing.T) {
	cases := []struct{ in, want string }{
		{"—He paused.", "—He paused."},                       // em-dash kept
		{"— He paused.", "— He paused."},                     // em-dash + space kept
		{"“Hello,” she said.", "“Hello,” she said."},         // opening curly quote preserved
		{"„Guten Tag.“", "„Guten Tag.“"},                     // low-9 quote preserved
		{"...And then it went.", "...And then it went."},     // ellipsis kept
		{"…And then.", "…And then."},                         // the ellipsis character kept
		{". Stray period lead-in", ". Stray period lead-in"}, // nothing is stripped any more
		{"-dash lead", "-dash lead"},
		{"  padded  ", "padded"}, // whitespace only
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

// Leading punctuation survives the whole loop (2026-10-18): no character
// of the source is ever lost — every row round-trips byte-equal — and a
// segment segman opens on punctuation keeps it ("\n\t...And then"). A
// segment GLUED to the previous one (no whitespace: segman cut mid-run, as
// in the fixture's "[something]." and "'Sup'—\", Jaime said") joins that
// sentence verbatim instead of losing its punctuation. A suggestion that
// opens on "..." keeps it through push (RebuildManuscript) + re-migration.
func TestLeadingPunctuationKept(t *testing.T) {
	tk := NewTokenizer()
	cases := []struct {
		src  string
		rows []string // nil = only the byte-exact round trip is asserted
	}{
		{"Then.\n\t...And then it went.\n", []string{"Then.", "\n\t...And then it went."}},
		{"Then.\n\n...A section opens on an ellipsis.\n", []string{"Then.", "\n\n...A section opens on an ellipsis."}},
		{"...Opening on an ellipsis. Next.\n", []string{"...Opening on an ellipsis.", "Next."}},
		{"Then. ...And then it went.\n", nil}, // mid-paragraph: segman's call — nothing lost
		// The fixture's glued artifacts (test.manuscript).
		{"through a tangle of indirection, as if to [something]. Now that it invites us though, let me fill in the beginning.\n", nil},
		{"\"He'd say, 'Sup'—\", Jaime said, imitating Kostya's deeper voice and accent, \"—'Beer? Johnny Walker?'\"\n", nil},
	}
	for _, c := range cases {
		got := tk.TokenizeWithMarkers(c.src)
		if c.rows != nil && strings.Join(got, "|") != strings.Join(c.rows, "|") {
			t.Errorf("TokenizeWithMarkers(%q) = %q, want %q", c.src, got, c.rows)
		}
		if back := Reconstruct(got); back != c.src {
			t.Errorf("round trip lost bytes:\n  src:  %q\n  rows: %q\n  back: %q", c.src, got, back)
		}
		if plain := tk.SplitIntoSentences(c.src); len(plain) != len(got) {
			t.Errorf("SplitIntoSentences(%q) = %q — out of lockstep with %q", c.src, plain, got)
		}
	}

	// A suggestion opening a paragraph on "..." → push → migration keeps it.
	file := RebuildManuscript([]string{"a", "b"},
		map[string]string{"a": "Then.", "b": "\n\tAnd then it went."},
		map[string]string{"b": "\n\t...And then it went."})
	rows := tk.TokenizeWithMarkers(file)
	if len(rows) != 2 || rows[1] != "\n\t...And then it went." {
		t.Errorf("suggested ellipsis after push + migration = %q (file %q)", rows, file)
	}
}
