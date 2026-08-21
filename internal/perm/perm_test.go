package perm

import "testing"

// The table in PERMISSIONS_PLAN.md §3, spot-checked so a roles.json edit
// that flips a load-bearing cell fails loudly.
func TestBundles(t *testing.T) {
	cases := []struct {
		roles  []string
		action string
		want   bool
	}{
		{[]string{"admin"}, "see-manuscript", true}, // "so the UI even loads"
		{[]string{"admin"}, "commit-and-push-suggestions", false},
		{[]string{"admin"}, "manage-role-admin", true},
		{[]string{"admin"}, "manage-role-pointer", true},
		{[]string{"author"}, "manage-role-admin", false},
		{[]string{"author"}, "manage-role-reader", true},
		{[]string{"author"}, "manage-others-suggestions", true},
		{[]string{"editor"}, "manage-others-suggestions", true},
		{[]string{"editor"}, "manage-role-editor", false},
		{[]string{"beta-reader"}, "see-others-edits", true},
		{[]string{"beta-reader"}, "manage-others-suggestions", false},
		{[]string{"beta-reader"}, "see-statistics", false},
		{[]string{"beta-reader"}, "see-outline", true},
		{[]string{"reader"}, "see-manuscript", true},
		{[]string{"reader"}, "see-others-notes", false},
		{[]string{"reader"}, "see-outline", false},
		{[]string{"pointer"}, "award-points", true},
		{[]string{"pointer"}, "see-manuscript", false},
		// Union across roles (the normal stacked case).
		{[]string{"admin", "editor"}, "commit-and-push-suggestions", true},
		{[]string{"admin", "editor"}, "manage-manuscript", true},
		{[]string{}, "see-manuscript", false},
	}
	for _, c := range cases {
		if got := Can(c.roles, c.action); got != c.want {
			t.Errorf("Can(%v, %s) = %v, want %v", c.roles, c.action, got, c.want)
		}
	}
}

func TestSeniorityAndDerivation(t *testing.T) {
	if Seniority("admin") != 0 || Seniority("author") != 1 {
		t.Fatalf("seniority order wrong: admin=%d author=%d", Seniority("admin"), Seniority("author"))
	}
	if Seniority("nope") <= Seniority("pointer") {
		t.Fatal("unknown roles must sink below every real role")
	}
	if ManageRoleAction("beta-reader") != "manage-role-beta-reader" {
		t.Fatal("manage-role derivation broken")
	}
	if !ValidRole("beta-reader") || ValidRole("superuser") {
		t.Fatal("ValidRole broken")
	}
	if len(AllRoles()) != 6 {
		t.Fatalf("expected 6 roles, got %v", AllRoles())
	}
}
