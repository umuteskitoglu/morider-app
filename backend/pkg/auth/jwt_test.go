package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestIssueAndParseRoundTrip(t *testing.T) {
	m := NewManager("test-secret", time.Hour)
	tok, err := m.Issue(42, "rider@example.com")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	claims, err := m.Parse(tok)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if claims.UserID != 42 || claims.Email != "rider@example.com" {
		t.Fatalf("round trip lost claims: %+v", claims)
	}
}

func TestParseRejectsWrongSecret(t *testing.T) {
	issuer := NewManager("secret-a", time.Hour)
	verifier := NewManager("secret-b", time.Hour)
	tok, _ := issuer.Issue(1, "a@b.com")
	if _, err := verifier.Parse(tok); err == nil {
		t.Fatal("a token signed with a different secret was accepted")
	}
}

func TestParseRejectsExpiredToken(t *testing.T) {
	m := NewManager("test-secret", -time.Minute) // already expired
	tok, _ := m.Issue(1, "a@b.com")
	if _, err := m.Parse(tok); err == nil {
		t.Fatal("an expired token was accepted")
	}
}

// TestParseRejectsTokenWithoutExpiry covers WithExpirationRequired: jwt/v5
// considers a token carrying no exp claim valid forever, so one leaked token
// would never age out.
func TestParseRejectsTokenWithoutExpiry(t *testing.T) {
	m := NewManager("test-secret", time.Hour)

	claims := Claims{
		UserID: 1,
		Email:  "a@b.com",
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt: jwt.NewNumericDate(time.Now()),
			Issuer:   issuer,
			// deliberately no ExpiresAt
		},
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.secret)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := m.Parse(tok); err == nil {
		t.Fatal("a token with no expiry was accepted")
	}
}

// TestParseRejectsAlgNone is the classic JWT confusion attack: an unsigned
// token asserting alg:none must never authenticate anyone.
func TestParseRejectsAlgNone(t *testing.T) {
	m := NewManager("test-secret", time.Hour)

	claims := Claims{
		UserID: 999,
		Email:  "attacker@example.com",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			Issuer:    issuer,
		},
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodNone, claims).
		SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := m.Parse(tok); err == nil {
		t.Fatal("an alg:none token was accepted")
	}
}

func TestParseRejectsForeignIssuer(t *testing.T) {
	m := NewManager("test-secret", time.Hour)

	claims := Claims{
		UserID: 1,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			Issuer:    "somebody-else",
		},
	}
	tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.secret)
	if _, err := m.Parse(tok); err == nil {
		t.Fatal("a token from a foreign issuer was accepted")
	}
}
