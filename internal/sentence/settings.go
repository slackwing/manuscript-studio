package sentence

import "strings"

// Book-wide settings declared via &meta{property}{value} (TEX_COMMANDS_PLAN.md
// §5.5). A fixed, known property vocabulary — each maps to a specific render
// behavior. Unknown properties or out-of-range values are dropped (and can be
// surfaced as warnings). Title stays &title (content); settings never render.

// metaProperties is the closed set of valid &meta properties and their allowed
// values. An empty value-set means "any non-empty value" (e.g. a font name).
var metaProperties = map[string]map[string]bool{
	"chapter-align":  {"left": true, "center": true},
	"part-align":     {"left": true, "center": true},
	"title-align":    {"left": true, "center": true},
	"divider-folios": {"on": true, "off": true},
	// Open-valued (any non-empty string accepted):
	"font": nil,
}

// Settings is the validated property→value map read from a migration's &meta
// sentences. Last-one-wins for a repeated property.
type Settings struct {
	Values  map[string]string
	Unknown []string // properties that were not recognized (for warnings)
}

// ExtractSettings scans (ordinal-ordered) sentences for &meta commands and
// returns the validated settings plus any unknown/invalid property names.
// Last occurrence of a property wins.
func ExtractSettings(ids []string, textByID map[string]string) Settings {
	s := Settings{Values: map[string]string{}}
	seenUnknown := map[string]bool{}
	for _, id := range ids {
		text, ok := textByID[id]
		if !ok {
			continue
		}
		cmd, ok := ParseCommand(strings.TrimSpace(text))
		if !ok || cmd.Kind != CmdMeta || cmd.Raw != strings.TrimSpace(text) {
			continue
		}
		if len(cmd.Args) < 2 {
			continue
		}
		prop := strings.TrimSpace(cmd.Args[0])
		val := strings.TrimSpace(cmd.Args[1])
		allowed, known := metaProperties[prop]
		if !known {
			if !seenUnknown[prop] {
				seenUnknown[prop] = true
				s.Unknown = append(s.Unknown, prop)
			}
			continue
		}
		if allowed != nil && !allowed[val] {
			// Out-of-range value for a fixed-vocabulary property — ignore.
			continue
		}
		if val == "" {
			continue
		}
		s.Values[prop] = val // last-wins
	}
	return s
}
