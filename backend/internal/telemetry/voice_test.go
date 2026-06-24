package telemetry

import (
	"net/http"
	"net/http/httptest"
	"testing"

	lkauth "github.com/livekit/protocol/auth"

	"github.com/morider/backend/internal/server"
	"github.com/morider/backend/pkg/config"
)

func TestVoiceRoomName(t *testing.T) {
	if got := voiceRoomName(42); got != "ride-42" {
		t.Fatalf("voiceRoomName(42) = %q, want ride-42", got)
	}
}

// TestPublicLiveKitURL covers the deploy footgun this helper guards against: a
// localhost LIVEKIT_URL must be rewritten to the public host the client reached,
// while an explicitly public URL is handed back untouched.
func TestPublicLiveKitURL(t *testing.T) {
	cases := []struct {
		name       string
		configured string
		host       string
		tls        bool
		want       string
	}{
		{"localhost derives public host", "ws://localhost:7880", "138.197.178.107:8080", false, "ws://138.197.178.107:7880"},
		{"loopback ip derives host", "ws://127.0.0.1:7880", "api.morider.app:8080", false, "ws://api.morider.app:7880"},
		{"preserves custom port", "ws://localhost:7999", "1.2.3.4:8080", false, "ws://1.2.3.4:7999"},
		{"tls request yields wss", "ws://localhost:7880", "api.morider.app", true, "wss://api.morider.app:7880"},
		{"explicit public url trusted", "wss://lk.morider.app", "1.2.3.4:8080", false, "wss://lk.morider.app"},
		{"unparseable host falls back to config", "ws://localhost:7880", "", false, "ws://localhost:7880"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/sessions/ABC/voice-token", nil)
			r.Host = tc.host
			if tc.tls {
				r.Header.Set("X-Forwarded-Proto", "https")
			}
			if got := publicLiveKitURL(tc.configured, r); got != tc.want {
				t.Errorf("publicLiveKitURL(%q, host=%q) = %q, want %q", tc.configured, tc.host, got, tc.want)
			}
		})
	}
}

// TestMintVoiceToken verifies the minted JWT is signed with the configured
// secret and carries the room-join, publish and subscribe grants the always-on
// voice room needs.
func TestMintVoiceToken(t *testing.T) {
	const key, secret = "testkey", "testsecret_at_least_32_bytes_long!!"
	h := &handler{d: &server.Deps{Cfg: config.Config{
		LiveKitURL:       "ws://lk.example",
		LiveKitAPIKey:    key,
		LiveKitAPISecret: secret,
	}}}

	tok, err := h.mintVoiceToken(voiceRoomName(7), 99, "Ayşe")
	if err != nil {
		t.Fatalf("mintVoiceToken: %v", err)
	}

	v, err := lkauth.ParseAPIToken(tok)
	if err != nil {
		t.Fatalf("ParseAPIToken: %v", err)
	}
	_, grants, err := v.Verify(secret)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if v.Identity() != "user-99" {
		t.Errorf("identity = %q, want user-99", v.Identity())
	}
	if grants.Video == nil || !grants.Video.RoomJoin {
		t.Fatalf("expected RoomJoin grant, got %+v", grants.Video)
	}
	if grants.Video.Room != "ride-7" {
		t.Errorf("room = %q, want ride-7", grants.Video.Room)
	}
	if grants.Video.CanPublish == nil || !*grants.Video.CanPublish {
		t.Error("expected CanPublish=true")
	}
	if grants.Video.CanSubscribe == nil || !*grants.Video.CanSubscribe {
		t.Error("expected CanSubscribe=true")
	}
}
