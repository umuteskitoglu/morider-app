// Package oauth verifies third-party identity tokens.
//
// Google Sign-In gives the mobile app an ID token: a JWT signed by Google with
// a rotating RSA key. The backend must verify it rather than trust anything the
// client says about who it is — the client could simply POST a different
// email. Verification means checking the signature against Google's published
// keys, that the token was minted for one of *our* OAuth clients, that it has
// not expired, and that Google actually vouches for the address.
//
// This mirrors pkg/push/fcm.go in deliberately not pulling a Google SDK: the
// only primitives needed are an HTTP fetch and RS256 verification, and
// golang-jwt is already a dependency.
package oauth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// googleJWKSURL publishes the public keys Google signs ID tokens with. Keys
// rotate, so it is refetched rather than pinned.
const googleJWKSURL = "https://www.googleapis.com/oauth2/v3/certs"

// Google sets one of these two issuer strings; both are legitimate.
var googleIssuers = []string{"https://accounts.google.com", "accounts.google.com"}

const (
	// defaultKeyTTL applies when Google's response carries no usable
	// Cache-Control max-age.
	defaultKeyTTL = time.Hour
	// minRefetchInterval throttles refetches triggered by an unknown key id, so
	// a flood of tokens with bogus kids cannot turn into a flood of outbound
	// requests to Google.
	minRefetchInterval = time.Minute
)

// ErrNotConfigured is returned when Google sign-in is called without any
// configured OAuth client id. Handlers translate it into a 501 rather than a
// generic 500, so a missing deployment step is obvious.
var ErrNotConfigured = errors.New("google sign-in is not configured")

// Identity is the verified subset of a Google ID token we act on.
type Identity struct {
	// Subject is Google's stable, immutable user id. It is the only safe
	// join key: a user can change their Gmail address, and a released
	// Workspace address can be reassigned to a different person.
	Subject string
	Email   string
	Name    string
	Picture string
}

// GoogleVerifier validates Google ID tokens against cached signing keys.
// Safe for concurrent use.
type GoogleVerifier struct {
	clientIDs map[string]struct{}
	jwksURL   string
	client    *http.Client

	mu          sync.RWMutex
	keys        map[string]*rsa.PublicKey
	keysExpire  time.Time
	lastFetched time.Time
}

// NewGoogleVerifier builds a verifier accepting tokens minted for any of the
// given OAuth client ids (typically the iOS, Android and Web client ids of one
// Google Cloud project). With no client ids it returns a verifier that rejects
// everything with ErrNotConfigured.
func NewGoogleVerifier(clientIDs []string) *GoogleVerifier {
	set := make(map[string]struct{}, len(clientIDs))
	for _, id := range clientIDs {
		if id = strings.TrimSpace(id); id != "" {
			set[id] = struct{}{}
		}
	}
	return &GoogleVerifier{
		clientIDs: set,
		jwksURL:   googleJWKSURL,
		client:    &http.Client{Timeout: 10 * time.Second},
		keys:      map[string]*rsa.PublicKey{},
	}
}

// Configured reports whether any OAuth client id was supplied.
func (v *GoogleVerifier) Configured() bool { return len(v.clientIDs) > 0 }

// googleClaims is the subset of an ID token payload we read.
type googleClaims struct {
	Email string `json:"email"`
	// EmailVerified arrives as a bool from Google, but some tooling emits the
	// string "true"; json.RawMessage lets us accept both without silently
	// treating an unexpected shape as verified.
	EmailVerified json.RawMessage `json:"email_verified"`
	Name          string          `json:"name"`
	Picture       string          `json:"picture"`
	jwt.RegisteredClaims
}

func (c googleClaims) emailIsVerified() bool {
	s := strings.Trim(string(c.EmailVerified), `"`)
	verified, err := strconv.ParseBool(s)
	return err == nil && verified
}

