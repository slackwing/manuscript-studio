package sentence

import "testing"

func TestCountProseWords(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int
	}{
		{"plain prose", "The fire began at dawn.", 5},
		{"leading section marker not a word", "\n\nThe fire began.", 3},
		{"leading paragraph marker not a word", "\n\tThe fire began.", 3},
		{"block title → 0", "&title{The Wildfire}", 0},
		{"block part → 0", "&part#p1{I.}{The Gathering}", 0},
		{"block chapter → 0", "&chapter#p1c1{1.}{Smoke on the ridge}", 0},
		{"block anchor → 0", "&anchor{The salvia night.}", 0},
		{"block meta → 0", "&meta{chapter-align}{center}", 0},
		{"block end → 0", "&end#p1", 0},
		{"block placeholder → 0 (details never count)",
			"&placeholder{paragraphs}{xl}{The keg party.}{a very long details blob with many many words that must not inflate the count at all here}", 0},
		{"plain prose 7 words", "See the opening for how it began.", 7},
		{"inline reference token removed (notes don't count)", "See &reference#origin{the opening} for how it began.", 5},
		{"inline anchor token removed", "The fire had a shape and it spread.", 8},
		{"inline anchor token removed 2", "The fire &anchor#firemark{} had a shape and it spread.", 8},
		{"literal ampersand is not a word", "Smith & Sons rebuilt it.", 4},
		{"R&D is one word", "The R&D budget grew.", 4},
		{"empty", "", 0},
		{"whitespace only", "   ", 0},
	}
	for _, c := range cases {
		if got := CountProseWords(c.in); got != c.want {
			t.Errorf("%s: CountProseWords(%q) = %d, want %d", c.name, c.in, got, c.want)
		}
	}
}

func TestCountMigrationProseWords(t *testing.T) {
	texts := []string{
		"&title{The Wildfire}",            // 0
		"\n\nThe fire began at dawn.",     // 5: The fire began at dawn
		"It spread across the ridge.",     // 5: It spread across the ridge
		"&chapter#c1{1.}{Smoke}",          // 0
		"See &reference#c1{chapter one}.", // strip token → "See  ." → "See" only = 1
	}
	got := CountMigrationProseWords(texts)
	want := 0 + 5 + 5 + 0 + 1
	if got != want {
		t.Errorf("CountMigrationProseWords = %d, want %d", got, want)
	}
}
