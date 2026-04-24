package segman

import (
	_ "embed"
	"encoding/json"
)

// EmbeddedVersion returns the segman version baked in at build time, sourced
// from internal/segman/VERSION.json (which scripts/vendor-segman.sh keeps in
// sync with the upstream repo). The format mirrors what we want stamped on
// the migration row: "segman-1.0.0".
//
// We use go:embed instead of upstream segman.go's runtime os.ReadFile —
// embedding makes the version part of the binary, so it can't drift from
// the code it ships with, and works regardless of working directory.
//
// Auto-flow chain: vendor-segman.sh writes VERSION.json → go:embed picks it
// up at build time → processor.go uses EmbeddedVersion as the source for
// migration.segmenter. Bumping segman upstream + re-vendoring is enough.
func EmbeddedVersion() string {
	if cachedEmbeddedVersion != "" {
		return cachedEmbeddedVersion
	}
	var v struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(versionJSON, &v); err != nil || v.Version == "" {
		cachedEmbeddedVersion = "segman-unknown"
	} else {
		cachedEmbeddedVersion = "segman-" + v.Version
	}
	return cachedEmbeddedVersion
}

//go:embed VERSION.json
var versionJSON []byte

var cachedEmbeddedVersion string
