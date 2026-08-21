// Package perm is the permissions v3 kernel (PERMISSIONS_PLAN.md): the
// embedded roles.json maps roles to action bundles; everything else in the
// server asks "does this set of roles include this action?" through here.
package perm

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
)

//go:embed roles.json
var rolesJSON []byte

type rolesFile struct {
	Seniority []string            `json:"seniority"`
	Roles     map[string][]string `json:"roles"`
}

var parsed rolesFile

func init() {
	if err := json.Unmarshal(rolesJSON, &parsed); err != nil {
		panic(fmt.Sprintf("perm: embedded roles.json is invalid: %v", err))
	}
	for _, r := range parsed.Seniority {
		if _, ok := parsed.Roles[r]; !ok {
			panic(fmt.Sprintf("perm: seniority lists unknown role %q", r))
		}
	}
	if len(parsed.Seniority) != len(parsed.Roles) {
		panic("perm: seniority must list every role exactly once")
	}
}

// RolesJSON returns the embedded file verbatim (served at GET api/roles).
func RolesJSON() []byte { return rolesJSON }

// ValidRole reports whether the role name exists.
func ValidRole(role string) bool {
	_, ok := parsed.Roles[role]
	return ok
}

// AllRoles returns the role names in seniority order (highest first).
func AllRoles() []string {
	out := make([]string, len(parsed.Seniority))
	copy(out, parsed.Seniority)
	return out
}

// Seniority returns a role's rank (0 = most senior); unknown roles sink.
func Seniority(role string) int {
	for i, r := range parsed.Seniority {
		if r == role {
			return i
		}
	}
	return len(parsed.Seniority)
}

// Actions returns the union of the given roles' action sets.
func Actions(roles []string) map[string]bool {
	out := make(map[string]bool)
	for _, r := range roles {
		for _, a := range parsed.Roles[r] {
			out[a] = true
		}
	}
	return out
}

// ActionList is Actions flattened and sorted (stable JSON payloads).
func ActionList(roles []string) []string {
	set := Actions(roles)
	out := make([]string, 0, len(set))
	for a := range set {
		out = append(out, a)
	}
	sort.Strings(out)
	return out
}

// Can reports whether any of the roles grants the action.
func Can(roles []string, action string) bool {
	return Actions(roles)[action]
}

// ManageRoleAction derives the permission needed to grant/revoke a role —
// the generalized manage-role-<role> scheme.
func ManageRoleAction(role string) string {
	return "manage-role-" + role
}
