package sentence

import "testing"

func TestBuildOutline(t *testing.T) {
	ids := []string{"t", "p1", "c1", "a1", "prose", "c2", "p2", "c3", "atop"}
	textByID := map[string]string{
		"t":     "&title{The Wildfire}",
		"p1":    "&part#p1{I.}{The Gathering}",
		"c1":    "&chapter#p1c1{1.}{Smoke}",
		"a1":    "&anchor#origin{where it begins}", // under c1
		"prose": "Some prose sentence.",
		"c2":    "&chapter#p1c2{2.}{Ash}", // under p1
		"p2":    "&part#p2{II.}{The Return}",
		"c3":    "&chapter#p2c1{3.}{New York}", // under p2
		"atop":  "&anchor#loose{a note}",       // under c3 (most recent chapter)
	}
	o := BuildOutline(ids, textByID)

	if o.Title == nil || o.Title.Name != "The Wildfire" || o.Title.SentenceID != "t" {
		t.Fatalf("title wrong: %+v", o.Title)
	}
	if len(o.Parts) != 2 {
		t.Fatalf("want 2 parts, got %d", len(o.Parts))
	}
	p1 := o.Parts[0]
	if p1.Label != "I." || p1.Description != "The Gathering" || p1.Slug != "p1" {
		t.Errorf("part1 fields wrong: %+v", p1)
	}
	if len(p1.Chapters) != 2 {
		t.Fatalf("part1 want 2 chapters, got %d", len(p1.Chapters))
	}
	if p1.Chapters[0].Label != "1." || p1.Chapters[0].Slug != "p1c1" {
		t.Errorf("chapter1 wrong: %+v", p1.Chapters[0])
	}
	if len(p1.Chapters[0].Anchors) != 1 || p1.Chapters[0].Anchors[0].Slug != "origin" {
		t.Errorf("chapter1 anchor wrong: %+v", p1.Chapters[0].Anchors)
	}
	if p1.Chapters[1].Label != "2." {
		t.Errorf("chapter2 wrong: %+v", p1.Chapters[1])
	}
	p2 := o.Parts[1]
	if p2.Label != "II." || len(p2.Chapters) != 1 {
		t.Fatalf("part2 wrong: %+v", p2)
	}
	// The loose anchor attaches to the most recent chapter (c3 under p2).
	if len(p2.Chapters[0].Anchors) != 1 || p2.Chapters[0].Anchors[0].Slug != "loose" {
		t.Errorf("loose anchor should be under p2's chapter: %+v", p2.Chapters[0].Anchors)
	}
}

// Chapters/anchors before any part land at the document top level.
func TestBuildOutlineTopLevel(t *testing.T) {
	ids := []string{"c0", "a0", "p1"}
	textByID := map[string]string{
		"c0": "&chapter#c0{Prologue}{}",
		"a0": "&anchor#note{a top anchor}", // under c0
		"p1": "&part#p1{I.}{First}",
	}
	o := BuildOutline(ids, textByID)
	if len(o.TopChapters) != 1 || o.TopChapters[0].Slug != "c0" {
		t.Fatalf("want 1 top chapter, got %+v", o.TopChapters)
	}
	if len(o.TopChapters[0].Anchors) != 1 {
		t.Errorf("top chapter should hold the anchor: %+v", o.TopChapters[0].Anchors)
	}
	if len(o.Parts) != 1 {
		t.Errorf("want 1 part, got %d", len(o.Parts))
	}
}

// No label = not outline-worthy: unlabeled anchors and snippets are skipped
// (the placeholder rule, applied uniformly — an unlabeled anchor used to
// list as a bare #slug and read as noise).
func TestBuildOutlineSkipsUnlabeledAnchors(t *testing.T) {
	ids := []string{"c1", "a1", "a2", "s1", "s2"}
	textByID := map[string]string{
		"c1": "&chapter#c1{1.}{Smoke}",
		"a1": "&anchor#bare{}",             // unlabeled — skipped
		"a2": "&anchor#named{kept anchor}", // labeled — kept
		"s1": "&snippet#sn1{}",             // unlabeled canonized snippet — skipped
		"s2": "&snippet#sn2{kept snippet}", // labeled — kept
	}
	o := BuildOutline(ids, textByID)
	if len(o.TopChapters) != 1 {
		t.Fatalf("want 1 top chapter, got %+v", o.TopChapters)
	}
	anchors := o.TopChapters[0].Anchors
	if len(anchors) != 2 {
		t.Fatalf("want only the 2 labeled entries, got %+v", anchors)
	}
	if anchors[0].Slug != "named" || anchors[1].Slug != "sn2" {
		t.Errorf("wrong survivors: %+v", anchors)
	}
}
