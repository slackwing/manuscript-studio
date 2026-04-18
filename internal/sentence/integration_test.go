package sentence

import (
	"os"
	"testing"
)

func TestTokenizer_RealManuscript(t *testing.T) {
	// Read the test sample of the actual manuscript
	content, err := os.ReadFile("../../manuscripts/the-wildfire-test-sample.md")
	if err != nil {
		t.Skipf("Skipping real manuscript test: %v", err)
		return
	}

	text := string(content)
	tokenizer := NewTokenizer()

	// Tokenize
	sentences := tokenizer.SplitIntoSentences(text)

	// Basic validation
	if len(sentences) == 0 {
		t.Fatal("Expected sentences to be extracted")
	}

	t.Logf("Extracted %d sentences from test manuscript", len(sentences))

	// Show first few sentences
	for i := 0; i < min(5, len(sentences)); i++ {
		t.Logf("Sentence %d: %q", i, sentences[i])
	}

	// Verify word counting works
	totalWords := 0
	for _, sent := range sentences {
		wordCount := CountWords(sent)
		totalWords += wordCount
	}

	t.Logf("Total word count: %d", totalWords)

	// Generate some IDs to verify they work
	commitHash := "test123abc"
	for i := 0; i < min(5, len(sentences)); i++ {
		id := GenerateSentenceID(sentences[i], i, commitHash)
		t.Logf("Sentence %d ID: %s", i, id)
	}
}
