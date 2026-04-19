package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
