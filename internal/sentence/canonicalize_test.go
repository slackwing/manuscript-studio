package sentence

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type canonScenario struct {
	Name string `json:"name"`
	In   string `json:"in"`
	Out  string `json:"out"`
}

func loadCanonScenarios(t *testing.T) []canonScenario {
	t.Helper()
	// tests/canonicalize-scenarios.jsonl lives at the repo root's tests dir.
	path := filepath.Join("..", "..", "tests", "canonicalize-scenarios.jsonl")
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open scenarios: %v", err)
	}
	defer f.Close()

	var out []canonScenario
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var s canonScenario
		if err := json.Unmarshal(line, &s); err != nil {
			t.Fatalf("parse scenario %q: %v", string(line), err)
		}
		out = append(out, s)
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan scenarios: %v", err)
	}
	return out
}

func TestCanonicalize_Scenarios(t *testing.T) {
	for _, s := range loadCanonScenarios(t) {
		got := Canonicalize(s.In)
		if got != s.Out {
			t.Errorf("%s: Canonicalize(%q) = %q, want %q", s.Name, s.In, got, s.Out)
		}
		// Idempotence: canonical output is a fixed point.
		if again := Canonicalize(got); again != got {
			t.Errorf("%s: not idempotent: Canonicalize(%q) = %q", s.Name, got, again)
		}
	}
}
