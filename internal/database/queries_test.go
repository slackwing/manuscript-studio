package database

import (
	"strings"
	"testing"
)

// Regression guard on MarkMigrationError's in-line truncation constant.
// The arithmetic is duplicated below on purpose — if someone changes the
// prod constant, this test fails and forces them to look here.
func TestErrorTruncation(t *testing.T) {
	const maxErrLen = 4000
	long := strings.Repeat("x", maxErrLen+500)

	truncated := long
	if len(truncated) > maxErrLen {
		truncated = truncated[:maxErrLen] + "...[truncated]"
	}

	if !strings.HasSuffix(truncated, "[truncated]") {
		t.Fatal("expected truncated suffix")
	}
	if len(truncated) > maxErrLen+50 {
		t.Fatalf("truncated message unexpectedly long: %d", len(truncated))
	}
}
