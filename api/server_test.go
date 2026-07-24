package api

import (
	"path/filepath"
	"testing"
)

func TestContainsDotDot(t *testing.T) {
	cases := map[string]bool{
		"/index.html":            false,
		"/":                      false,
		"/js/renderer.js":        false,
		"/..":                    true,
		"/../etc/passwd.html":    true,
		"/js/../../secret.html":  true,
		"/..hidden/file.html":    false, // ".." must be a whole segment
		"/notdotdot../x.html":    false,
		"/a/b/../../../c.html":   true,
		"..":                     true,
		"../above-webroot.html":  true,
		"/./fine.html":           false,
		"/js/vendor/../dmp.html": true,
	}
	for path, want := range cases {
		if got := containsDotDot(path); got != want {
			t.Errorf("containsDotDot(%q) = %v, want %v", path, got, want)
		}
	}
}

// The static handler root-cleans before joining; even if a traversal path
// slipped past the ".." rejection, the join must stay inside web/.
func TestStaticPathJoinStaysInWebRoot(t *testing.T) {
	for _, p := range []string{"/../etc/passwd.html", "/../../x.html", "/a/../../b.html"} {
		got := filepath.Join("web", filepath.Clean("/"+p))
		if got != "web" && !filepathHasPrefix(got, "web/") {
			t.Errorf("join(%q) escaped web root: %q", p, got)
		}
	}
}

func filepathHasPrefix(p, prefix string) bool {
	return len(p) >= len(prefix) && p[:len(prefix)] == prefix
}
