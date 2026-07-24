package fractional

import (
	"testing"
)

func TestGetPositionAtIndex(t *testing.T) {
	tests := []struct {
		name      string
		positions []string
		index     int
		want      string
		wantErr   bool
	}{
		{
			name:      "first item in empty list",
			positions: []string{},
			index:     0,
			want:      "a0000",
			wantErr:   false,
		},
		{
			name:      "insert at beginning",
			positions: []string{"a0001", "a0002", "a0003"},
			index:     0,
			want:      "a0000",
			wantErr:   false,
		},
		{
			name:      "insert at end",
			positions: []string{"a0000", "a0001", "a0002"},
			index:     3,
			want:      "a0003",
			wantErr:   false,
		},
		{
			name:      "insert in middle with gap",
			positions: []string{"a0000", "a0004"},
			index:     1,
			want:      "a0002",
			wantErr:   false,
		},
		{
			name:      "insert between adjacent positions",
			positions: []string{"a0000", "a0001", "a0002"},
			index:     2,
			want:      "a00015",
			wantErr:   false,
		},
		{
			name:      "invalid index (negative)",
			positions: []string{"a0000", "a0001"},
			index:     -1,
			want:      "",
			wantErr:   true,
		},
		{
			name:      "invalid index (too large)",
			positions: []string{"a0000", "a0001"},
			index:     3,
			want:      "",
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := GetPositionAtIndex(tt.positions, tt.index)
			if (err != nil) != tt.wantErr {
				t.Errorf("GetPositionAtIndex() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if got != tt.want {
				t.Errorf("GetPositionAtIndex() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestIncrementPosition(t *testing.T) {
	tests := []struct {
		name    string
		pos     string
		want    string
		wantErr bool
	}{
		{
			name:    "increment simple",
			pos:     "a0000",
			want:    "a0001",
			wantErr: false,
		},
		{
			name:    "increment middle value",
			pos:     "a0042",
			want:    "a0043",
			wantErr: false,
		},
		{
			name:    "increment at boundary",
			pos:     "a9999",
			want:    "b0000",
			wantErr: false,
		},
		{
			name:    "increment from empty",
			pos:     "",
			want:    "a0000",
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := incrementPosition(tt.pos)
			if (err != nil) != tt.wantErr {
				t.Errorf("incrementPosition() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if got != tt.want {
				t.Errorf("incrementPosition() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDecrementPosition(t *testing.T) {
	tests := []struct {
		name    string
		pos     string
		want    string
		wantErr bool
	}{
		{
			name:    "decrement simple",
			pos:     "a0001",
			want:    "a0000",
			wantErr: false,
		},
		{
			name:    "decrement middle value",
			pos:     "a0042",
			want:    "a0041",
			wantErr: false,
		},
		{
			name:    "decrement at boundary",
			pos:     "b0000",
			want:    "a9999",
			wantErr: false,
		},
		{
			name:    "decrement from empty",
			pos:     "",
			want:    "a0000",
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := decrementPosition(tt.pos)
			if (err != nil) != tt.wantErr {
				t.Errorf("decrementPosition() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if got != tt.want {
				t.Errorf("decrementPosition() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestMidpoint(t *testing.T) {
	tests := []struct {
		name    string
		before  string
		after   string
		want    string
		wantErr bool
	}{
		{
			name:    "midpoint with gap",
			before:  "a0000",
			after:   "a0002",
			want:    "a0001",
			wantErr: false,
		},
		{
			name:    "midpoint adjacent (needs precision)",
			before:  "a0000",
			after:   "a0001",
			want:    "a00005",
			wantErr: false,
		},
		{
			name:    "midpoint large gap",
			before:  "a0000",
			after:   "a0100",
			want:    "a0050",
			wantErr: false,
		},
		{
			name:    "invalid order",
			before:  "a0002",
			after:   "a0001",
			want:    "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := midpoint(tt.before, tt.after)
			if (err != nil) != tt.wantErr {
				t.Errorf("midpoint() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if got != tt.want {
				t.Errorf("midpoint() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGeneratePositionBetween(t *testing.T) {
	tests := []struct {
		name    string
		before  string
		after   string
		want    string
		wantErr bool
	}{
		{
			name:    "insert at beginning",
			before:  "",
			after:   "a0001",
			want:    "a0000",
			wantErr: false,
		},
		{
			name:    "insert at end",
			before:  "a0001",
			after:   "",
			want:    "a0002",
			wantErr: false,
		},
		{
			name:    "insert in middle",
			before:  "a0000",
			after:   "a0002",
			want:    "a0001",
			wantErr: false,
		},
		{
			name:    "first item ever",
			before:  "",
			after:   "",
			want:    "a0000",
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := GeneratePositionBetween(tt.before, tt.after)
			if (err != nil) != tt.wantErr {
				t.Errorf("GeneratePositionBetween() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if got != tt.want {
				t.Errorf("GeneratePositionBetween() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestOrderingInvariant(t *testing.T) {
	positions := []string{}

	pos, _ := GetPositionAtIndex(positions, 0)
	positions = append(positions, pos)

	for i := 0; i < 5; i++ {
		pos, _ := GetPositionAtIndex(positions, len(positions))
		positions = append(positions, pos)
	}

	for i := 1; i < len(positions); i++ {
		if positions[i-1] >= positions[i] {
			t.Errorf("Ordering broken: positions[%d]=%s >= positions[%d]=%s",
				i-1, positions[i-1], i, positions[i])
		}
	}
}

// Regression: extended-precision digits are a decimal fraction, not an
// integer. The old Sscanf("%d") math produced midpoints that sorted OUTSIDE
// the (before, after) interval — e.g. midpoint("a0001","a00015") == "a0008",
// which sorts after "a00015".
func TestMidpointExtendedPrecision(t *testing.T) {
	cases := []struct{ before, after string }{
		{"a0001", "a00015"},
		{"a0000", "a00005"},
		{"a00005", "a0001"},
		{"a0001", "a000105"},
		{"a00015", "a0002"},
	}
	for _, c := range cases {
		got, err := midpoint(c.before, c.after)
		if err != nil {
			t.Errorf("midpoint(%q, %q) error: %v", c.before, c.after, err)
			continue
		}
		if !(c.before < got && got < c.after) {
			t.Errorf("midpoint(%q, %q) = %q — not strictly between", c.before, c.after, got)
		}
	}
}

// Regression: GeneratePositionBetween("", after) with extended-precision
// after must sort BEFORE it (old code returned "a0004" for "a00005").
func TestDecrementExtendedPrecision(t *testing.T) {
	for _, after := range []string{"a00005", "a00015", "a000105"} {
		got, err := GeneratePositionBetween("", after)
		if err != nil {
			t.Errorf("GeneratePositionBetween(\"\", %q) error: %v", after, err)
			continue
		}
		if got >= after {
			t.Errorf("GeneratePositionBetween(\"\", %q) = %q — sorts at/after its upper bound", after, got)
		}
	}
}

// Increment on extended-precision positions must sort after the input.
func TestIncrementExtendedPrecision(t *testing.T) {
	for _, before := range []string{"a00005", "a00015", "a99995"} {
		got, err := GeneratePositionBetween(before, "")
		if err != nil {
			t.Errorf("GeneratePositionBetween(%q, \"\") error: %v", before, err)
			continue
		}
		if got <= before {
			t.Errorf("GeneratePositionBetween(%q, \"\") = %q — sorts at/before its lower bound", before, got)
		}
	}
}

// Stress the reorder pattern that drifted in production code: repeatedly
// insert between adjacent positions, then between the new neighbor pairs,
// and assert the full list stays strictly ordered.
func TestRepeatedMidpointInsertsStayOrdered(t *testing.T) {
	positions := []string{"a0000", "a0001"}
	for i := 0; i < 40; i++ {
		// Always split the first gap — this is the worst case that keeps
		// extending precision.
		mid, err := GeneratePositionBetween(positions[0], positions[1])
		if err != nil {
			t.Fatalf("iteration %d: %v", i, err)
		}
		positions = append([]string{positions[0], mid}, positions[1:]...)
		for j := 1; j < len(positions); j++ {
			if positions[j-1] >= positions[j] {
				t.Fatalf("iteration %d: ordering broken: %q >= %q", i, positions[j-1], positions[j])
			}
		}
	}
}
