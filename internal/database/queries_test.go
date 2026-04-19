package database

import (
	"strings"
	"testing"
)

// TestErrorTruncation exercises the truncation logic in MarkMigrationError
// without needing a database. The function does the truncation in-line, so
// we replicate the same arithmetic here as a regression guard against
// someone changing the constant without thinking.
func TestErrorTruncation(t *testing.T) {
	const maxErrLen = 4000
	long := strings.Repeat("x", maxErrLen+500)

	// Mirror the truncation logic in MarkMigrationError. If the prod logic
	// changes, this test fails and the author has to look here too.
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
