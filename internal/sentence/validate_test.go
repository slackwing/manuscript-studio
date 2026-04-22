package sentence

import "testing"

func TestValidateSentenceText(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		wantErr bool
	}{
		{"plain content", "The fox jumped.", false},
		{"plain with inline markdown", "*The* fox jumped.", false},
		{"new paragraph marker", "\n\tIndented sentence.", false},
		{"new section marker", "\n\nNew section sentence.", false},
		{"H1 header", "# The Wildfire", false},
		{"H2 header", "## Chapter 1", false},
		{"H3 header", "### I.", false},
		{"empty", "", true},
		{"header with newline", "# Bad\nheading", true},
		{"header with tab", "# Bad\theading", true},
		{"header with no space", "#NoSpace", true},
		{"header with no content", "# ", true},
		{"trailing space", "Trailing space ", true},
		{"embedded newline", "Bad\nembed.", true},
		{"embedded tab", "Bad\tembed.", true},
		{"marker after content", "Content\n\tmarker.", true},
		{"double marker", "\n\t\n\nDouble.", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateSentenceText(tc.text)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %q, got nil", tc.text)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error for %q: %v", tc.text, err)
			}
		})
	}
}
