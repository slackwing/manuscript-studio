package sentence

import (
	"strings"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/models"
)

func TestApplySuggestions(t *testing.T) {
	t.Run("no suggestions is a no-op", func(t *testing.T) {
		src := []byte("Hello world.\n")
		out, results := ApplySuggestions(src, nil, nil)
		if string(out) != string(src) {
			t.Fatalf("expected unchanged, got %q", out)
		}
		if len(results) != 0 {
			t.Fatalf("expected no results, got %d", len(results))
		}
	})

	t.Run("single substring replace", func(t *testing.T) {
		src := []byte("Hello world. Goodbye world.\n")
		suggestions := []models.SuggestedChange{
			{SentenceID: "s1", Text: "Hello, friend."},
		}
		originals := map[string]string{"s1": "Hello world."}
		out, results := ApplySuggestions(src, suggestions, originals)
		if string(out) != "Hello, friend. Goodbye world.\n" {
			t.Fatalf("got %q", out)
		}
		if !results[0].Applied {
			t.Fatalf("expected Applied=true, got %+v", results[0])
		}
	})

	t.Run("first occurrence only", func(t *testing.T) {
		src := []byte("Same. Same.\n")
		out, _ := ApplySuggestions(src,
			[]models.SuggestedChange{{SentenceID: "s1", Text: "Diff."}},
			map[string]string{"s1": "Same."})
		if string(out) != "Diff. Same.\n" {
			t.Fatalf("got %q", out)
		}
	})

	t.Run("paragraph split via mid-content marker", func(t *testing.T) {
		src := []byte("Old long sentence here.\n")
		out, _ := ApplySuggestions(src,
			[]models.SuggestedChange{{SentenceID: "s1", Text: "First half here.\n\tSecond half here."}},
			map[string]string{"s1": "Old long sentence here."})
		want := "First half here.\n\tSecond half here.\n"
		if string(out) != want {
			t.Fatalf("got %q want %q", out, want)
		}
	})

	t.Run("unfound original is skipped, others still apply", func(t *testing.T) {
		src := []byte("Apple. Banana.\n")
		out, results := ApplySuggestions(src,
			[]models.SuggestedChange{
				{SentenceID: "missing", Text: "ignored"},
				{SentenceID: "s2", Text: "BANANA!"},
			},
			map[string]string{
				"missing": "Cherry.", // not in source
				"s2":      "Banana.",
			})
		if string(out) != "Apple. BANANA!\n" {
			t.Fatalf("got %q", out)
		}
		if results[0].Applied || !strings.Contains(results[0].Reason, "not found") {
			t.Fatalf("missing should have skipped with not-found reason, got %+v", results[0])
		}
		if !results[1].Applied {
			t.Fatalf("s2 should have applied, got %+v", results[1])
		}
	})

	t.Run("multiple suggestions all apply", func(t *testing.T) {
		src := []byte("One. Two. Three.\n")
		out, _ := ApplySuggestions(src,
			[]models.SuggestedChange{
				{SentenceID: "s1", Text: "Uno."},
				{SentenceID: "s2", Text: "Dos."},
				{SentenceID: "s3", Text: "Tres."},
			},
			map[string]string{
				"s1": "One.", "s2": "Two.", "s3": "Three.",
			})
		if string(out) != "Uno. Dos. Tres.\n" {
			t.Fatalf("got %q", out)
		}
	})

	t.Run("empty suggestion = delete sentence", func(t *testing.T) {
		src := []byte("Keep this. Delete this.\n")
		out, _ := ApplySuggestions(src,
			[]models.SuggestedChange{{SentenceID: "s2", Text: ""}},
			map[string]string{"s2": "Delete this."})
		if string(out) != "Keep this. \n" {
			t.Fatalf("got %q", out)
		}
	})
}
