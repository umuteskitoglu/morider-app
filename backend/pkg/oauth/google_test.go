package oauth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testClientID = "1234567890-abc.apps.googleusercontent.com"

// testIDP is a stand-in for Google: it holds a signing key, publishes the
// matching JWKS, and can mint tokens with arbitrary claims.
type testIDP struct {
	key    *rsa.PrivateKey
	kid    string
	server *httptest.Server
	hits   int
}

func newTestIDP(t *testing.T) *testIDP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	idp := &testIDP{key: key, kid: "test-key-1"}
	idp.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		idp.hits++
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(jwkSet{Keys: []jwkKey{{
			Kid: idp.kid,
			Kty: "RSA",
			Alg: "RS256",
			N:   base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()),
			E:   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes()),
		}}})
	}))
	t.Cleanup(idp.server.Close)
	return idp
}

// mint builds a signed token from a claim map, so tests can bend individual
// fields without a rigid struct.
func (idp *testIDP) mint(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = idp.kid
	s, err := tok.SignedString(idp.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

func validClaims() jwt.MapClaims {
	return jwt.MapClaims{
		"iss":            "https://accounts.google.com",
		"aud":            testClientID,
		"sub":            "108143920384756102938",
		"email":          "Rider@Example.com",
		"email_verified": true,
		"name":           "Test Rider",
		"picture":        "https://lh3.googleusercontent.com/a/photo",
		"iat":            time.Now().Unix(),
		"exp":            time.Now().Add(time.Hour).Unix(),
	}
}

func newVerifier(idp *testIDP, clientIDs ...string) *GoogleVerifier {
	if len(clientIDs) == 0 {
		clientIDs = []string{testClientID}
	}
	v := NewGoogleVerifier(clientIDs)
	v.jwksURL = idp.server.URL
	return v
}

func TestVerifyAcceptsValidToken(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	id, err := v.Verify(context.Background(), idp.mint(t, validClaims()))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if id.Subject != "108143920384756102938" {
		t.Errorf("subject = %q", id.Subject)
	}
	// The email must be normalised the same way the users table stores it,
	// otherwise account linking silently misses.
	if id.Email != "rider@example.com" {
		t.Errorf("email = %q, want lowercased", id.Email)
	}
	if id.Name != "Test Rider" {
		t.Errorf("name = %q", id.Name)
	}
}

// The audience check is what stops an ID token minted for a completely
// different app — which an attacker can obtain legitimately — from logging
// someone into Morider.
func TestVerifyRejectsForeignAudience(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	claims := validClaims()
	claims["aud"] = "999-someone-elses-app.apps.googleusercontent.com"

	if _, err := v.Verify(context.Background(), idp.mint(t, claims)); err == nil {
		t.Fatal("token for another application was accepted")
	}
}

// Linking to an existing account by email is only safe if Google actually
// vouches for the address.
func TestVerifyRejectsUnverifiedEmail(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	claims := validClaims()
	claims["email_verified"] = false

	if _, err := v.Verify(context.Background(), idp.mint(t, claims)); err == nil {
		t.Fatal("unverified email was accepted")
	}
}

func TestVerifyAcceptsStringEmailVerified(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	claims := validClaims()
	claims["email_verified"] = "true"

	if _, err := v.Verify(context.Background(), idp.mint(t, claims)); err != nil {
		t.Fatalf("string-encoded email_verified rejected: %v", err)
	}
}

func TestVerifyRejectsMissingEmailVerified(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	claims := validClaims()
	delete(claims, "email_verified")

	if _, err := v.Verify(context.Background(), idp.mint(t, claims)); err == nil {
		t.Fatal("token with no email_verified claim was accepted")
	}
}

func TestVerifyRejectsExpiredToken(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	claims := validClaims()
	claims["exp"] = time.Now().Add(-time.Minute).Unix()

	if _, err := v.Verify(context.Background(), idp.mint(t, claims)); err == nil {
		t.Fatal("expired token was accepted")
	}
}

func TestVerifyRejectsTokenWithoutExpiry(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	claims := validClaims()
	delete(claims, "exp")

	if _, err := v.Verify(context.Background(), idp.mint(t, claims)); err == nil {
		t.Fatal("token with no expiry was accepted")
	}
}

func TestVerifyRejectsForeignIssuer(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	claims := validClaims()
	claims["iss"] = "https://evil.example"

	if _, err := v.Verify(context.Background(), idp.mint(t, claims)); err == nil {
		t.Fatal("token from a foreign issuer was accepted")
	}
}

// Google uses both issuer spellings; rejecting the bare-host form would break
// sign-in for a subset of clients.
func TestVerifyAcceptsBareHostIssuer(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	claims := validClaims()
	claims["iss"] = "accounts.google.com"

	if _, err := v.Verify(context.Background(), idp.mint(t, claims)); err != nil {
		t.Fatalf("bare-host issuer rejected: %v", err)
	}
}

// A token signed by a key we do not publish must never verify, however
// well-formed its claims are.
func TestVerifyRejectsTokenSignedByAnotherKey(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	attacker, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, validClaims())
	tok.Header["kid"] = idp.kid // claim to be the legitimate key
	signed, err := tok.SignedString(attacker)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	if _, err := v.Verify(context.Background(), signed); err == nil {
		t.Fatal("token signed by an unknown key was accepted")
	}
}

// alg:none, the classic JWT bypass.
func TestVerifyRejectsAlgNone(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	tok := jwt.NewWithClaims(jwt.SigningMethodNone, validClaims())
	tok.Header["kid"] = idp.kid
	signed, err := tok.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := v.Verify(context.Background(), signed); err == nil {
		t.Fatal("alg:none token was accepted")
	}
}

func TestVerifyWithoutConfiguredClientIDs(t *testing.T) {
	v := NewGoogleVerifier(nil)
	if v.Configured() {
		t.Fatal("Configured() is true with no client ids")
	}
	if _, err := v.Verify(context.Background(), "anything"); err != ErrNotConfigured {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}

// Keys are cached: a burst of sign-ins must not become a burst of outbound
// requests to Google.
func TestKeysAreCachedAcrossVerifications(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	for i := 0; i < 10; i++ {
		if _, err := v.Verify(context.Background(), idp.mint(t, validClaims())); err != nil {
			t.Fatalf("Verify #%d: %v", i, err)
		}
	}
	if idp.hits != 1 {
		t.Fatalf("fetched JWKS %d times, want 1", idp.hits)
	}
}

// An unknown kid must not let a caller trigger unbounded refetches.
func TestUnknownKidDoesNotHammerGoogle(t *testing.T) {
	idp := newTestIDP(t)
	v := newVerifier(idp)

	// Prime the cache.
	if _, err := v.Verify(context.Background(), idp.mint(t, validClaims())); err != nil {
		t.Fatalf("priming Verify: %v", err)
	}

	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, validClaims())
	tok.Header["kid"] = "kid-that-does-not-exist"
	signed, _ := tok.SignedString(idp.key)

	for i := 0; i < 20; i++ {
		if _, err := v.Verify(context.Background(), signed); err == nil {
			t.Fatal("token with an unknown kid was accepted")
		}
	}
	if idp.hits > 2 {
		t.Fatalf("fetched JWKS %d times for unknown kids; refetch is not throttled", idp.hits)
	}
}

func TestCacheTTL(t *testing.T) {
	cases := map[string]time.Duration{
		"public, max-age=3600": time.Hour,
		"max-age=60":           time.Minute,
		"no-cache":             defaultKeyTTL,
		"":                     defaultKeyTTL,
		"public, max-age=oops": defaultKeyTTL,
		"max-age=0":            defaultKeyTTL,
	}
	for header, want := range cases {
		if got := cacheTTL(header); got != want {
			t.Errorf("cacheTTL(%q) = %v, want %v", header, got, want)
		}
	}
}
