// Package logctx ties the request lifecycle to a slog.Logger so handlers
// can log with stable structured fields (req_id, route, latency_ms, ...)
// without each handler reinventing the field set.
package logctx

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

type ctxKey struct{}

// LoggerFrom returns the slog.Logger attached to ctx, falling back to the
// default logger if none is set. Always non-nil.
func LoggerFrom(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(ctxKey{}).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}

// WithLogger returns a copy of ctx with the given logger attached.
func WithLogger(ctx context.Context, l *slog.Logger) context.Context {
	return context.WithValue(ctx, ctxKey{}, l)
}

// Middleware attaches a per-request logger to the request context. The
// logger is preconfigured with req_id, method, and path so any subsequent
// log call from a handler picks those up automatically.
//
// Must be placed AFTER chi/middleware.RequestID so that GetReqID returns
// a real value.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		l := slog.Default().With(
			slog.String("req_id", middleware.GetReqID(r.Context())),
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
		)
		ctx := WithLogger(r.Context(), l)

		wrapped := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(wrapped, r.WithContext(ctx))

		l.Debug("request completed",
			slog.Int("status", wrapped.status),
			slog.Int64("latency_ms", time.Since(start).Milliseconds()),
		)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}
