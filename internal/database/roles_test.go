package database

// Role-grant integration tests (038, PERMISSIONS_PLAN v3): grants, the
// visibility gate, last-admin protection, People ordering storage.

import (
	"errors"
	"testing"
)

func TestRoles_GrantRevokeLastAdmin(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)

	// Fixture starts with no roles → invisible.
	if ok, _ := f.db.HasAnyRole(f.ctx, f.username, f.manuscriptID); ok {
		t.Fatal("fresh fixture should have no roles")
	}

	for _, r := range []string{"admin", "editor"} {
		if err := f.db.GrantRole(f.ctx, f.username, f.manuscriptID, r); err != nil {
			t.Fatalf("grant %s: %v", r, err)
		}
	}
	// Idempotent.
	if err := f.db.GrantRole(f.ctx, f.username, f.manuscriptID, "admin"); err != nil {
		t.Fatalf("re-grant: %v", err)
	}
	if ok, _ := f.db.HasAnyRole(f.ctx, f.username, f.manuscriptID); !ok {
		t.Fatal("granted user must be visible")
	}
	roles, err := f.db.GetRolesForUser(f.ctx, f.username, f.manuscriptID)
	if err != nil || len(roles) != 2 {
		t.Fatalf("roles = %v, %v", roles, err)
	}

	// Last-admin protection: sole admin cannot lose admin.
	if err := f.db.RevokeRole(f.ctx, f.username, f.manuscriptID, "admin"); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("expected ErrLastAdmin, got %v", err)
	}
	// A second admin unlocks the revoke.
	if err := f.db.GrantRole(f.ctx, other, f.manuscriptID, "admin"); err != nil {
		t.Fatalf("grant other admin: %v", err)
	}
	if err := f.db.RevokeRole(f.ctx, f.username, f.manuscriptID, "admin"); err != nil {
		t.Fatalf("revoke with second admin present: %v", err)
	}
	// Non-admin revokes never trip the guard.
	if err := f.db.RevokeRole(f.ctx, f.username, f.manuscriptID, "editor"); err != nil {
		t.Fatalf("revoke editor: %v", err)
	}
	if ok, _ := f.db.HasAnyRole(f.ctx, f.username, f.manuscriptID); ok {
		t.Fatal("user with no roles left must lose visibility")
	}

	// HasRoleAnywhere sees the other user's admin.
	if ok, _ := f.db.HasRoleAnywhere(f.ctx, other, "admin"); !ok {
		t.Fatal("HasRoleAnywhere missed the grant")
	}

	members, err := f.db.ListRoleMembers(f.ctx, f.manuscriptID)
	if err != nil || len(members) != 1 || members[0].Username != other {
		t.Fatalf("members = %+v, %v", members, err)
	}
}

func TestPeopleOrder_RoundTrip(t *testing.T) {
	f := newITFixture(t)
	if got, err := f.db.GetPeopleOrder(f.ctx, f.username, f.manuscriptID); err != nil || got != nil {
		t.Fatalf("unset order = %v, %v (want nil, nil)", got, err)
	}
	want := []string{"b", "a", "c"}
	if err := f.db.SetPeopleOrder(f.ctx, f.username, f.manuscriptID, want); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, err := f.db.GetPeopleOrder(f.ctx, f.username, f.manuscriptID)
	if err != nil || len(got) != 3 || got[0] != "b" || got[2] != "c" {
		t.Fatalf("get = %v, %v", got, err)
	}
	// Upsert replaces.
	if err := f.db.SetPeopleOrder(f.ctx, f.username, f.manuscriptID, []string{"c"}); err != nil {
		t.Fatalf("re-set: %v", err)
	}
	if got, _ := f.db.GetPeopleOrder(f.ctx, f.username, f.manuscriptID); len(got) != 1 || got[0] != "c" {
		t.Fatalf("re-get = %v", got)
	}
	// Cleanup so the fixture nuke doesn't trip the FK.
	f.pool.Exec(f.ctx, `DELETE FROM people_order WHERE manuscript_id = $1`, f.manuscriptID)
}
