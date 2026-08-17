package handlers

// Unit tests for the pure helpers in suggestions.go (CODE_REVIEW_AUG_2026.md
// AREA 2 rows #103–104).

import "testing"

// #103 — sanitizeBranchComponent: anything outside [a-zA-Z0-9_-] becomes '-';
// empty input becomes "user".
func TestSanitizeBranchComponent(t *testing.T) {
	cases := map[string]string{
		"alice":           "alice",
		"alice_b-2":       "alice_b-2",
		"weird user!":     "weird-user-",
		"a@b.c":           "a-b-c",
		"über":            "-ber",
		"..":              "-",
		"":                "user",
		"tabs\tand\nnew":  "tabs-and-new",
		"multi   spaces":  "multi-spaces", // a run collapses to ONE dash
		"{shell;$(rm x)}": "-shell-rm-x-",
	}
	for in, want := range cases {
		if got := sanitizeBranchComponent(in); got != want {
			t.Errorf("sanitizeBranchComponent(%q) = %q, want %q", in, got, want)
		}
	}
}

// #103 — canonicalSuggestionsBranch: "suggestions-{short7}-{user}", stable
// across sessions (View-on-GitHub depends on it).
func TestCanonicalSuggestionsBranch(t *testing.T) {
	cases := []struct {
		commit, user, want string
	}{
		{"0123456789abcdef0123456789abcdef01234567", "alice", "suggestions-0123456-alice"},
		{"abc1234", "alice", "suggestions-abc1234-alice"}, // exactly 7 stays whole
		{"abc12", "alice", "suggestions-abc12-alice"},     // shorter than 7 untouched
		{"deadbeefcafe", "we?ird na me", "suggestions-deadbee-we-ird-na-me"},
		{"deadbeefcafe", "", "suggestions-deadbee-user"},
	}
	for _, tc := range cases {
		if got := canonicalSuggestionsBranch(tc.commit, tc.user); got != tc.want {
			t.Errorf("canonicalSuggestionsBranch(%q, %q) = %q, want %q", tc.commit, tc.user, got, tc.want)
		}
	}
}

// #104 — segmanSiblingPath: ".manuscript" swaps to ".segman". NOTE: for any
// other extension the code APPENDS ".segman" (the doc comment above it claims
// pass-through unchanged — the comment is wrong, the append is what ships and
// what PathExistsAtCommit gets asked about).
func TestSegmanSiblingPath(t *testing.T) {
	cases := map[string]string{
		"book.manuscript":      "book.segman",
		"dir/x.manuscript":     "dir/x.segman",
		"deep/a/b.manuscript":  "deep/a/b.segman",
		"book.md":              "book.md.segman",
		"manuscript":           "manuscript.segman",
		"":                     ".segman",
		"weird.manuscript.bak": "weird.manuscript.bak.segman",
		"x.manuscript/oddity":  "x.manuscript/oddity.segman", // suffix match only
	}
	for in, want := range cases {
		if got := segmanSiblingPath(in); got != want {
			t.Errorf("segmanSiblingPath(%q) = %q, want %q", in, got, want)
		}
	}
}
