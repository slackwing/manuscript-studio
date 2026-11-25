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

// &meta is front matter (2026-11-25): commands and blanks before the text
// keep it open; the first prose sentence closes it — a later &meta (and a
// later unknown property) is ignored.
func TestExtractSettingsFrontMatter(t *testing.T) {
	s := ExtractSettings([]string{"t", "m1", "blank", "c", "p", "m2", "u"}, map[string]string{
		"t":     "&title{The Book}",
		"m1":    "&meta{chapter-align}{center}",
		"blank": "   ",
		"c":     "&chapter#c1{1.}{One}",
		"p":     "The first sentence of prose.",
		"m2":    "&meta{chapter-align}{left}", // after prose → ignored
		"u":     "&meta{bogus}{x}",            // after prose → not even reported
	})
	if s.Values["chapter-align"] != "center" {
		t.Errorf("a &meta after prose must not apply: got %q, want center", s.Values["chapter-align"])
	}
	if len(s.Unknown) != 0 {
		t.Errorf("unknowns after prose are not reported: %v", s.Unknown)
	}
}

// Footnote settings (FOOTNOTES_PLAN.md §3): the two properties validate
// against their closed value sets; an unmappable value is dropped.
func TestExtractSettingsFootnotes(t *testing.T) {
	s := ExtractSettings([]string{"a", "b", "c"}, map[string]string{
		"a": "&meta{footnote-marks}{symbols}",
		"b": "&meta{footnote-reset}{page}",
		"c": "&meta{footnote-reset}{book}", // bad syntax → ignored, "page" stands
	})
	if s.Values["footnote-marks"] != "symbols" {
		t.Errorf("footnote-marks: got %q, want symbols", s.Values["footnote-marks"])
	}
	if s.Values["footnote-reset"] != "page" {
		t.Errorf("footnote-reset: got %q, want page (the unmappable 'book' must not win)", s.Values["footnote-reset"])
	}
}
