package database

// AREA 2 §2.4 rows #73–#74 — pure unit tests for the in-memory daily-rule
// engine (queries.go:2410–2478). No DB.

import (
	"testing"

	"github.com/slackwing/manuscript-studio/internal/models"
)

func taskNote(id int, taskType, priority, impact, color string, blocked bool, tags ...string) HomeNote {
	h := HomeNote{
		NoteID:   id,
		TaskType: taskType,
		Priority: priority,
		Impact:   impact,
		Color:    color,
		Blocked:  blocked,
	}
	for _, name := range tags {
		h.Tags = append(h.Tags, models.Tag{TagName: name})
	}
	return h
}

// #73: every selector is AND'd; nil = wildcard; tags must ALL be present;
// blocked is tri-state (nil = any, true = blocked-only, false = unblocked-only).
func TestRuleMatches_AllSelectors(t *testing.T) {
	base := taskNote(1, "revise", "must", "chapter", "red", false, "plot", "urgent")

	cases := []struct {
		name string
		rule DailyRule
		note HomeNote
		want bool
	}{
		{"all nil selectors match anything", DailyRule{}, base, true},
		{"task type match", DailyRule{TaskType: strPtr("revise")}, base, true},
		{"task type mismatch", DailyRule{TaskType: strPtr("research")}, base, false},
		{"priority match", DailyRule{Priority: strPtr("must")}, base, true},
		{"priority mismatch", DailyRule{Priority: strPtr("can")}, base, false},
		{"impact match", DailyRule{Impact: strPtr("chapter")}, base, true},
		{"impact mismatch", DailyRule{Impact: strPtr("novel")}, base, false},
		{"color match", DailyRule{Color: strPtr("red")}, base, true},
		{"color mismatch", DailyRule{Color: strPtr("blue")}, base, false},
		{"blocked nil matches unblocked", DailyRule{Blocked: nil}, base, true},
		{"blocked nil matches blocked", DailyRule{Blocked: nil},
			taskNote(2, "revise", "must", "chapter", "red", true), true},
		{"blocked true rejects unblocked", DailyRule{Blocked: boolPtr(true)}, base, false},
		{"blocked true matches blocked", DailyRule{Blocked: boolPtr(true)},
			taskNote(2, "revise", "must", "chapter", "red", true), true},
		{"blocked false matches unblocked", DailyRule{Blocked: boolPtr(false)}, base, true},
		{"blocked false rejects blocked", DailyRule{Blocked: boolPtr(false)},
			taskNote(2, "revise", "must", "chapter", "red", true), false},
		{"single tag present", DailyRule{Tags: []string{"plot"}}, base, true},
		{"all tags present", DailyRule{Tags: []string{"plot", "urgent"}}, base, true},
		{"one tag missing fails", DailyRule{Tags: []string{"plot", "someday"}}, base, false},
		{"tag on tagless note fails", DailyRule{Tags: []string{"plot"}},
			taskNote(3, "revise", "must", "chapter", "red", false), false},
		{"selectors AND together", DailyRule{TaskType: strPtr("revise"), Priority: strPtr("can")}, base, false},
		{"all selectors aligned", DailyRule{
			TaskType: strPtr("revise"), Priority: strPtr("must"), Impact: strPtr("chapter"),
			Color: strPtr("red"), Blocked: boolPtr(false), Tags: []string{"urgent"},
		}, base, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ruleMatches(c.rule, c.note); got != c.want {
				t.Errorf("ruleMatches(%+v) = %v, want %v", c.rule, got, c.want)
			}
		})
	}
}

// #74: order-preserving backfill — out-of-quota tasks are skipped and their
// slots go to whatever eligible tasks come next; −1 = unlimited; the limit
// cuts the tail.
func TestApplyDailyRules_QuotaBackfill(t *testing.T) {
	ids := func(notes []HomeNote) []int {
		out := []int{}
		for _, n := range notes {
			out = append(out, n.NoteID)
		}
		return out
	}
	eq := func(t *testing.T, got, want []int) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	}

	revise := func(id int) HomeNote { return taskNote(id, "revise", "none", "n/a", "yellow", false) }
	research := func(id int) HomeNote { return taskNote(id, "research", "none", "n/a", "yellow", false) }

	t.Run("capped skip with backfill", func(t *testing.T) {
		rules := []DailyRule{{TaskType: strPtr("revise"), MaxPerDay: 1}}
		candidates := []HomeNote{revise(1), revise(2), research(3), revise(4), research(5)}
		got := ApplyDailyRules(rules, candidates, 3)
		// revise capped at 1: note 2 and 4 skipped, their slots backfilled.
		eq(t, ids(got), []int{1, 3, 5})
	})

	t.Run("minus one is unlimited", func(t *testing.T) {
		rules := []DailyRule{{TaskType: strPtr("revise"), MaxPerDay: -1}}
		candidates := []HomeNote{revise(1), revise(2), revise(3)}
		got := ApplyDailyRules(rules, candidates, 10)
		eq(t, ids(got), []int{1, 2, 3})
	})

	t.Run("zero quota blocks entirely", func(t *testing.T) {
		rules := []DailyRule{{TaskType: strPtr("revise"), MaxPerDay: 0}}
		candidates := []HomeNote{revise(1), research(2), revise(3)}
		got := ApplyDailyRules(rules, candidates, 10)
		eq(t, ids(got), []int{2})
	})

	t.Run("limit cuts in order", func(t *testing.T) {
		got := ApplyDailyRules(nil, []HomeNote{revise(1), revise(2), revise(3)}, 2)
		eq(t, ids(got), []int{1, 2})
	})

	t.Run("no rules passes everything up to limit", func(t *testing.T) {
		got := ApplyDailyRules(nil, []HomeNote{revise(9), research(8)}, 10)
		eq(t, ids(got), []int{9, 8})
	})

	t.Run("multiple matching rules all decrement", func(t *testing.T) {
		rules := []DailyRule{
			{TaskType: strPtr("revise"), MaxPerDay: 2}, // matches 1, 2
			{MaxPerDay: 2},                             // wildcard: matches everything
		}
		candidates := []HomeNote{revise(1), revise(2), research(3), research(4)}
		got := ApplyDailyRules(rules, candidates, 10)
		// The wildcard's quota of 2 is spent on notes 1 and 2; 3 and 4 blocked.
		eq(t, ids(got), []int{1, 2})
	})

	t.Run("unlimited rule never decrements away", func(t *testing.T) {
		rules := []DailyRule{
			{MaxPerDay: -1},                            // unlimited wildcard
			{TaskType: strPtr("revise"), MaxPerDay: 1}, // caps revise
		}
		candidates := []HomeNote{revise(1), revise(2), research(3)}
		got := ApplyDailyRules(rules, candidates, 10)
		eq(t, ids(got), []int{1, 3})
	})

	t.Run("empty candidates", func(t *testing.T) {
		got := ApplyDailyRules([]DailyRule{{MaxPerDay: 1}}, nil, 5)
		if len(got) != 0 {
			t.Fatalf("got %v, want empty", got)
		}
		if got == nil {
			t.Fatal("result must be a non-nil slice (JSON [] not null)")
		}
	})
}
