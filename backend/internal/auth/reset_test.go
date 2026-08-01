package auth

import (
	"testing"
)

// TestGenerateResetCodeShape locks the two properties the mail template and the
// request binding both assume: exactly six characters, digits only.
//
// A code shorter than six digits (an unpadded 0-999 draw, say) would still
// "work" end to end while quietly shrinking the keyspace, and would be rejected
// by the `len=6` binding on the reset request — an outage that only shows up
// for the unlucky one-in-ten rider.
func TestGenerateResetCodeShape(t *testing.T) {
	for i := 0; i < 500; i++ {
		code, err := generateResetCode()
		if err != nil {
			t.Fatalf("generateResetCode: %v", err)
		}
		if len(code) != 6 {
			t.Fatalf("code %q has length %d, want 6", code, len(code))
		}
		for _, r := range code {
			if r < '0' || r > '9' {
				t.Fatalf("code %q contains a non-digit %q", code, r)
			}
		}
	}
}

// TestGenerateResetCodeVaries is a smoke test against a constant or
// catastrophically biased generator. 500 draws from a million values should
// essentially never repeat, let alone collapse to a handful.
func TestGenerateResetCodeVaries(t *testing.T) {
	seen := make(map[string]struct{})
	for i := 0; i < 500; i++ {
		code, err := generateResetCode()
		if err != nil {
			t.Fatalf("generateResetCode: %v", err)
		}
		seen[code] = struct{}{}
	}
	if len(seen) < 450 {
		t.Fatalf("only %d distinct codes in 500 draws; the generator looks biased", len(seen))
	}
}
