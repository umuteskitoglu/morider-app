// Package push sends remote notifications via Expo's push service. Delivery to
// APNs/FCM is handled by Expo using the project's credentials, so callers only
// need the device's Expo push token. Sending is best-effort: a failed push must
// never break the request that triggered it.
package push

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// expoPushURL is Expo's push send endpoint.
const expoPushURL = "https://exp.host/--/api/v2/push/send"

// Notification is a single push message (sent to one or many tokens).
type Notification struct {
	Title string         `json:"title"`
	Body  string         `json:"body"`
	Data  map[string]any `json:"data,omitempty"`
}

// Sender delivers a notification to a set of device tokens. Implementations:
// ExpoSender (Expo push relay) and FCMSender (Firebase Cloud Messaging v1).
type Sender interface {
	SendToTokens(ctx context.Context, tokens []string, n Notification) error
}

// ExpoSender delivers via Expo's push relay. The zero value is ready to use.
type ExpoSender struct{}

// SendToTokens implements Sender by delegating to the package-level Expo sender.
func (ExpoSender) SendToTokens(ctx context.Context, tokens []string, n Notification) error {
	return SendToTokens(ctx, tokens, n)
}

// message is one entry in the Expo push request array.
type message struct {
	To    string         `json:"to"`
	Title string         `json:"title"`
	Body  string         `json:"body"`
	Sound string         `json:"sound"`
	Data  map[string]any `json:"data,omitempty"`
}

var client = &http.Client{Timeout: 10 * time.Second}

// SendToTokens delivers the notification to every token in one batched request.
// It is pure transport (no DB): callers resolve a user's tokens first. Errors
// are returned but are safe to ignore at the call site.
func SendToTokens(ctx context.Context, tokens []string, n Notification) error {
	if len(tokens) == 0 {
		return nil
	}
	msgs := make([]message, 0, len(tokens))
	for _, t := range tokens {
		msgs = append(msgs, message{To: t, Title: n.Title, Body: n.Body, Sound: "default", Data: n.Data})
	}
	payload, err := json.Marshal(msgs)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, expoPushURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// We don't inspect per-ticket receipts here; Expo accepts the batch and
	// handles delivery asynchronously.
	return nil
}
