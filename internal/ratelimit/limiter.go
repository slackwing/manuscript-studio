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

// Config tunes the limiter. Zero or negative values disable the corresponding check.
type Config struct {
	PerKeyRequestsPerMinute int // steady-state rate per key
	PerKeyBurst             int // burst size per key
}

// DefaultConfig: 10 rpm/key, burst 5.
func DefaultConfig() Config {
	return Config{
		PerKeyRequestsPerMinute: 10,
		PerKeyBurst:             5,
	}
}

type Limiter struct {
	cfg     Config
	mu      sync.Mutex
	buckets map[string]*rate.Limiter
}

func New(cfg Config) *Limiter {
	return &Limiter{
		cfg:     cfg,
		buckets: map[string]*rate.Limiter{},
	}
}

// Allow: true if the request for key should proceed. When false, no token
// was consumed.
func (l *Limiter) Allow(key string) bool {
	if l.cfg.PerKeyRequestsPerMinute <= 0 {
		return true
	}
	l.mu.Lock()
	b, ok := l.buckets[key]
	if !ok {
		// rate.Every(d) = "one token every d"; convert rpm to interval.
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

// Middleware rejects with 429 + Retry-After when the bucket for keyFn(r) is empty.
func (l *Limiter) Middleware(keyFn func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := keyFn(r)
			if key == "" {
				key = r.RemoteAddr
			}
			if !l.Allow(key) {
				// One-token refill time.
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

// HashAuthHeader hashes so the limiter map never retains the plaintext token.
func HashAuthHeader(authHeader string) string {
	if authHeader == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(authHeader))
	return hex.EncodeToString(sum[:])
}
