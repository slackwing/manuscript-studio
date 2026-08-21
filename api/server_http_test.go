package api

// Router/middleware tests (CODE_REVIEW_AUG_2026.md AREA 2 rows #135–140):
// base-path stripping, per-route body limits, static cache policy, base-href
// injection, /readyz states, and the wordcount cron's disabled/cancel exits.
//
// Static-file tests chdir into a temp dir holding a fake web/ root (the
// static handler reads relative "web/..." paths). Body-limit and readyz
// tests need the dev fixture DB (localhost:5433) and skip when it's absent.

import (
	"bytes"
	"context"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
)

var serverTestCounter int64

func testConfig() *config.Config {
	return &config.Config{
		Server: config.ServerConfig{Env: "development"},
	}
}

// newTestServer builds a Server. pool may be nil for tests that never touch
// the DB (no route in those tests reaches a query; the session-store
// cleanup ticker only fires every 15 minutes).
func newTestServer(t *testing.T, cfg *config.Config, pool *pgxpool.Pool) *Server {
	t.Helper()
	t.Setenv("MANUSCRIPT_STUDIO_PAYLOAD_LOG", "off")
	return NewServer(cfg, pool)
}

// chdirTempWeb creates <tmp>/web with the given files and chdirs there for
// the duration of the test.
func chdirTempWeb(t *testing.T, files map[string]string) {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		p := filepath.Join(dir, "web", name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	old, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(old); err != nil {
			t.Errorf("restore cwd: %v", err)
		}
	})
}

func serve(s *Server, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	return rec
}

// ---------------------------------------------------------------- #135