// Verify checks an ID token and returns the identity it asserts.
func (v *GoogleVerifier) Verify(ctx context.Context, idToken string) (*Identity, error) {
	if !v.Configured() {
		return nil, ErrNotConfigured
	}

	claims := &googleClaims{}
	_, err := jwt.ParseWithClaims(idToken, claims,
		func(t *jwt.Token) (any, error) { return v.keyFor(ctx, t) },
		// Google signs ID tokens with RS256. Pinning the algorithm stops a
		// token that declares alg:none or a symmetric algorithm from being
		// verified with a public key as the shared secret.
		jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}),
		jwt.WithExpirationRequired(),
		jwt.WithIssuer(googleIssuers[0]),
	)
	if err != nil {
		// Google uses two issuer spellings; retry against the bare-host form
		// before giving up.
		if errors.Is(err, jwt.ErrTokenInvalidIssuer) {
			claims = &googleClaims{}
			_, err = jwt.ParseWithClaims(idToken, claims,
				func(t *jwt.Token) (any, error) { return v.keyFor(ctx, t) },
				jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}),
				jwt.WithExpirationRequired(),
				jwt.WithIssuer(googleIssuers[1]),
			)
		}
		if err != nil {
			return nil, fmt.Errorf("invalid google id token: %w", err)
		}
	}

	// The audience must be one of our own OAuth clients. Without this check any
	// valid Google ID token — including one minted for an unrelated app the
	// user happened to sign into — would authenticate them here.
	if !v.audienceAllowed(claims.Audience) {
		return nil, errors.New("google id token was issued for a different application")
	}

	if claims.Subject == "" {
		return nil, errors.New("google id token has no subject")
	}
	if claims.Email == "" {
		return nil, errors.New("google id token has no email")
	}
	// An unverified address proves nothing: it would let someone claim an
	// address they do not control and, with email-based linking, take over the
	// matching Morider account.
	if !claims.emailIsVerified() {
		return nil, errors.New("google account email is not verified")
	}

	return &Identity{
		Subject: claims.Subject,
		Email:   strings.ToLower(strings.TrimSpace(claims.Email)),
		Name:    strings.TrimSpace(claims.Name),
		Picture: claims.Picture,
	}, nil
}

func (v *GoogleVerifier) audienceAllowed(aud jwt.ClaimStrings) bool {
	for _, a := range aud {
		if _, ok := v.clientIDs[a]; ok {
			return true
		}
	}
	return false
}

// keyFor resolves the signing key for a token's kid header, refreshing the
// cached key set when the kid is unknown or the cache has expired.
func (v *GoogleVerifier) keyFor(ctx context.Context, t *jwt.Token) (*rsa.PublicKey, error) {
	kid, _ := t.Header["kid"].(string)
	if kid == "" {
		return nil, errors.New("google id token has no key id")
	}

	v.mu.RLock()
	key, ok := v.keys[kid]
	fresh := time.Now().Before(v.keysExpire)
	v.mu.RUnlock()
	if ok && fresh {
		return key, nil
	}

	if err := v.refresh(ctx); err != nil {
		// A stale key still verifies tokens signed before the rotation, so
		// prefer it over failing every login during a transient outage.
		if ok {
			return key, nil
		}
		return nil, err
	}

	v.mu.RLock()
	key, ok = v.keys[kid]
	v.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown google signing key %q", kid)
	}
	return key, nil
}

type jwkSet struct {
	Keys []jwkKey `json:"keys"`
}

type jwkKey struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// refresh fetches and caches Google's current signing keys.
func (v *GoogleVerifier) refresh(ctx context.Context) error {
	v.mu.Lock()
	// Another goroutine may have refreshed while we waited for the lock, and an
	// unknown kid must not let callers hammer Google.
	if time.Now().Before(v.keysExpire) || time.Since(v.lastFetched) < minRefetchInterval {
		v.mu.Unlock()
		return nil
	}
	v.lastFetched = time.Now()
	v.mu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return err
	}
	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch google keys: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch google keys: unexpected status %d", resp.StatusCode)
	}

	var set jwkSet
	if err := json.NewDecoder(resp.Body).Decode(&set); err != nil {
		return fmt.Errorf("decode google keys: %w", err)
	}

	keys := make(map[string]*rsa.PublicKey, len(set.Keys))
	for _, k := range set.Keys {
		if k.Kty != "RSA" || k.Kid == "" {
			continue
		}
		pub, err := rsaPublicKeyFromJWK(k)
		if err != nil {
			continue // skip the malformed key rather than losing the whole set
		}
		keys[k.Kid] = pub
	}
	if len(keys) == 0 {
		return errors.New("google returned no usable signing keys")
	}

	v.mu.Lock()
	v.keys = keys
	v.keysExpire = time.Now().Add(cacheTTL(resp.Header.Get("Cache-Control")))
	v.mu.Unlock()
	return nil
}

// rsaPublicKeyFromJWK rebuilds an RSA public key from a JWK's modulus and
// exponent, both base64url-encoded big-endian integers.
func rsaPublicKeyFromJWK(k jwkKey) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, fmt.Errorf("modulus: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, fmt.Errorf("exponent: %w", err)
	}
	e := new(big.Int).SetBytes(eBytes)
	if !e.IsInt64() || e.Int64() > (1<<31-1) || e.Int64() < 3 {
		return nil, errors.New("exponent out of range")
	}
	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: int(e.Int64()),
	}, nil
}

// cacheTTL extracts max-age from a Cache-Control header, falling back to
// defaultKeyTTL. Google normally advertises several hours.
func cacheTTL(cacheControl string) time.Duration {
	for _, part := range strings.Split(cacheControl, ",") {
		part = strings.TrimSpace(part)
		if after, found := strings.CutPrefix(part, "max-age="); found {
			if secs, err := strconv.Atoi(after); err == nil && secs > 0 {
				return time.Duration(secs) * time.Second
			}
		}
	}
	return defaultKeyTTL
}
