package database

// Marker symbols (settings "Markers"): slug → shape CRUD, user-scoped.

import "testing"

func TestMarkerSymbols_CRUD(t *testing.T) {
	f := newITFixture(t)

	if err := f.db.UpsertMarkerSymbol(f.ctx, f.username, "weird", "triangle-down"); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := f.db.UpsertMarkerSymbol(f.ctx, f.username, "digression", "triangle-down"); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	// Re-map in place (the picker's second click).
	if err := f.db.UpsertMarkerSymbol(f.ctx, f.username, "weird", "circle"); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}

	m, err := f.db.ListMarkerSymbols(f.ctx, f.username)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(m) != 2 || m["weird"] != "circle" || m["digression"] != "triangle-down" {
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
	if len(m) != 1 {
		t.Errorf("after delete: %v", m)
	}
}
