// Package ratelimit provides a small in-process token-bucket rate limiter
// suitable for protecting privileged HTTP endpoints from abuse.
//
// It is deliberately not a distributed limiter: the limits are per-process,
// so two server replicas would each grant their own quota. That's fine for
// our threat model — the limiter exists to keep a leaked token from being
// used to flood the system, not to enforce an exact global quota.
package ratelimit

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Config tunes the limiter. Zero/negative values disable the corresponding check.
type Config struct {
	// PerKeyRequestsPerMinute is the steady-state request rate allowed per key.
	PerKeyRequestsPerMinute int
	// PerKeyBurst is the burst size for the per-key bucket.
	PerKeyBurst int
}

// DefaultConfig returns sane defaults: 10 req/min per key, burst 5.
func DefaultConfig() Config {
	return Config{
		PerKeyRequestsPerMinute: 10,
		PerKeyBurst:             5,
	}
}

// Limiter holds the per-key buckets.
type Limiter struct {
	cfg     Config
	mu      sync.Mutex
	buckets map[string]*rate.Limiter
}

// New creates a Limiter with the given config.
func New(cfg Config) *Limiter {
	return &Limiter{
		cfg:     cfg,
		buckets: map[string]*rate.Limiter{},
	}
}

// Allow returns true if the request for `key` should proceed. When false,
// the limiter has already accounted for the rejection (no extra tokens
// consumed). Returns the bucket's current limit/burst so the caller can
// surface a useful Retry-After header.
func (l *Limiter) Allow(key string) bool {
	if l.cfg.PerKeyRequestsPerMinute <= 0 {
		return true
	}
	l.mu.Lock()
	b, ok := l.buckets[key]
	if !ok {
		// rate.Every(d) is "one token every d"; turn rpm into a per-token interval.
		interval := time.Minute / time.Duration(l.cfg.PerKeyRequestsPerMinute)
		burst := l.cfg.PerKeyBurst
		if burst <= 0 {
			burst = 1
		}
		b = rate.NewLimiter(rate.Every(interval), burst)
		l.buckets[key] = b
	}
	l.mu.Unlock()
	return b.Allow()
}

// Middleware returns an http.Handler middleware that calls keyFn to derive
// the bucket key for each request and rejects with 429 + Retry-After when
// the bucket is empty.
func (l *Limiter) Middleware(keyFn func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := keyFn(r)
			if key == "" {
				key = r.RemoteAddr
			}
			if !l.Allow(key) {
				// Retry-After hint: the time it takes to refill one token.
				retryAfterSec := 60 / l.cfg.PerKeyRequestsPerMinute
				if retryAfterSec < 1 {
					retryAfterSec = 1
				}
				w.Header().Set("Retry-After", strconv.Itoa(retryAfterSec))
				http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// HashAuthHeader returns a stable, non-reversible key for the Authorization
// header. We hash so the limiter map doesn't accidentally retain plaintext
// secrets in memory longer than necessary.
func HashAuthHeader(authHeader string) string {
	if authHeader == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(authHeader))
	return hex.EncodeToString(sum[:])
}