func TestBasePathStrip_ExactAndPrefix(t *testing.T) {
	chdirTempWeb(t, map[string]string{
		"index.html": "<html><head></head><body>home</body></html>",
	})
	cfg := testConfig()
	cfg.Server.BasePath = "/studio"
	s := newTestServer(t, cfg, nil)

	// Prefixed route reaches the root-relative handler.
	rec := serve(s, httptest.NewRequest(http.MethodGet, "/studio/livez", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "alive") {
		t.Errorf("/studio/livez → %d %q, want 200 alive", rec.Code, rec.Body.String())
	}

	// Unprefixed still works — the strip only rewrites matching paths.
	rec = serve(s, httptest.NewRequest(http.MethodGet, "/livez", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("/livez → %d, want 200", rec.Code)
	}

	// EXACT match rewrites to "/" (the review's exact-match case): the
	// static handler then serves index.html.
	rec = serve(s, httptest.NewRequest(http.MethodGet, "/studio", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "home") {
		t.Errorf("/studio (exact) → %d %q, want 200 index.html", rec.Code, rec.Body.String())
	}

	// A prefix that merely STARTS with the base path is NOT stripped
	// ("/studiox" must not match "/studio").
	rec = serve(s, httptest.NewRequest(http.MethodGet, "/studiox/livez", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("/studiox/livez → %d, want 404 (no strip)", rec.Code)
	}
}

// ---------------------------------------------------------------- #137

func TestStatic_CachePolicyMatrix(t *testing.T) {
	chdirTempWeb(t, map[string]string{
		"index.html": "<html><head></head><body>x</body></html>",
		"js/app.js":  "// js",
	})
	s := newTestServer(t, testConfig(), nil)

	cases := []struct {
		path       string
		wantStatus int // ServeFile 301s direct /index.html to "./" — the
		// policy header is set either way, before serving.
		want string
	}{
		{"/", http.StatusOK, "no-store"},                                              // rewrites to index.html
		{"/index.html", http.StatusMovedPermanently, "no-store"},                      // HTML: never cached
		{"/js/app.js?v=abc123", http.StatusOK, "public, max-age=31536000, immutable"}, // busted asset
		{"/js/app.js", http.StatusOK, "no-cache"},                                     // plain asset: revalidate
		{"/index.html?v=abc123", http.StatusMovedPermanently, "no-store"},             // html wins over ?v=
	}
	for _, tc := range cases {
		rec := serve(s, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if rec.Code != tc.wantStatus {
			t.Errorf("%s → %d, want %d", tc.path, rec.Code, tc.wantStatus)
			continue
		}
		if got := rec.Header().Get("Cache-Control"); got != tc.want {
			t.Errorf("%s Cache-Control = %q, want %q", tc.path, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------- #138

func TestStatic_BaseHrefInjection(t *testing.T) {
	chdirTempWeb(t, map[string]string{
		"index.html":    "<html><head><title>t</title></head><body>page</body></html>",
		"headless.html": "<html><body>no head tag</body></html>",
		"js/app.js":     "// <head> in a comment must not be touched",
	})
	cfg := testConfig()
	cfg.Server.BasePath = "/studio"
	s := newTestServer(t, cfg, nil)

	rec := serve(s, httptest.NewRequest(http.MethodGet, "/studio/index.html", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("index → %d", rec.Code)
	}
	body := rec.Body.String()
	const tag = `<base href="/studio/">`
	if n := strings.Count(body, tag); n != 1 {
		t.Errorf("base-href injected %d times, want exactly 1; body: %q", n, body)
	}
	// Injected immediately after <head>, so it precedes every other head child.
	if !strings.Contains(body, "<head>\n  "+tag) {
		t.Errorf("tag not injected right after <head>: %q", body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}

	// HTML without <head> passes through unmodified (Replace no-op).
	rec = serve(s, httptest.NewRequest(http.MethodGet, "/studio/headless.html", nil))
	if strings.Contains(rec.Body.String(), "<base") {
		t.Errorf("headless.html gained a base tag: %q", rec.Body.String())
	}

	// Non-HTML is never injected.
	rec = serve(s, httptest.NewRequest(http.MethodGet, "/studio/js/app.js", nil))
	if strings.Contains(rec.Body.String(), "<base") {
		t.Errorf("js asset gained a base tag: %q", rec.Body.String())
	}

	// No base path → no injection even in HTML (an unnecessary <base
	// href="/"> breaks Paged.js).
	s2 := newTestServer(t, testConfig(), nil)
	rec = serve(s2, httptest.NewRequest(http.MethodGet, "/index.html", nil))
	if strings.Contains(rec.Body.String(), "<base") {
		t.Errorf("basePath-less server injected a base tag: %q", rec.Body.String())
	}
}

// ---------------------------------------------------------------- dev-DB fixture

func connectServerTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("MANUSCRIPT_STUDIO_TEST_DB_URL")
	if url == "" {
		url = "postgres://manuscript_dev:manuscript_dev@localhost:5433/manuscript_studio_dev"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Skipf("test DB unreachable, skipping integration test: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("test DB ping failed, skipping integration test: %v", err)
	}
	return pool
}

// authedFixture mints a user + session (+ CSRF token) directly in the dev DB
// and cleans all of it up.
type authedFixture struct {
	pool         *pgxpool.Pool
	user         string
	sessionToken string
	csrfToken    string
}

func newAuthedFixture(t *testing.T) *authedFixture {
	t.Helper()
	pool := connectServerTestDB(t)
	ctx := context.Background()
	n := atomic.AddInt64(&serverTestCounter, 1)
	user := fmt.Sprintf("srv-test-%d-%d", time.Now().UnixNano(), n)
	f := &authedFixture{
		pool:         pool,
		user:         user,
		sessionToken: fmt.Sprintf("srv-test-session-%s", user),
		csrfToken:    fmt.Sprintf("srv-test-csrf-%s", user),
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO "user" (username, password_hash, role)
		VALUES ($1, '$2a$10$dummy', 'author')
	`, user); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO session (id, username, csrf_token, created_at, expires_at, last_activity_at)
		VALUES ($1, $2, $3, NOW(), NOW() + interval '1 hour', NOW())
	`, f.sessionToken, user, f.csrfToken); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	t.Cleanup(func() {
		for _, sql := range []string{
			`DELETE FROM session WHERE username = $1`,
			`DELETE FROM scratchpad_revision WHERE scratchpad_id IN (SELECT scratchpad_id FROM scratchpad WHERE user_id = $1)`,
			`DELETE FROM scratchpad WHERE user_id = $1`,
			`DELETE FROM scratchpad_image WHERE user_id = $1`,
			`DELETE FROM "user" WHERE username = $1`,
		} {
			if _, err := pool.Exec(ctx, sql, user); err != nil {
				t.Errorf("cleanup %q: %v", sql[:40], err)
			}
		}
		pool.Close()
	})
	return f
}

func (f *authedFixture) authorize(req *http.Request) {
	req.AddCookie(&http.Cookie{Name: "session_token", Value: f.sessionToken})
	req.Header.Set("X-CSRF-Token", f.csrfToken)
}

// ---------------------------------------------------------------- #136

// The body-limit middleware runs BEFORE base-path stripping and matches by
// suffix: 1MiB default, 11MB for POST …/api/scratchpad-images, 5MB for PUT
// …/api/scratchpads/… (server.go:170–182).
func TestBodyLimits_ByRoute(t *testing.T) {
	f := newAuthedFixture(t)
	s := newTestServer(t, testConfig(), f.pool)
	ctx := context.Background()

	// --- default 1MiB: /api/login reads its body with no auth in the way.
	pad := strings.Repeat("x", 900<<10) // ~0.9MiB: under the cap
	body := fmt.Sprintf(`{"username":"srv-test-nobody","password":"pw","pad":"%s"}`, pad)
	req := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := serve(s, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("login under limit → %d %q, want 401 (body was readable)", rec.Code, rec.Body.String())
	}

	pad = strings.Repeat("x", (1<<20)+4096) // just over 1MiB
	body = fmt.Sprintf(`{"username":"srv-test-nobody","password":"pw","pad":"%s"}`, pad)
	req = httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec = serve(s, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("login over limit → %d, want 400 (MaxBytesReader tripped)", rec.Code)
	}

	// --- PUT /api/scratchpads/{id}: 5MB exception. A 2MB doc must go
	// through (the 1MiB default would have killed it); an oversized one must
	// not reach the DB.
	db := &database.DB{Pool: f.pool}
	padRow, err := db.CreateScratchpad(ctx, f.user, "limits pad")
	if err != nil {
		t.Fatalf("CreateScratchpad: %v", err)
	}
	docBody := func(size int) string {
		text := strings.Repeat("y", size)
		return fmt.Sprintf(`{"title":"limits pad","doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"%s"}]}]}}`, text)
	}
	req = httptest.NewRequest(http.MethodPut, fmt.Sprintf("/api/scratchpads/%d", padRow.ScratchpadID), strings.NewReader(docBody(2<<20)))
	req.Header.Set("Content-Type", "application/json")
	f.authorize(req)
	rec = serve(s, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("2MB scratchpad PUT → %d %q, want 204 (route exempt from the 1MiB default)", rec.Code, rec.Body.String())
	}
	req = httptest.NewRequest(http.MethodPut, fmt.Sprintf("/api/scratchpads/%d", padRow.ScratchpadID), strings.NewReader(docBody(6<<20)))
	req.Header.Set("Content-Type", "application/json")
	f.authorize(req)
	rec = serve(s, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("6MB scratchpad PUT → %d, want 400 (over every cap)", rec.Code)
	}

	// --- POST /api/scratchpad-images: 11MB exception. 2MB upload passes the
	// limiter (proving the exemption); 12MB dies in ParseMultipartForm.
	multipartImage := func(size int) (*bytes.Buffer, string) {
		buf := &bytes.Buffer{}
		w := multipart.NewWriter(buf)
		hdr := textproto.MIMEHeader{}
		hdr.Set("Content-Disposition", `form-data; name="image"; filename="big.png"`)
		hdr.Set("Content-Type", "image/png")
		part, err := w.CreatePart(hdr)
		if err != nil {
			t.Fatalf("create part: %v", err)
		}
		part.Write(bytes.Repeat([]byte{0xAB}, size))
		w.Close()
		return buf, w.FormDataContentType()
	}
	buf, ctype := multipartImage(2 << 20)
	req = httptest.NewRequest(http.MethodPost, "/api/scratchpad-images", buf)
	req.Header.Set("Content-Type", ctype)
	f.authorize(req)
	rec = serve(s, req)
	if rec.Code != http.StatusCreated {
		t.Errorf("2MB image upload → %d %q, want 201 (route exempt from the 1MiB default)", rec.Code, rec.Body.String())
	}
	buf, ctype = multipartImage(12 << 20)
	req = httptest.NewRequest(http.MethodPost, "/api/scratchpad-images", buf)
	req.Header.Set("Content-Type", ctype)
	f.authorize(req)
	rec = serve(s, req)
	if rec.Code != http.StatusBadRequest && rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("12MB image upload → %d, want rejected (over the 11MB cap)", rec.Code)
	}
}

// ---------------------------------------------------------------- #139

func TestReadyz_DegradedVsUnhealthy(t *testing.T) {
	pool := connectServerTestDB(t)
	defer pool.Close()

	// Healthy: DB pings, no repos configured.
	s := newTestServer(t, testConfig(), pool)
	rec := serve(s, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"healthy"`) {
		t.Errorf("healthy: %d %q", rec.Code, rec.Body.String())
	}

	// Degraded: DB fine, a configured repo not yet cloned → 200 degraded
	// (the first sync will create it; the pod must not be killed for this).
	cfg := testConfig()
	cfg.Paths.ReposDir = t.TempDir()
	cfg.GitRepos = []config.GitRepoConfig{{Name: "never-cloned"}}
	s = newTestServer(t, cfg, pool)
	rec = serve(s, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"degraded"`) {
		t.Errorf("degraded: %d %q", rec.Code, rec.Body.String())
	}

	// /health is an alias of /readyz.
	rec = serve(s, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"degraded"`) {
		t.Errorf("/health alias: %d %q", rec.Code, rec.Body.String())
	}

	// Unhealthy: DB unreachable → 503, regardless of repos.
	badPool, err := pgxpool.New(context.Background(), "postgres://x:x@127.0.0.1:1/x")
	if err != nil {
		t.Fatalf("bad pool: %v", err)
	}
	defer badPool.Close()
	s = newTestServer(t, testConfig(), badPool)
	rec = serve(s, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"unhealthy"`) {
		t.Errorf("unhealthy: %d %q", rec.Code, rec.Body.String())
	}

	// livez stays alive no matter what.
	rec = serve(s, httptest.NewRequest(http.MethodGet, "/livez", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"alive"`) {
		t.Errorf("livez: %d %q", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------- #140

func TestRunWordcountCron_DisabledNoop(t *testing.T) {
	// Disabled → immediate return, no ticker, no DB touch (nil pool would
	// panic if anything ran).
	s := newTestServer(t, testConfig(), nil)
	done := make(chan struct{})
	go func() {
		s.RunWordcountCron(context.Background())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("disabled cron did not return immediately")
	}
}

func TestRunWordcountCron_ContextCancelExits(t *testing.T) {
	// Enabled: one immediate run (harmlessly failing against an unreachable
	// pool), then the canceled context must exit the loop.
	badPool, err := pgxpool.New(context.Background(), "postgres://x:x@127.0.0.1:1/x")
	if err != nil {
		t.Fatalf("bad pool: %v", err)
	}
	defer badPool.Close()

	cfg := testConfig()
	cfg.WordcountHistory.Enabled = true
	cfg.WordcountHistory.IntervalMinutes = 60
	s := newTestServer(t, cfg, badPool)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() {
		s.RunWordcountCron(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("cron did not exit on context cancel")
	}
}
