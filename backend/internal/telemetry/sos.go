package telemetry

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
	"github.com/morider/backend/pkg/push"
)

// SOS delivery.
//
// The WebSocket frame in sessions.go reaches exactly the riders who happen to
// have the group screen open right now. That is the wrong audience for a crash:
// the people most likely to help are the ones riding, with the phone in a
// pocket and the app backgrounded — precisely who a WS-only broadcast misses.
//
// This endpoint makes an SOS durable and delivers it out-of-band:
//
//   - it is written to sos_events before anything is sent, so the alert
//     survives the request and the client can safely retry it (client_id keeps
//     retries idempotent — a rider regaining signal ten minutes later must not
//     raise a second alarm);
//   - it fans out as a push notification to the rider's group, which wakes
//     phones the WebSocket cannot reach;
//   - it still publishes the WS control frame, so open screens react instantly.
//
// Not covered here: notifying an off-app emergency contact by SMS. That needs
// an SMS provider (none is configured — see notifyContact below), and it is a
// deliberate gap rather than an oversight: for a solo rider this endpoint can
// currently only record the event, not summon anyone.

type sosRequest struct {
	// Stable per incident so retries collapse onto one row.
	ClientID    string   `json:"client_id"`
	SessionCode string   `json:"session_code"`
	Lat         *float64 `json:"lat"`
	Lon         *float64 `json:"lon"`
	AccuracyM   *float64 `json:"accuracy_m"`
	BatteryPct  *int     `json:"battery_pct"`
	// "crash" (auto-detected) or "manual".
	Source string `json:"source"`
}

func (h *handler) raiseSOS(c *gin.Context) {
	me := authpkg.UserID(c)
	var req sosRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, "invalid body")
		return
	}
	if req.ClientID == "" {
		httpx.BadRequest(c, "client_id is required")
		return
	}
	source := req.Source
	if source != "manual" {
		source = "crash"
	}

	ctx := c.Request.Context()

	// Resolve the group session, if the rider was in one.
	var sessionID *int64
	if req.SessionCode != "" {
		var id int64
		if err := h.d.DB.QueryRow(ctx,
			`SELECT id FROM ride_sessions WHERE code = $1 AND status = 'active'`, req.SessionCode).Scan(&id); err == nil {
			sessionID = &id
		}
	}

	// Record first, notify second: an SOS that was written down but not
	// delivered is recoverable; one that was delivered but not written down is
	// invisible the moment the notification is dismissed.
	var (
		sosID     int64
		createdAt time.Time
		existing  bool
	)
	err := h.d.DB.QueryRow(ctx,
		`INSERT INTO sos_events (user_id, session_id, lat, lon, accuracy_m, battery_pct, source, client_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (user_id, client_id) DO UPDATE
		   SET lat = COALESCE(EXCLUDED.lat, sos_events.lat),
		       lon = COALESCE(EXCLUDED.lon, sos_events.lon)
		 RETURNING id, created_at, (xmax <> 0) AS existed`,
		me, sessionID, req.Lat, req.Lon, req.AccuracyM, req.BatteryPct, source, req.ClientID,
	).Scan(&sosID, &createdAt, &existing)
	if err != nil {
		httpx.Internal(c, "could not record SOS")
		return
	}

	// A retry of an alert we already fanned out must not alarm the group twice.
	if existing {
		c.JSON(http.StatusOK, gin.H{"sos_id": sosID, "duplicate": true, "notified": 0})
		return
	}

	var name string
	_ = h.d.DB.QueryRow(ctx, `SELECT name FROM users WHERE id = $1`, me).Scan(&name)
	if name == "" {
		name = "Bir sürücü"
	}

	// Instant path for anyone with the screen open.
	if sessionID != nil {
		h.publishControl(*sessionID, gin.H{
			"type":       "sos",
			"session_id": *sessionID,
			"user_id":    me,
			"name":       name,
			"has_loc":    req.Lat != nil && req.Lon != nil,
			"lat":        valueOr(req.Lat, 0),
			"lon":        valueOr(req.Lon, 0),
			"sos_id":     sosID,
			"ts":         createdAt.UnixMilli(),
		})
	}

	notified := h.notifySOS(ctx, sosID, me, name, sessionID, req.Lat, req.Lon)
	if notified > 0 {
		_, _ = h.d.DB.Exec(ctx, `UPDATE sos_events SET notified = $2 WHERE id = $1`, sosID, notified)
	}
	h.d.Log.Warn().
		Int64("sos_id", sosID).
		Int64("user_id", me).
		Int("notified", notified).
		Bool("has_loc", req.Lat != nil).
		Msg("SOS raised")

	c.JSON(http.StatusCreated, gin.H{"sos_id": sosID, "notified": notified})
}

// resolveSOS marks an alert as over — the rider cancelled it or confirmed they
// are safe. Kept separate from raising so a false alarm leaves an honest trail
// rather than being deleted.
func (h *handler) resolveSOS(c *gin.Context) {
	me := authpkg.UserID(c)
	id := c.Param("id")
	tag, err := h.d.DB.Exec(c.Request.Context(),
		`UPDATE sos_events SET resolved_at = now() WHERE id = $1 AND user_id = $2 AND resolved_at IS NULL`, id, me)
	if err != nil {
		httpx.Internal(c, "could not resolve SOS")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "sos not found")
		return
	}
	c.JSON(http.StatusOK, gin.H{"resolved": true})
}

// notifySOS pushes the alert to everyone who could plausibly reach the rider.
// Returns how many device tokens were *addressed* — the send itself is
// asynchronous, so this is not a delivery count.
func (h *handler) notifySOS(
	ctx context.Context,
	sosID, userID int64,
	name string,
	sessionID *int64,
	lat, lon *float64,
) int {
	if h.push == nil || sessionID == nil {
		// Solo riders have no in-app audience. Recording the event is all this
		// endpoint can do for them until an SMS provider exists.
		return 0
	}

	rows, err := h.d.DB.Query(ctx,
		`SELECT t.token FROM push_tokens t
		 JOIN session_participants p ON p.user_id = t.user_id
		 WHERE p.session_id = $1 AND p.user_id <> $2`,
		*sessionID, userID)
	if err != nil {
		return 0
	}
	defer rows.Close()
	var tokens []string
	for rows.Next() {
		var tok string
		if err := rows.Scan(&tok); err == nil && tok != "" {
			tokens = append(tokens, tok)
		}
	}
	if len(tokens) == 0 {
		return 0
	}

	body := name + " kaza yapmış olabilir!"
	data := map[string]any{"type": "sos", "sos_id": sosID, "user_id": userID}
	if lat != nil && lon != nil {
		body += fmt.Sprintf(" Konum: %.5f, %.5f", *lat, *lon)
		data["lat"] = *lat
		data["lon"] = *lon
	} else {
		body += " (Konum alınamadı.)"
	}

	// Fire and forget with its own context: the caller's request context is
	// cancelled the moment we respond, and this must not be cut short.
	go func() {
		sendCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = h.push.SendToTokens(sendCtx, tokens, push.Notification{
			Title: "🚨 ACİL DURUM",
			Body:  body,
			Data:  data,
		})
	}()
	return len(tokens)
}

func valueOr(p *float64, fallback float64) float64 {
	if p == nil {
		return fallback
	}
	return *p
}
