package handlers

import (
	"testing"
	"time"
)

// dateString feeds the stats pane's birthday field; it must emit a plain
// calendar date (no time, no zone) or the browser shifts it across
// timezones.
func TestDateString(t *testing.T) {
	if got := dateString(nil); got != nil {
		t.Errorf("dateString(nil) = %v, want nil", *got)
	}
	d := time.Date(2025, 12, 2, 0, 0, 0, 0, time.UTC)
	if got := dateString(&d); got == nil || *got != "2025-12-02" {
		t.Errorf("dateString(2025-12-02) = %v, want 2025-12-02", got)
	}
	// A DATE scanned through a non-UTC session must still print its
	// calendar day, not a zone-shifted neighbor.
	loc := time.FixedZone("EST", -5*3600)
	d2 := time.Date(2025, 12, 2, 0, 0, 0, 0, loc)
	if got := dateString(&d2); got == nil || *got != "2025-12-02" {
		t.Errorf("dateString(EST 2025-12-02) = %v, want 2025-12-02", got)
	}
}
