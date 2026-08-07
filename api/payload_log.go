package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Durable request log: EVERY request is appended to a daily JSONL file
// BEFORE its handler runs, bodies included, so anything a user typed
// survives even when the save itself fails (a silent sketch-note save bug
// once ate real writing — and the docker logs that might have helped died
// with the container on the next redeploy).
//
//   - every method, every path (static assets included), query strings too;
//   - JSON/text bodies are logged verbatim (10MB cap); other content types
//     (e.g. image uploads) log their content-type + byte count — raw binary
//     in a JSONL is noise, and images land in the DB anyway;
//   - /api/login still logs the request LINE but its body is [redacted] —
//     never log credentials;
//   - files land in <dir>/YYYY-MM-DD.jsonl. In the container that's the
//     host-mounted /logs, which is what makes them survive redeploys;
//     native dev falls back to a logs dir beside the config file.
//
// Disable with MANUSCRIPT_STUDIO_PAYLOAD_LOG=off.

const payloadLogMaxBody = 10 << 20

// resolvePayloadLogDir picks the mounted /logs when it exists (container),
// else a logs dir beside the config file (native dev), else "" (disabled).
func resolvePayloadLogDir() string {
	if os.Getenv("MANUSCRIPT_STUDIO_PAYLOAD_LOG") == "off" {
		return ""
	}
	if st, err := os.Stat("/logs"); err == nil && st.IsDir() {
		return "/logs/payloads"
	}
	if cfg := os.Getenv("MANUSCRIPT_STUDIO_CONFIG_FILE"); cfg != "" {
		return filepath.Join(filepath.Dir(cfg), "logs", "payloads")
	}
	return ""
}

// textualBody: content types whose bytes are worth logging verbatim.
func textualBody(ct string) bool {
	return strings.HasPrefix(ct, "application/json") ||
		strings.HasPrefix(ct, "text/") ||
		strings.HasPrefix(ct, "application/x-www-form-urlencoded")
}

type payloadLogger struct {
	mu  sync.Mutex
	dir string
}

func (pl *payloadLogger) write(entry map[string]interface{}) {
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	pl.mu.Lock()
	defer pl.mu.Unlock()
	if err := os.MkdirAll(pl.dir, 0o755); err != nil {
		return
	}
	name := filepath.Join(pl.dir, time.Now().UTC().Format("2006-01-02")+".jsonl")
	f, err := os.OpenFile(name, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	f.Write(append(line, '\n'))
}

// payloadLogMiddleware tees every request into the log and hands the
// handler an untouched replacement body reader. Logging is best-effort: it
// must never fail or block a request beyond the file append.
func payloadLogMiddleware(dir string) func(http.Handler) http.Handler {
	pl := &payloadLogger{dir: dir}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			entry := map[string]interface{}{
				"ts":     time.Now().UTC().Format(time.RFC3339Nano),
				"method": r.Method,
				"path":   r.URL.Path,
			}
			if q := r.URL.RawQuery; q != "" {
				entry["query"] = q
			}
			ct := r.Header.Get("Content-Type")
			if r.Body != nil && r.ContentLength != 0 {
				if r.URL.Path == "/api/login" {
					entry["body_raw"] = "[redacted]"
					// The handler still needs the credentials — don't consume.
				} else if textualBody(ct) {
					body, err := io.ReadAll(io.LimitReader(r.Body, payloadLogMaxBody))
					if err == nil {
						rest := r.Body // anything beyond the cap still reaches the handler
						r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(body), rest))
						if json.Valid(body) {
							entry["body"] = json.RawMessage(body)
						} else if len(body) > 0 {
							entry["body_raw"] = string(body)
						}
					}
				} else {
					entry["content_type"] = ct
					if r.ContentLength > 0 {
						entry["body_bytes"] = r.ContentLength
					}
				}
			}
			pl.write(entry)
			next.ServeHTTP(w, r)
		})
	}
}
