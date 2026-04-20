package handlers

import (
	"strings"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/auth"
)

// If the dummy hash doesn't parse as bcrypt, CompareHashAndPassword
// short-circuits and the timing defense disappears.
func TestDummyPasswordHashIsValidBcrypt(t *testing.T) {
	if !strings.HasPrefix(dummyPasswordHash, "$2a$10$") &&
		!strings.HasPrefix(dummyPasswordHash, "$2b$10$") {
		t.Fatalf("dummyPasswordHash must be a real bcrypt hash, got %q", dummyPasswordHash)
	}

	if auth.VerifyPassword("never-a-real-password-other", dummyPasswordHash) {
		t.Fatalf("dummy hash unexpectedly matched a non-canonical password — was the hash regenerated?")
	}
}
