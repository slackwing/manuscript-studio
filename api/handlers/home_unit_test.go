package handlers

// Unit test for joinContext (CODE_REVIEW_AUG_2026.md AREA 2 row #120's
// Go-testable slice: the 4 presence combinations).

import "testing"

func TestJoinContext(t *testing.T) {
	cases := []struct {
		manuscript, scratchpad, want string
	}{
		{"The Wildfire", "Journals: 202607", "The Wildfire · Journals: 202607"},
		{"The Wildfire", "", "The Wildfire"},
		{"", "Journals: 202607", "Journals: 202607"},
		{"", "", ""},
		// The separator only appears when BOTH parts exist.
		{"Book", "Sketch", "Book · Sketch"},
	}
	for _, tc := range cases {
		if got := joinContext(tc.manuscript, tc.scratchpad); got != tc.want {
			t.Errorf("joinContext(%q, %q) = %q, want %q", tc.manuscript, tc.scratchpad, got, tc.want)
		}
	}
}
