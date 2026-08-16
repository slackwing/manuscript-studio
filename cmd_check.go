package main

import (
	"fmt"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

func main() {
	ids := []string{"s1", "s2", "s3"}
	committed := map[string]string{
		"s1": "\n\tAs it turns out, later I paint her in...",
		"s2": "\n\tBut first we must get there.",
		"s3": "\n\tThe next two days passed.",
	}
	sugs := map[string]string{
		"s2": "\n&sketch#nysqnmtcjg{}\n\n\tBut first we must get there.",
	}
	out := sentence.RebuildManuscript(ids, committed, sugs)
	fmt.Printf("%q\n", out)
}
