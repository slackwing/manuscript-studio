package sentence

import "testing"

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
