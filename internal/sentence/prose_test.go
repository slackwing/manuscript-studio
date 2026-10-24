package sentence

import (
	"encoding/json"
	"os"
	"testing"
)

func TestFirstProseSentence(t *testing.T) {
	cases := []struct{ in, want string }{
		{"It was late. The room had gone quiet.", "It was late."},
		{"&chapter#one{One}\n\n\tShe left early. Then.", "She left early."},
		{"\n\t...And then it went. More.", "...And then it went."},
		{"*So it was*—the epidemic of being in our 20s. &mark#beacon{weak}", "So it was—the epidemic of being in our 20s."},
		{"It was &marker#vivid tonight, said one. Next.", "It was tonight, said one."},
		{"A note here&footnote{with a footnote}. Next.", "A note here."},
		{"Word &marker#x. Then.", "Word."},
		{"She was _very_ sure. Then.", "She was very sure."},
		{"", ""},
		{"&chapter#one{One}", ""},
	}
	for _, c := range cases {
		if got := FirstProseSentence(c.in); got != c.want {
			t.Errorf("FirstProseSentence(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// segman v2.10.0: _underscore_ italics split exactly like *asterisk*
// italics — a standalone italic sentence is its own sentence, an italic
// span keeps its inner periods, and snake_case is no markup at all.
func TestUnderscoreItalicsSegmentLikeAsterisks(t *testing.T) {
	tk := NewTokenizer()
	for _, pair := range [][2]string{
		{"The door swung shut. *Thud.* Then silence.", "The door swung shut. _Thud._ Then silence."},
		{"He said *stop. Now.* And left.", "He said _stop. Now._ And left."},
		{"Nothing. *Thud!* Again.", "Nothing. _Thud!_ Again."},
	} {
		a, b := tk.TokenizeWithMarkers(pair[0]), tk.TokenizeWithMarkers(pair[1])
		if len(a) != len(b) {
			t.Errorf("%q → %q\n%q → %q", pair[0], a, pair[1], b)
		}
	}
	if got := tk.TokenizeWithMarkers("Open my_notes. Then run read_me now. Done."); len(got) != 3 {
		t.Errorf("snake_case should not change splitting: %q", got)
	}
}

// 2026-10-24: a blank note's default — fill-ins, else three words + "...".
// The cases live in tests/fixtures/note-default-cases.json: the browser's
// mirror (web/js/note-default.js) runs the same table (test-note-default-units).
func TestNoteDefault(t *testing.T) {
	raw, err := os.ReadFile("../../tests/fixtures/note-default-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Text   string `json:"text"`
		Sketch bool   `json:"sketch"`
		Want   string `json:"want"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if got := NoteDefault(c.Text, c.Sketch); got != c.Want {
			t.Errorf("NoteDefault(%q, %v) = %q, want %q", c.Text, c.Sketch, got, c.Want)
		}
	}
}
