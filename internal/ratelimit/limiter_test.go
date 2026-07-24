package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestLimiter_AllowsBurstThenBlocks(t *testing.T) {
	l := New(Config{PerKeyRequestsPerMinute: 60, PerKeyBurst: 3})

	// First 3 should pass (burst)
	for i := 0; i < 3; i++ {
		if !l.Allow("k") {
			t.Fatalf("Allow #%d denied within burst", i)
		}
	}
	// 4th should be denied (no time has passed; bucket empty).
	if l.Allow("k") {
		t.Fatalf("Allow #4 unexpectedly permitted (burst exhausted)")
	}
}

func TestLimiter_PerKeyIsolated(t *testing.T) {
	l := New(Config{PerKeyRequestsPerMinute: 60, PerKeyBurst: 1})
	if !l.Allow("a") {
		t.Fatal("first request for a denied")
	}
	// "a" exhausted; "b" should still get its own burst.
	if !l.Allow("b") {
		t.Fatal("first request for b denied")
	}
}

func TestLimiter_DisabledWhenZero(t *testing.T) {
	l := New(Config{PerKeyRequestsPerMinute: 0})
	for i := 0; i < 100; i++ {
		if !l.Allow("k") {
			t.Fatalf("Allow #%d denied with limit disabled", i)
		}
	}
}

func TestMiddleware_Returns429WithRetryAfter(t *testing.T) {
	l := New(Config{PerKeyRequestsPerMinute: 30, PerKeyBurst: 1})
	called := 0
	handler := l.Middleware(func(r *http.Request) string {
		return "fixed-key"
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		w.WriteHeader(http.StatusOK)
	}))

	w1 := httptest.NewRecorder()
	handler.ServeHTTP(w1, httptest.NewRequest("GET", "/admin/x", nil))
	if w1.Code != http.StatusOK {
		t.Fatalf("first request: want 200, got %d", w1.Code)
	}

	w2 := httptest.NewRecorder()
	handler.ServeHTTP(w2, httptest.NewRequest("GET", "/admin/x", nil))
	if w2.Code != http.StatusTooManyRequests {
		t.Fatalf("second request: want 429, got %d", w2.Code)
	}
	if w2.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header on 429")
	}
	if called != 1 {
		t.Fatalf("inner handler called %d times, want 1", called)
	}
}

func TestHashAuthHeader_StableAndNonReversible(t *testing.T) {
	a := HashAuthHeader("Bearer secret")
	b := HashAuthHeader("Bearer secret")
	c := HashAuthHeader("Bearer other")
	if a != b {
		t.Fatal("hash should be stable for identical input")
	}
	if a == c {
		t.Fatal("different inputs should produce different hashes")
	}
	if a == "" {
		t.Fatal("hash should be non-empty for non-empty input")
	}
}

func TestHostOnly(t *testing.T) {
	cases := map[string]string{
		"1.2.3.4:54321":    "1.2.3.4",
		"1.2.3.4":          "1.2.3.4", // RealIP middleware output: no port
		"[::1]:8080":       "::1",
		"example.com:1234": "example.com",
	}
	for in, want := range cases {
		if got := HostOnly(in); got != want {
			t.Errorf("HostOnly(%q) = %q, want %q", in, got, want)
		}
	}
}

// Regression: buckets grew without bound (one per attacker-chosen key,
// never evicted). Idle buckets must be swept.
func TestBucketEviction(t *testing.T) {
	l := New(DefaultConfig())
	for i := 0; i < 100; i++ {
		l.Allow("key-" + strconv.Itoa(i))
	}
	if got := len(l.buckets); got != 100 {
		t.Fatalf("expected 100 buckets, got %d", got)
	}
	// Age every bucket past the idle TTL and force the next sweep.
	l.mu.Lock()
	for _, b := range l.buckets {
		b.lastSeen = time.Now().Add(-bucketIdleTTL - time.Minute)
	}
	l.lastSweep = time.Now().Add(-sweepInterval - time.Second)
	l.mu.Unlock()

	l.Allow("fresh-key")
	l.mu.Lock()
	defer l.mu.Unlock()
	if got := len(l.buckets); got != 1 {
		t.Fatalf("expected idle buckets evicted (1 remaining), got %d", got)
	}
	if _, ok := l.buckets["fresh-key"]; !ok {
		t.Fatal("fresh key should survive the sweep")
	}
}
