package database

import (
	"testing"
	"time"
)

func day(s string) time.Time {
	t, _ := time.Parse("2006-01-02", s)
	return t
}

func rowsFor(totals map[string]int) []WordcountRow {
	// map iteration order is random — build day-ascending explicitly.
	days := []string{}
	for d := range totals {
		days = append(days, d)
	}
	for i := 0; i < len(days); i++ {
		for j := i + 1; j < len(days); j++ {
			if days[j] < days[i] {
				days[i], days[j] = days[j], days[i]
			}
		}
	}
	out := []WordcountRow{}
	for _, d := range days {
		out = append(out, WordcountRow{Day: day(d), WordsEffective: totals[d]})
	}
	return out
}

func TestComputeRates(t *testing.T) {
	birth := day("2026-01-01")
	// 100 words/day exactly: day 10 has 1000, day 40 has 4000.
	rows := rowsFor(map[string]int{"2026-01-11": 1000, "2026-02-10": 4000})
	rated := ComputeRates(rows, &birth, 10000)

	if rated[0].RateAverage == nil || *rated[0].RateAverage != 100 {
		t.Fatalf("day-10 average: want 100, got %v", rated[0].RateAverage)
	}
	// Day 10 has no earlier row inside its window — the average stands in.
	if rated[0].RatePast30d == nil || *rated[0].RatePast30d != 100 {
		t.Errorf("day-10 past-30d fallback: want 100, got %v", rated[0].RatePast30d)
	}
	if rated[1].RateAverage == nil || *rated[1].RateAverage != 100 {
		t.Errorf("day-40 average: want 100, got %v", rated[1].RateAverage)
	}
	// Trailing window: (4000-1000)/30 = 100.
	if rated[1].RatePast30d == nil || *rated[1].RatePast30d != 100 {
		t.Errorf("day-40 past-30d: want 100, got %v", rated[1].RatePast30d)
	}
	// Projection on day 40: (10000-4000)/100 = 60 days out.
	if rated[1].ProjectedEnd == nil || !rated[1].ProjectedEnd.Equal(day("2026-04-11")) {
		t.Errorf("day-40 projected end: want 2026-04-11, got %v", rated[1].ProjectedEnd)
	}

	// Goal already reached → no projection, rates still present.
	rated2 := ComputeRates(rows, &birth, 3000)
	if rated2[1].ProjectedEnd != nil {
		t.Errorf("goal reached: projection should be nil, got %v", *rated2[1].ProjectedEnd)
	}
	if rated2[1].RateAverage == nil {
		t.Errorf("goal reached: average should still compute")
	}

	// No birthday → no rates at all.
	rated3 := ComputeRates(rows, nil, 10000)
	if rated3[0].RateAverage != nil || rated3[1].RatePast30d != nil || rated3[1].ProjectedEnd != nil {
		t.Errorf("nil birthday must yield nil rates: %+v", rated3)
	}

	// Inputs are not mutated (fill-if-NULL logic depends on that).
	if rows[0].RateAverage != nil {
		t.Errorf("ComputeRates must not mutate its input")
	}
}
