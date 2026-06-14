package telemetry

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	lkauth "github.com/livekit/protocol/auth"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// voiceTokenTTL bounds how long a minted LiveKit join token is valid. Clients
// re-fetch on (re)connect, so a short window limits the blast radius of a leaked
// token while comfortably covering a normal ride.
const voiceTokenTTL = 6 * time.Hour

// voiceRoomName is the LiveKit room for a session. Keyed by the session id (not
// the share code) so a room survives a code rotation and never collides.
func voiceRoomName(sessionID int64) string {
	return fmt.Sprintf("ride-%d", sessionID)
}

// voiceTokenResponse is handed to the mobile client to join the LiveKit room.
type voiceTokenResponse struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	Room  string `json:"room"`
}

// voiceToken mints a LiveKit access token for the always-on group voice room of
// a session. The caller must be an active participant; the token grants publish
// and subscribe so every rider both speaks and hears without any push-to-talk.
func (h *handler) voiceToken(c *gin.Context) {
	me := authpkg.UserID(c)
	code := c.Param("code")

	var sessionID int64
	var status string
	err := h.d.DB.QueryRow(c,
		`SELECT id, status FROM ride_sessions WHERE code = $1`, code).Scan(&sessionID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "session not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load session")
		return
	}
	if status != "active" {
		httpx.Error(c, http.StatusConflict, "session has ended")
		return
	}

	var isParticipant bool
	if err := h.d.DB.QueryRow(c,
		`SELECT EXISTS(SELECT 1 FROM session_participants WHERE session_id = $1 AND user_id = $2)`,
		sessionID, me).Scan(&isParticipant); err != nil {
		httpx.Internal(c, "could not verify participant")
		return
	}
	if !isParticipant {
		httpx.Error(c, http.StatusForbidden, "not a participant of this session")
		return
	}

	var name string
	if err := h.d.DB.QueryRow(c, `SELECT name FROM users WHERE id = $1`, me).Scan(&name); err != nil {
		httpx.Internal(c, "could not load user")
		return
	}

	room := voiceRoomName(sessionID)
	token, err := h.mintVoiceToken(room, me, name)
	if err != nil {
		httpx.Internal(c, "could not mint voice token")
		return
	}

	c.JSON(http.StatusOK, voiceTokenResponse{
		URL:   h.d.Cfg.LiveKitURL,
		Token: token,
		Room:  room,
	})
}

// mintVoiceToken builds a signed LiveKit JWT granting the rider join, publish and
// subscribe rights on their session's room. Identity is the user id so the same
// rider can't occupy two slots; name is shown in the speaker UI.
func (h *handler) mintVoiceToken(room string, userID int64, name string) (string, error) {
	canPublish := true
	canSubscribe := true
	at := lkauth.NewAccessToken(h.d.Cfg.LiveKitAPIKey, h.d.Cfg.LiveKitAPISecret).
		SetIdentity(fmt.Sprintf("user-%d", userID)).
		SetName(name).
		SetValidFor(voiceTokenTTL).
		SetVideoGrant(&lkauth.VideoGrant{
			RoomJoin:     true,
			Room:         room,
			CanPublish:   &canPublish,
			CanSubscribe: &canSubscribe,
		})
	return at.ToJWT()
}
