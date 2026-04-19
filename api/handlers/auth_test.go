package handlers

import (
	"strings"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/auth"
)

// TestDummyPasswordHashIsValidBcrypt ensures the dummy hash actually parses as
// bcrypt — otherwise CompareHashAndPassword short-circuits and the timing
// "defense" disappears.
func TestDummyPasswordHashIsValidBcrypt(t *testing.T) {
	if !strings.HasPrefix(dummyPasswordHash, "$2a$10$") &&
		!strings.HasPrefix(dummyPasswordHash, "$2b$10$") {
		t.Fatalf("dummyPasswordHash must be a real bcrypt hash, got %q", dummyPasswordHash)
	}

	// Calling VerifyPassword with any password against the dummy must return
	// false (no real password matches it) but must NOT panic and must
	// actually do the bcrypt work — i.e. it must be a parseable hash.
	if auth.VerifyPassword("never-a-real-password-other", dummyPasswordHash) {
		t.Fatalf("dummy hash unexpectedly matched a non-canonical password — was the hash regenerated?")
	}
}
