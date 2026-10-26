package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGenerateAPIToken(t *testing.T) {
	token, hash, prefix, err := GenerateAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, APITokenPrefix) || len(token) != len(APITokenPrefix)+43 {
		t.Fatalf("token %q: want mst_ + 43 base64url chars", token)
	}
	if hash != HashAPIToken(token) || len(hash) != 64 {
		t.Fatalf("hash %q is not the token's SHA-256 hex", hash)
	}
	if prefix != token[:12] {
		t.Fatalf("prefix %q, want %q", prefix, token[:12])
	}
	other, _, _, _ := GenerateAPIToken()
	if other == token {
		t.Fatal("two tokens came out equal")
	}
}

func TestBearerAPIToken(t *testing.T) {
	cases := map[string]string{
		"":                        "",
		"Bearer mst_abc":          "mst_abc",
		"bearer mst_abc":          "mst_abc",
		"Bearer  mst_abc ":        "mst_abc",
		"Basic mst_abc":           "",
		"Bearer dev-system-token": "", // the system token is not an API token
		"Bearer mst_abc extra":    "",
		"mst_abc":                 "",
	}
	for header, want := range cases {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/points-daily", nil)
		if header != "" {
			r.Header.Set("Authorization", header)
		}
		if got := BearerAPIToken(r); got != want {
			t.Errorf("%q → %q, want %q", header, got, want)
		}
	}
}

type fakeTokens struct {
	tokens  map[string]*APIToken
	err     error
	touched []int
}

func (f *fakeTokens) Lookup(_ context.Context, token string) (*APIToken, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.tokens[token], nil
}

func (f *fakeTokens) Touch(_ context.Context, id int) error {
	f.touched = append(f.touched, id)
	return errors.New("touch failures are ignored")
}

func TestTokenMiddleware(t *testing.T) {
	store := &fakeTokens{tokens: map[string]*APIToken{
		"mst_points": {ID: 7, Username: "andrew", Scopes: []string{ScopePointsRead}},
		"mst_other":  {ID: 8, Username: "andrew", Scopes: []string{"something:else"}},
	}}
	var seen string
	handler := TokenMiddleware(store, ScopePointsRead)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, err := Username(r)
		if err != nil {
			t.Errorf("Username: %v", err)
		}
		seen = u
		w.WriteHeader(http.StatusOK)
	}))
	cases := []struct {
		header string
		want   int
	}{
		{"", http.StatusUnauthorized},
		{"Bearer not-a-token", http.StatusUnauthorized},
		{"Bearer mst_unknown", http.StatusUnauthorized},
		{"Bearer mst_other", http.StatusForbidden},
		{"Bearer mst_points", http.StatusOK},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/points-daily", nil)
		if c.header != "" {
			r.Header.Set("Authorization", c.header)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("%q: status %d, want %d", c.header, w.Code, c.want)
		}
	}
	if seen != "andrew" {
		t.Errorf("handler saw user %q, want andrew", seen)
	}
	if len(store.touched) != 1 || store.touched[0] != 7 {
		t.Errorf("touched %v, want [7] (only the admitted token, failure ignored)", store.touched)
	}

	broken := TokenMiddleware(&fakeTokens{err: errors.New("db down")}, ScopePointsRead)(http.NotFoundHandler())
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer mst_points")
	w := httptest.NewRecorder()
	broken.ServeHTTP(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("lookup error: status %d, want 500", w.Code)
	}
}

func TestUsernameWithoutAuth(t *testing.T) {
	if _, err := Username(httptest.NewRequest(http.MethodGet, "/", nil)); err == nil {
		t.Fatal("Username without a session or token must fail")
	}
}
