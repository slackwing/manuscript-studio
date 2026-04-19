package auth

import "testing"

func TestValidatePassword(t *testing.T) {
	cases := []struct {
		password string
		wantOK   bool
	}{
		{"", false},
		{"a", false},
		{"abc", false},
		{"test", true},   // dev/test users must keep working
		{"abcd", true},
		{"verylongpassword", true},
	}
	for _, tc := range cases {
		err := ValidatePassword(tc.password)
		if tc.wantOK && err != nil {
			t.Errorf("ValidatePassword(%q) = %v, want nil", tc.password, err)
		}
		if !tc.wantOK && err == nil {
			t.Errorf("ValidatePassword(%q) = nil, want error", tc.password)
		}
	}
}
