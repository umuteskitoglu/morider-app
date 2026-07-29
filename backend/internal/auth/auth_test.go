package auth

import (
	"testing"

	"golang.org/x/crypto/bcrypt"
)

// TestDummyHashIsUsableForTimingParity guards the login timing-oracle defence.
//
// If dummyHash were malformed, CompareHashAndPassword would return an error
// immediately instead of doing the work — restoring exactly the fast path that
// let an attacker tell "no such account" from "wrong password" by latency
// alone. A silent regression here looks like nothing at all.
func TestDummyHashIsUsableForTimingParity(t *testing.T) {
	cost, err := bcrypt.Cost(dummyHash)
	if err != nil {
		t.Fatalf("dummyHash is not a valid bcrypt hash: %v", err)
	}
	if cost != bcrypt.DefaultCost {
		t.Fatalf("dummyHash cost is %d but signup hashes at %d; the no-such-user "+
			"path would take measurably less time than a real comparison",
			cost, bcrypt.DefaultCost)
	}

	// It must not match anything a caller could plausibly send.
	for _, guess := range []string{"", "password", "morider", "dummy"} {
		if bcrypt.CompareHashAndPassword(dummyHash, []byte(guess)) == nil {
			t.Fatalf("dummyHash unexpectedly matched %q", guess)
		}
	}
}

func TestNormaliseEmail(t *testing.T) {
	cases := map[string]string{
		"Umut@Example.com":  "umut@example.com",
		"  rider@x.co  ":    "rider@x.co",
		"ALLCAPS@X.COM":     "allcaps@x.com",
		"already@lower.com": "already@lower.com",
	}
	for in, want := range cases {
		if got := normaliseEmail(in); got != want {
			t.Errorf("normaliseEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

// generateUsername feeds a unique index on lower(username); it must always
// produce something that index can accept.
func TestGenerateUsernameAlwaysValid(t *testing.T) {
	cases := map[string]string{
		"umut.eskitoglu@gmail.com":          "umuteskitoglu",
		"a@b.com":                           "rider", // too short after sanitising
		"...@b.com":                         "rider", // sanitises to empty
		"UPPER@b.com":                       "upper",
		"a_very_long_local_part_here@b.com": "a_very_long_loca", // truncated to 16
		"ünïcödé@b.com":                     "ncd",
	}
	for in, want := range cases {
		got := generateUsername(in)
		if got != want {
			t.Errorf("generateUsername(%q) = %q, want %q", in, got, want)
		}
		if len(got) < 3 || len(got) > 16 {
			t.Errorf("generateUsername(%q) = %q: length %d out of bounds", in, got, len(got))
		}
	}
}
