package sentence

import (
	"reflect"
	"testing"
)

func TestParseCommand(t *testing.T) {
	cases := []struct {
		in   string
		ok   bool
		kind CommandKind
		slug string
		args []string
	}{
		{"&title{The Wildfire}", true, CmdTitle, "", []string{"The Wildfire"}},
		{"&part#p1{I.}{The Gathering}", true, CmdPart, "p1", []string{"I.", "The Gathering"}},
		{"&chapter#p1c1{1.}{Smoke on the ridge}", true, CmdChapter, "p1c1", []string{"1.", "Smoke on the ridge"}},
		{"&chapter{1.}{Smoke}", true, CmdChapter, "", []string{"1.", "Smoke"}}, // no slug
		{"&anchor#origin{where it begins}", true, CmdAnchor, "origin", []string{"where it begins"}},
		{"&anchor#x{}", true, CmdAnchor, "x", []string{""}}, // empty arg
		{"&reference#origin{see the start}", true, CmdReference, "origin", []string{"see the start"}},
		// Not commands:
		{"Smith & Sons", false, "", "", nil},
		{"R&D budget", false, "", "", nil},
		{"&chapter of accidents", false, "", "", nil}, // no delimiter
		{"&unknown{x}", false, "", "", nil},           // unknown keyword
		{"&chapter#p1", false, "", "", nil},           // slug but no args
		{"&chapter#p1{unterminated", false, "", "", nil},
		{"plain text", false, "", "", nil},
	}
	for _, c := range cases {
		cmd, ok := ParseCommand(c.in)
		if ok != c.ok {
			t.Errorf("ParseCommand(%q) ok = %v, want %v", c.in, ok, c.ok)
			continue
		}
		if !ok {
			continue
		}
		if cmd.Kind != c.kind || cmd.Slug != c.slug || !reflect.DeepEqual(cmd.Args, c.args) {
			t.Errorf("ParseCommand(%q) = {kind:%q slug:%q args:%v}, want {kind:%q slug:%q args:%v}",
				c.in, cmd.Kind, cmd.Slug, cmd.Args, c.kind, c.slug, c.args)
		}
	}
}

func TestIsBlockCommandText(t *testing.T) {
	block := []string{
		"&title{The Wildfire}",
		"&part#p1{I.}{The Gathering}",
		"&chapter#p1c1{1.}{Smoke}",
		"&anchor#origin{here}",
	}
	for _, s := range block {
		if !IsBlockCommandText(s) {
			t.Errorf("IsBlockCommandText(%q) = false, want true", s)
		}
	}
	notBlock := []string{
		"&reference#origin{note}",                  // inline-only command
		"The fire &anchor#x{} spread.",             // inline anchor in a content sentence
		"&chapter#c1{I.}{Smoke} &anchor#o{begins}", // trailing content after the command
		"Smith & Sons",                             // literal
		"# A markdown header",                      // header, not a command
		"Plain sentence.",                          // plain
	}
	for _, s := range notBlock {
		if IsBlockCommandText(s) {
			t.Errorf("IsBlockCommandText(%q) = true, want false", s)
		}
	}
}

func TestValidSlug(t *testing.T) {
	good := []string{"p1", "p1c1", "origin", "act-one", "chapter-12", "a"}
	bad := []string{"P1", "p1c1!", "with space", "under_score", "", "café"}
	for _, s := range good {
		if !ValidSlug(s) {
			t.Errorf("ValidSlug(%q) = false, want true", s)
		}
	}
	for _, s := range bad {
		if ValidSlug(s) {
			t.Errorf("ValidSlug(%q) = true, want false", s)
		}
	}
}

func TestValidateSentenceText_Commands(t *testing.T) {
	valid := []string{
		"&title{The Wildfire}",
		"&part#p1{I.}{The Gathering}",
		"&chapter#p1c1{1.}{Smoke on the ridge}",
		"&chapter{1.}{Smoke}", // no slug ok
		"&anchor#origin{here}",
	}
	for _, s := range valid {
		if err := ValidateSentenceText(s); err != nil {
			t.Errorf("ValidateSentenceText(%q) = %v, want nil", s, err)
		}
	}
	invalid := []string{
		"&reference#origin{note}",   // inline command can't be its own sentence
		"&chapter#P1C1{1.}{Smoke}",  // uppercase slug
		"&chapter#p1_c1{1.}{Smoke}", // underscore in slug
		"&chapter#p1{a}\n{b}",       // embedded newline
	}
	for _, s := range invalid {
		if err := ValidateSentenceText(s); err == nil {
			t.Errorf("ValidateSentenceText(%q) = nil, want error", s)
		}
	}

	// A leading '&' that isn't a clean whole-sentence command is ordinary
	// prose now (a bare/inline '&' is not an error).
	validAsContent := []string{
		"&bogus{x}",                       // unknown keyword -> prose
		"&chapter#p1{I.}{Smoke} trailing", // command + trailing -> a content sentence
	}
	for _, s := range validAsContent {
		if err := ValidateSentenceText(s); err != nil {
			t.Errorf("ValidateSentenceText(%q) = %v, want nil (content)", s, err)
		}
	}
}

