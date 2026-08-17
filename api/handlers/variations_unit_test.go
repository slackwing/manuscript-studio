package handlers

// Unit test for writeVariationError (CODE_REVIEW_AUG_2026.md AREA 2 row
// #124): every database sentinel must map to its HTTP status, wrapped or
// bare, and anything unknown must fall through to 500.

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/database"
)

func TestWriteVariationError_Mapping(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantBody   string // substring; "" = don't care
	}{
		{"not owner → 404", database.ErrNotOwner, http.StatusNotFound, "Not found"},
		{"frozen → 409", database.ErrVariationFrozen, http.StatusConflict, "frozen"},
		{"superseded → 409", database.ErrVariationSuperseded, http.StatusConflict, "superseded"},
		{"canon → 409", database.ErrVariationCanon, http.StatusConflict, "canon"},
		{"ordinal cap → 409", database.ErrOrdinalCap, http.StatusConflict, "limit"},
		{"linked elsewhere → 409", database.ErrLinkedElsewhere, http.StatusConflict, "different manuscript"},
		{"already canonized → 409", database.ErrAlreadyCanonized, http.StatusConflict, "canon"},
		{"sketch canonized → 409", database.ErrSketchCanonized, http.StatusConflict, "permanent"},
		{"no letter → 409", database.ErrVariationNoLetter, http.StatusConflict, "canon variation"},
		// errors.Is must see through wrapping — handlers wrap with %w.
		{"wrapped sentinel keeps its status", fmt.Errorf("create sketch: %w", database.ErrNotOwner), http.StatusNotFound, ""},
		{"wrapped conflict keeps 409", fmt.Errorf("canonize: %w", database.ErrSketchCanonized), http.StatusConflict, ""},
		// Anything else is an internal error and must NOT leak its message.
		{"unknown → 500", errors.New("pq: connection reset"), http.StatusInternalServerError, "Internal error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeVariationError(rec, tc.err)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantBody != "" && !strings.Contains(rec.Body.String(), tc.wantBody) {
				t.Errorf("body = %q, want it to contain %q", rec.Body.String(), tc.wantBody)
			}
		})
	}

	// The 500 branch must not echo internal error text to the client.
	rec := httptest.NewRecorder()
	writeVariationError(rec, errors.New("secret dsn: postgres://user:pass@host"))
	if strings.Contains(rec.Body.String(), "postgres://") {
		t.Errorf("internal error leaked to client: %q", rec.Body.String())
	}
}
