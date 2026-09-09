package database

// Marker symbols (settings "Markers"): slug → shape CRUD, user-scoped.

import "testing"

func TestMarkerSymbols_CRUD(t *testing.T) {
	f := newITFixture(t)
	sp := func(s string) *string { return &s }
	ip := func(n int) *int { return &n }

	// Fresh row via empty partial: server defaults — ※ ('default') / 0.
	if err := f.db.UpsertMarkerSymbol(f.ctx, f.username, "fresh", nil, nil); err != nil {
		t.Fatalf("fresh: %v", err)
	}
	if err := f.db.UpsertMarkerSymbol(f.ctx, f.username, "weird", sp("triangle-down"), nil); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := f.db.UpsertMarkerSymbol(f.ctx, f.username, "digression", sp("triangle-down"), ip(-15)); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	// Partial updates leave the other field alone (the picker's second
	// click must not zero the attention, and vice versa).
	if err := f.db.UpsertMarkerSymbol(f.ctx, f.username, "weird", sp("circle"), nil); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	if err := f.db.UpsertMarkerSymbol(f.ctx, f.username, "weird", nil, ip(-5)); err != nil {
		t.Fatalf("attention only: %v", err)
	}

	m, err := f.db.ListMarkerSymbols(f.ctx, f.username)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(m) != 3 || m["fresh"] != (MarkerConfig{"default", 0}) ||
		m["weird"] != (MarkerConfig{"circle", -5}) ||
		m["digression"] != (MarkerConfig{"triangle-down", -15}) {
		t.Errorf("map = %v", m)
	}

	// User-scoped: another user sees nothing.
	other := f.newUser(t)
	m2, err := f.db.ListMarkerSymbols(f.ctx, other)
	if err != nil || len(m2) != 0 {
		t.Errorf("other user's map = %v (err=%v)", m2, err)
	}

	existed, err := f.db.DeleteMarkerSymbol(f.ctx, f.username, "weird")
	if err != nil || !existed {
		t.Fatalf("delete: existed=%v err=%v", existed, err)
	}
	existed, _ = f.db.DeleteMarkerSymbol(f.ctx, f.username, "weird")
	if existed {
		t.Error("second delete should report false")
	}
	m, _ = f.db.ListMarkerSymbols(f.ctx, f.username)
	if len(m) != 2 {
		t.Errorf("after delete: %v", m)
	}
}

// user_pref (046): first tenant is marker_display. Empty value unsets.
func TestUserPref_SetGetUnset(t *testing.T) {
	f := newITFixture(t)
	v, err := f.db.GetUserPref(f.ctx, f.username, "marker_display")
	if err != nil || v != "" {
		t.Fatalf("unset pref: %q err=%v", v, err)
	}
	if err := f.db.SetUserPref(f.ctx, f.username, "marker_display", "on"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if v, _ = f.db.GetUserPref(f.ctx, f.username, "marker_display"); v != "on" {
		t.Errorf("get = %q, want on", v)
	}
	other := f.newUser(t)
	if v, _ = f.db.GetUserPref(f.ctx, other, "marker_display"); v != "" {
		t.Errorf("cross-user pref leaked: %q", v)
	}
	if err := f.db.SetUserPref(f.ctx, f.username, "marker_display", ""); err != nil {
		t.Fatalf("unset: %v", err)
	}
	if v, _ = f.db.GetUserPref(f.ctx, f.username, "marker_display"); v != "" {
		t.Errorf("after unset = %q, want empty", v)
	}
}
