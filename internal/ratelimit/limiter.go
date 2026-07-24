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
	"net"
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

// bucketIdleTTL: buckets untouched this long are evicted. Keys are
// attacker-influenced (hashed auth headers, remote IPs), so an unbounded
// map would be a slow memory-exhaustion vector.
const bucketIdleTTL = 15 * time.Minute

// sweepInterval: how often Allow scans for idle buckets (amortized; the
// scan runs inline under the mutex but the map stays small by design).
const sweepInterval = time.Minute

type bucket struct {
	lim      *rate.Limiter
	lastSeen time.Time
}

type Limiter struct {
	cfg       Config
	mu        sync.Mutex
	buckets   map[string]*bucket
	lastSweep time.Time
}

func New(cfg Config) *Limiter {
	return &Limiter{
		cfg:     cfg,
		buckets: map[string]*bucket{},
	}
}

// Allow: true if the request for key should proceed. When false, no token
// was consumed.
func (l *Limiter) Allow(key string) bool {
	if l.cfg.PerKeyRequestsPerMinute <= 0 {
		return true
	}
	now := time.Now()
	l.mu.Lock()
	if now.Sub(l.lastSweep) >= sweepInterval {
		for k, b := range l.buckets {
			if now.Sub(b.lastSeen) > bucketIdleTTL {
				delete(l.buckets, k)
			}
		}
		l.lastSweep = now
	}
	b, ok := l.buckets[key]
	if !ok {
		// rate.Every(d) = "one token every d"; convert rpm to interval.
		interval := time.Minute / time.Duration(l.cfg.PerKeyRequestsPerMinute)
		burst := l.cfg.PerKeyBurst
		if burst <= 0 {
			burst = 1
		}
		b = &bucket{lim: rate.NewLimiter(rate.Every(interval), burst)}
		l.buckets[key] = b
	}
	b.lastSeen = now
	l.mu.Unlock()
	return b.lim.Allow()
}

// Middleware rejects with 429 + Retry-After when the bucket for keyFn(r) is empty.
func (l *Limiter) Middleware(keyFn func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := keyFn(r)
			if key == "" {
				key = HostOnly(r.RemoteAddr)
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

// HostOnly strips the port from a RemoteAddr-style "ip:port" string.
// Without this every TCP connection gets a fresh bucket keyed by its
// ephemeral port — unauthenticated requests would effectively never be
// rate-limited, and each one would grow the map. Input without a port
// (e.g. already reduced to a bare IP by the RealIP middleware) is
// returned unchanged.
func HostOnly(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

// HashAuthHeader hashes so the limiter map never retains the plaintext token.
func HashAuthHeader(authHeader string) string {
	if authHeader == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(authHeader))
	return hex.EncodeToString(sum[:])
}