// Round-trip: a manuscript mixing block commands, inline commands, prose, and
// a legacy Markdown header must tokenize, validate, reconstruct byte-exactly,
// and re-tokenize identically.
func TestCommandRoundTrip(t *testing.T) {
	src := "&title{The Wildfire}\n\n" +
		"&part#p1{I.}{The Gathering}\n\n" +
		"&chapter#p1c1{1.}{Smoke on the ridge}\n\n" +
		"The fire began at dawn. It spread across the ridge.\n\n" +
		"&anchor#origin{where it begins}\n\n" +
		"The fire &anchor#firemark{} had a shape. Smith & Sons rebuilt it.\n\n" +
		"See &reference#origin{the opening} for how it started.\n\n" +
		"# A legacy header\n\n" +
		"Still segments the old way.\n"

	tk := NewTokenizer()
	sentences := tk.TokenizeWithMarkers(src)
	for i, s := range sentences {
		if err := ValidateSentenceText(s); err != nil {
			t.Errorf("sentence %d %q failed validation: %v", i, s, err)
		}
	}
	rec := Reconstruct(sentences)
	if rec != src {
		t.Errorf("reconstruct not byte-exact:\n got %q\nwant %q", rec, src)
	}
	re := tk.TokenizeWithMarkers(rec)
	if !reflect.DeepEqual(sentences, re) {
		t.Errorf("re-tokenize drifted:\n first %v\n after %v", sentences, re)
	}
}

func TestExtractStaticSlugs(t *testing.T) {
	ids := []string{"s0", "s1", "s2", "s3", "s4", "s5"}
	textByID := map[string]string{
		"s0": "&title{The Wildfire}",                // no slug -> skipped
		"s1": "&part#p1{I.}{The Gathering}",         // static slug p1
		"s2": "&chapter#p1c1{1.}{Smoke}",            // static slug p1c1
		"s3": "The fire began. &anchor#x{} spread.", // inline -> not a block sentence -> skipped
		"s4": "&anchor#origin{here}",                // block anchor, slug origin
		"s5": "Plain prose sentence.",               // not a command
	}
	got := ExtractStaticSlugs(ids, textByID)
	want := []StaticSlug{
		{Slug: "p1", SentenceID: "s1", Kind: CmdPart},
		{Slug: "p1c1", SentenceID: "s2", Kind: CmdChapter},
		{Slug: "origin", SentenceID: "s4", Kind: CmdAnchor},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d slugs, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("slug[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestFindInlineCommands(t *testing.T) {
	refs, anchors := FindInlineCommands("See &reference#origin{the opening} and the fire &anchor#firemark{} spread.")
	if len(refs) != 1 || refs[0].Slug != "origin" || refs[0].Notes != "the opening" {
		t.Errorf("refs wrong: %+v", refs)
	}
	if len(anchors) != 1 || anchors[0].Slug != "firemark" {
		t.Errorf("anchors wrong: %+v", anchors)
	}
	// A block command sentence yields no inline commands.
	r2, a2 := FindInlineCommands("&chapter#p1c1{I}{Smoke}")
	if len(r2) != 0 || len(a2) != 0 {
		t.Errorf("block command should yield no inline: %+v %+v", r2, a2)
	}
	// Literal & is not a command.
	r3, _ := FindInlineCommands("Smith & Sons and R&D survived.")
	if len(r3) != 0 {
		t.Errorf("literal & should yield no refs: %+v", r3)
	}
}

func TestFindReferences_dangling(t *testing.T) {
	ids := []string{"s0", "s1", "s2"}
	textByID := map[string]string{
		"s0": "&chapter#p1c1{I}{Smoke}",             // defines slug p1c1
		"s1": "See &reference#p1c1{the chapter}.",   // resolves
		"s2": "See &reference#ghost{missing} here.", // dangling
	}
	refs := FindReferences(ids, textByID)
	if len(refs) != 2 {
		t.Fatalf("want 2 references, got %d: %+v", len(refs), refs)
	}
}
