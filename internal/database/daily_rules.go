package database

// Daily rules (035): rule storage PLUS the in-memory rule engine.
// ruleMatches/ApplyDailyRules are pure business logic (no DB access) — they
// live here rather than a new package only to avoid an import ripple; a
// future pass may promote them. (Split out of queries.go, 2026-08 — pure
// code motion.)

import (
	"context"
	"fmt"
)

// DailyRule (035): one settings-page rule capping how many matching tasks
// the daily page may show. Nil selector = "any"; selectors AND together
// (tags: the rule's tags must ALL be on the task). MaxPerDay -1 = unlimited.
type DailyRule struct {
	RuleID    int      `json:"rule_id"`
	TaskType  *string  `json:"task_type,omitempty"`
	Priority  *string  `json:"priority,omitempty"`
	Impact    *string  `json:"impact,omitempty"`
	Color     *string  `json:"color,omitempty"`
	Blocked   *bool    `json:"blocked,omitempty"` // true = blocked-only
	MaxPerDay int      `json:"max_per_day"`
	Tags      []string `json:"tags"`
}

func (db *DB) ListDailyRules(ctx context.Context, username string) ([]DailyRule, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT r.rule_id, r.task_type, r.priority, r.impact, r.color, r.blocked, r.max_per_day,
		       COALESCE((SELECT array_agg(t.tag_name ORDER BY t.tag_name)
		                 FROM daily_rule_tag rt JOIN tag t ON t.tag_id = rt.tag_id
		                 WHERE rt.rule_id = r.rule_id), '{}')
		FROM daily_rule r
		WHERE r.user_id = $1
		ORDER BY r.position, r.rule_id
	`, username)
	if err != nil {
		return nil, fmt.Errorf("list daily rules: %w", err)
	}
	defer rows.Close()
	out := []DailyRule{}
	for rows.Next() {
		var r DailyRule
		if err := rows.Scan(&r.RuleID, &r.TaskType, &r.Priority, &r.Impact, &r.Color, &r.Blocked, &r.MaxPerDay, &r.Tags); err != nil {
			return nil, fmt.Errorf("scan daily rule: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (db *DB) CreateDailyRule(ctx context.Context, username string, r DailyRule) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("create daily rule: begin: %w", err)
	}
	defer tx.Rollback(ctx)
	var id int
	if err := tx.QueryRow(ctx, `
		INSERT INTO daily_rule (user_id, task_type, priority, impact, color, blocked, max_per_day, position)
		VALUES ($1::varchar, $2, $3, $4, $5, $6, $7,
		        (SELECT COALESCE(MAX(position), 0) + 1 FROM daily_rule WHERE user_id = $1::varchar))
		RETURNING rule_id
	`, username, r.TaskType, r.Priority, r.Impact, r.Color, r.Blocked, r.MaxPerDay).Scan(&id); err != nil {
		return fmt.Errorf("insert daily rule: %w", err)
	}
	for _, name := range r.Tags {
		// In-tx tag resolution: a rollback must not leave orphan tag rows.
		tag, err := getOrCreateTag(ctx, tx, name, username)
		if err != nil {
			return fmt.Errorf("create daily rule tag %q: %w", name, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO daily_rule_tag (rule_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
		`, id, tag.TagID); err != nil {
			return fmt.Errorf("link daily rule tag %q: %w", name, err)
		}
	}
	return tx.Commit(ctx)
}

func (db *DB) DeleteDailyRule(ctx context.Context, username string, ruleID int) (bool, error) {
	tag, err := db.Pool.Exec(ctx, `DELETE FROM daily_rule WHERE rule_id = $1 AND user_id = $2`, ruleID, username)
	if err != nil {
		return false, fmt.Errorf("delete daily rule %d: %w", ruleID, err)
	}
	return tag.RowsAffected() > 0, nil
}

// ruleMatches: every SET selector must match the task (AND semantics).
func ruleMatches(r DailyRule, n HomeNote) bool {
	if r.TaskType != nil && n.TaskType != *r.TaskType {
		return false
	}
	if r.Priority != nil && n.Priority != *r.Priority {
		return false
	}
	if r.Impact != nil && n.Impact != *r.Impact {
		return false
	}
	if r.Color != nil && n.Color != *r.Color {
		return false
	}
	if r.Blocked != nil && n.Blocked != *r.Blocked {
		return false
	}
	for _, want := range r.Tags {
		found := false
		for _, t := range n.Tags {
			if t.TagName == want {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// ApplyDailyRules walks candidates IN ORDER (the date-seeded hash order),
// skipping any task whose matching rules are out of quota, and collects up
// to limit — the BACKFILL semantics: capped categories give their slots to
// whatever eligible tasks come next, deterministically.
func ApplyDailyRules(rules []DailyRule, candidates []HomeNote, limit int) []HomeNote {
	quota := make([]int, len(rules))
	for i, r := range rules {
		quota[i] = r.MaxPerDay
	}
	out := []HomeNote{}
	for _, n := range candidates {
		if len(out) >= limit {
			break
		}
		blocked := false
		matched := []int{}
		for i, r := range rules {
			if !ruleMatches(r, n) {
				continue
			}
			matched = append(matched, i)
			if quota[i] == 0 {
				blocked = true
				break
			}
		}
		if blocked {
			continue
		}
		for _, i := range matched {
			if quota[i] > 0 {
				quota[i]--
			}
		}
		out = append(out, n)
	}
	return out
}
