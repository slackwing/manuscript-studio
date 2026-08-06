package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The request log must capture bodies verbatim (that's its whole point —
// recovering typed text after a failed save), redact login credentials,
// note binary uploads without dumping bytes, and hand handlers an intact
// body.
func TestPayloadLogMiddleware(t *testing.T) {
	dir := t.TempDir()
	var handlerSaw string
	h := payloadLogMiddleware(dir)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		handlerSaw = string(b)
	}))

	do := func(method, path, ct, body string) {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		h.ServeHTTP(httptest.NewRecorder(), req)
	}

	do("PUT", "/api/notes/7", "application/json", `{"body":"typed words that must survive"}`)
	do("POST", "/api/login", "application/json", `{"username":"u","password":"hunter2"}`)
	do("GET", "/api/sketches?q=needle", "", "")
	do("POST", "/api/scratchpads/1/images", "image/png", "\x89PNG-binary-bytes")

	if handlerSaw != "\x89PNG-binary-bytes" {
		t.Errorf("handler must receive the body untouched, got %q", handlerSaw)
	}

	name := filepath.Join(dir, time.Now().UTC().Format("2006-01-02")+".jsonl")
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("log file missing: %v", err)
	}
	log := string(data)
	if !strings.Contains(log, "typed words that must survive") {
		t.Errorf("JSON body not captured verbatim:\n%s", log)
	}
	if strings.Contains(log, "hunter2") {
		t.Errorf("login credentials leaked into the log:\n%s", log)
	}
	if !strings.Contains(log, `"/api/login"`) {
		t.Errorf("login request line should still be logged:\n%s", log)
	}
	if !strings.Contains(log, `"query":"q=needle"`) {
		t.Errorf("GET with query string not logged:\n%s", log)
	}
	if strings.Contains(log, "PNG-binary-bytes") {
		t.Errorf("binary bytes must not be dumped:\n%s", log)
	}
	if !strings.Contains(log, `"content_type":"image/png"`) {
		t.Errorf("binary upload should log its content type:\n%s", log)
	}
	if lines := strings.Count(log, "\n"); lines != 4 {
		t.Errorf("want 4 entries (one per request), got %d:\n%s", lines, log)
	}
}
