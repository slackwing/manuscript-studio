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
			got := normalizeText(tt.input)
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
