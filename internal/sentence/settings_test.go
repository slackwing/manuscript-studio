package sentence

import "testing"

func TestExtractSettings(t *testing.T) {
	ids := []string{"m0", "m1", "m2", "m3", "m4", "s"}
	textByID := map[string]string{
		"m0": "&meta{chapter-align}{center}",
		"m1": "&meta{part-align}{left}",
		"m2": "&meta{chapter-align}{left}",       // last-wins -> left
		"m3": "&meta{bogus-prop}{x}",             // unknown -> dropped
		"m4": "&meta{title-align}{diagonal}",     // out-of-range -> dropped
		"s":  "A plain sentence.",
	}
	s := ExtractSettings(ids, textByID)
	if s.Values["chapter-align"] != "left" {
		t.Errorf("chapter-align should be last-wins 'left', got %q", s.Values["chapter-align"])
	}
	if s.Values["part-align"] != "left" {
		t.Errorf("part-align wrong: %q", s.Values["part-align"])
	}
	if _, ok := s.Values["title-align"]; ok {
		t.Errorf("out-of-range title-align should be dropped, got %q", s.Values["title-align"])
	}
	if len(s.Unknown) != 1 || s.Unknown[0] != "bogus-prop" {
		t.Errorf("unknown should list bogus-prop, got %v", s.Unknown)
	}
	// Open-valued property accepts any non-empty value.
	s2 := ExtractSettings([]string{"f"}, map[string]string{"f": "&meta{font}{Georgia}"})
	if s2.Values["font"] != "Georgia" {
		t.Errorf("font should accept any value, got %q", s2.Values["font"])
	}
}
