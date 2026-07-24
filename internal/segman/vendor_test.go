package segman

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// These tests guard against segman-vendor drift — the misstep where segman
// gets a new tag but the vendored copy here is never refreshed, so the app
// silently keeps shipping an old segmenter. See TEX_COMMANDS_PLAN.md / the
// vendor discipline in AGENTS.md N8.
//
// Two distinct checks:
//
//  1. Internal consistency (always runs, even in CI/Docker with no segman
//     checkout): UPSTREAM's `ref:` must match this file's const Version. A
//     botched vendor — new provenance stamp but stale code, or vice versa —
//     fails here with nothing external required.
//
//  2. Upstream freshness (runs only when ~/src/segman is reachable; skips
//     cleanly otherwise so CI never goes falsely red): UPSTREAM's ref must be
//     the newest segman tag. This is the drift that shipped 1.0.0 to prod for
//     months after 1.1.x was tagged.

var refLine = regexp.MustCompile(`(?m)^ref:\s*(\S+)`)

// vendoredRef reads the `ref:` field from internal/segman/UPSTREAM.
func vendoredRef(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("UPSTREAM")
	if err != nil {
		t.Fatalf("read UPSTREAM: %v", err)
	}
	m := refLine.FindSubmatch(data)
	if m == nil {
		t.Fatalf("UPSTREAM has no `ref:` line:\n%s", data)
	}
	return string(m[1])
}

// TestVendorRefMatchesVersion enforces check #1. It needs no external repo.
func TestVendorRefMatchesVersion(t *testing.T) {
	ref := vendoredRef(t)
	// The tag is "vX.Y.Z"; the code const is "X.Y.Z".
	wantTag := "v" + Version
	if ref != wantTag {
		t.Fatalf("vendor inconsistency: UPSTREAM ref=%q but segman.go const Version=%q "+
			"(expected ref %q).\nThe vendored code and its provenance stamp disagree — "+
			"re-run scripts/vendor-segman.sh --ref=%s to fix.",
			ref, Version, wantTag, wantTag)
	}
}

// TestVendorIsLatestTag enforces check #2, but only where the segman repo is
// available. It skips (does not fail) when segman or git is absent, so CI and
// Docker builds don't go red for a check that only makes sense on a dev/deploy
// machine.
func TestVendorIsLatestTag(t *testing.T) {
	segmanDir := os.Getenv("SEGMAN_DIR")
	if segmanDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("no home dir to locate segman: %v", err)
		}
		segmanDir = filepath.Join(home, "src", "segman")
	}
	if _, err := os.Stat(filepath.Join(segmanDir, ".git")); err != nil {
		t.Skipf("segman repo not found at %s (set SEGMAN_DIR to enable this check)", segmanDir)
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	// Refresh tags so we compare against the true latest, not a stale local
	// clone (best-effort — offline is fine, we just use what's local). This
	// closes the subtle case: a bump pushed from another machine that this
	// clone hasn't seen yet.
	_ = exec.Command("git", "-C", segmanDir, "fetch", "--quiet", "--tags", "origin").Run()

	// Newest tag by version sort.
	out, err := exec.Command("git", "-C", segmanDir, "tag", "--sort=-v:refname").Output()
	if err != nil {
		t.Skipf("git tag in %s failed: %v", segmanDir, err)
	}
	tags := strings.Fields(strings.TrimSpace(string(out)))
	if len(tags) == 0 {
		t.Skipf("no tags in %s", segmanDir)
	}
	latest := tags[0]
	ref := vendoredRef(t)
	if ref != latest {
		t.Errorf("segman-vendor drift: vendored ref=%q but latest segman tag=%q.\n"+
			"Re-vendor before deploying:\n"+
			"    cd %s && git fetch --tags   # if the local clone is behind\n"+
			"    scripts/vendor-segman.sh --ref=%s\n"+
			"(then commit internal/segman/). This is the drift that kept prod on an old "+
			"segmenter — a bump alone doesn't reach the app until it's re-vendored.",
			ref, latest, segmanDir, latest)
	}
}
