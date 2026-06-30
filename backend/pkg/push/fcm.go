package push

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// FCMSender delivers notifications via Firebase Cloud Messaging HTTP v1. It mints
// the OAuth2 access token from a service-account key itself (signed JWT bearer
// flow) so it needs no third-party SDK. Tokens are cached until shortly before
// they expire.
type FCMSender struct {
	clientEmail string
	tokenURI    string
	projectID   string
	privateKey  *rsa.PrivateKey

	client *http.Client

	mu       sync.Mutex
	token    string
	tokenExp time.Time
}

// serviceAccount is the subset of a Google service-account JSON we need.
type serviceAccount struct {
	ProjectID   string `json:"project_id"`
	PrivateKey  string `json:"private_key"`
	ClientEmail string `json:"client_email"`
	TokenURI    string `json:"token_uri"`
}

// NewFCMSender builds a sender from the raw service-account JSON bytes.
func NewFCMSender(saJSON []byte) (*FCMSender, error) {
	var sa serviceAccount
	if err := json.Unmarshal(saJSON, &sa); err != nil {
		return nil, fmt.Errorf("invalid service account json: %w", err)
	}
	if sa.ClientEmail == "" || sa.PrivateKey == "" || sa.ProjectID == "" {
		return nil, fmt.Errorf("service account json missing required fields")
	}
	key, err := parseRSAPrivateKey(sa.PrivateKey)
	if err != nil {
		return nil, err
	}
	tokenURI := sa.TokenURI
	if tokenURI == "" {
		tokenURI = "https://oauth2.googleapis.com/token"
	}
	return &FCMSender{
		clientEmail: sa.ClientEmail,
		tokenURI:    tokenURI,
		projectID:   sa.ProjectID,
		privateKey:  key,
		client:      &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// parseRSAPrivateKey decodes a PEM private key (PKCS#8 or PKCS#1).
func parseRSAPrivateKey(pemStr string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, fmt.Errorf("private_key is not valid PEM")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if rsaKey, ok := key.(*rsa.PrivateKey); ok {
			return rsaKey, nil
		}
		return nil, fmt.Errorf("private_key is not RSA")
	}
	return x509.ParsePKCS1PrivateKey(block.Bytes)
}

// accessToken returns a valid OAuth2 access token, minting a new one when the
// cached token is missing or about to expire.
func (f *FCMSender) accessToken(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.token != "" && time.Until(f.tokenExp) > time.Minute {
		return f.token, nil
	}
	jwt, err := f.signJWT()
	if err != nil {
		return "", err
	}
	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {jwt},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.tokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := f.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, string(body))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", err
	}
	f.token = tok.AccessToken
	f.tokenExp = time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
	return f.token, nil
}

// signJWT builds and RS256-signs the assertion JWT for the token exchange.
func (f *FCMSender) signJWT() (string, error) {
	now := time.Now()
	header := map[string]string{"alg": "RS256", "typ": "JWT"}
	claims := map[string]any{
		"iss":   f.clientEmail,
		"scope": "https://www.googleapis.com/auth/firebase.messaging",
		"aud":   f.tokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	}
	hb, _ := json.Marshal(header)
	cb, _ := json.Marshal(claims)
	signingInput := b64(hb) + "." + b64(cb)
	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + b64(sig), nil
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// SendToTokens implements Sender, sending one FCM v1 message per token. FCM v1
// has no batch endpoint over plain HTTP, so tokens are sent sequentially; this
// runs off the request path (see reward.notify) so latency is not user-facing.
func (f *FCMSender) SendToTokens(ctx context.Context, tokens []string, n Notification) error {
	if len(tokens) == 0 {
		return nil
	}
	token, err := f.accessToken(ctx)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("https://fcm.googleapis.com/v1/projects/%s/messages:send", f.projectID)
	// FCM data values must be strings.
	data := make(map[string]string, len(n.Data))
	for k, v := range n.Data {
		data[k] = fmt.Sprintf("%v", v)
	}
	for _, dt := range tokens {
		msg := map[string]any{
			"message": map[string]any{
				"token":        dt,
				"notification": map[string]string{"title": n.Title, "body": n.Body},
				"data":         data,
			},
		}
		payload, _ := json.Marshal(msg)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
		if err != nil {
			continue
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := f.client.Do(req)
		if err != nil {
			continue
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
	}
	return nil
}
