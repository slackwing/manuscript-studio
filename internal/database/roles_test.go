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
