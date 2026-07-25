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
		// Markdown # headers are deprecated: a '#' sentence is ordinary content.
		{"# is now content", "# The Wildfire", false},
		{"## is now content", "## Chapter 1", false},
		{"### is now content", "### I.", false},
		{"#nospace is content", "#NoSpace", false},
		{"empty", "", true},
		{"# with embedded newline is bad content", "# Bad\nheading", true},
		{"# with embedded tab is bad content", "# Bad\theading", true},
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
