package api

import (
	"testing"
	"time"
)

// The wordcount cron runs on the clock: every 15 minutes = :00/:15/:30/:45.
func TestNextAlignedTick(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("no tzdata")
	}
	q := 15 * time.Minute
	for _, c := range []struct{ now, want string }{
		{"2026-10-24 15:09:14", "2026-10-24 15:15:00"},
		{"2026-10-24 15:15:00", "2026-10-24 15:30:00"},
		{"2026-10-24 15:59:59", "2026-10-24 16:00:00"},
		{"2026-10-24 23:50:00", "2026-10-25 00:00:00"},
	} {
		now, _ := time.ParseInLocation("2006-01-02 15:04:05", c.now, ny)
		got := NextAlignedTick(now, q).In(ny).Format("2006-01-02 15:04:05")
		if got != c.want {
			t.Errorf("NextAlignedTick(%s) = %s, want %s", c.now, got, c.want)
		}
	}
	if got := NextAlignedTick(time.Date(2026, 1, 1, 10, 20, 0, 0, time.UTC), time.Hour); got.Minute() != 0 || got.Hour() != 11 {
		t.Errorf("hourly: %v", got)
	}
}
