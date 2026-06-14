package telemetry

import (
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
