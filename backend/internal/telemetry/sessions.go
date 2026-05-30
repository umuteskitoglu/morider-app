package telemetry

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/events"
	"github.com/morider/backend/pkg/httpx"
)

// codeAlphabet excludes visually ambiguous characters (0/O, 1/I) so codes are
// easy to read aloud and share.
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func generateCode() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b), nil
}

type sessionUser struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type latlon struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type createSessionReq struct {
	RouteID int64 `json:"route_id"`
}

// createSession opens a new active session hosted by the caller, optionally tied
// to a route, and adds the host as the first participant.
func (h *handler) createSession(c *gin.Context) {
	var req createSessionReq
	_ = c.ShouldBindJSON(&req) // body is optional (no route)
	host := authpkg.UserID(c)

	var routeID *int64
	if req.RouteID != 0 {
		routeID = &req.RouteID
	}

	var (
		sessionID int64
		code      string
	)
	// Retry on the rare code collision (unique violation).
	for attempt := 0; attempt < 5; attempt++ {
		gen, err := generateCode()
		if err != nil {
			httpx.Internal(c, "could not create session")
			return
		}
		err = h.d.DB.QueryRow(c,
			`INSERT INTO ride_sessions (code, host_id, route_id) VALUES ($1, $2, $3) RETURNING id`,
			gen, host, routeID).Scan(&sessionID)
		if err == nil {
			code = gen
			break
		}
		var pgErr *pgconn.PgError
		if !(errors.As(err, &pgErr) && pgErr.Code == "23505") {
			httpx.Internal(c, "could not create session")
			return
		}
	}
	if code == "" {
		httpx.Internal(c, "could not allocate session code")
		return
	}

	if _, err := h.d.DB.Exec(c,
		`INSERT INTO session_participants (session_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		sessionID, host); err != nil {
		httpx.Internal(c, "could not join session")
		return
	}
	h.leaveOtherActiveSessions(c, host, sessionID)
	c.JSON(http.StatusCreated, gin.H{"session_id": sessionID, "code": code, "route_id": req.RouteID})
}

// joinSession adds the caller to a session by code. Only the host and their
// mutual followers ("friends") may join.
func (h *handler) joinSession(c *gin.Context) {
	code := c.Param("code")
	me := authpkg.UserID(c)

	var sessionID, hostID int64
	var status string
	err := h.d.DB.QueryRow(c,
		`SELECT id, host_id, status FROM ride_sessions WHERE code = $1`, code).
		Scan(&sessionID, &hostID, &status)
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

	if me != hostID {
		var banned bool
		if err := h.d.DB.QueryRow(c,
			`SELECT EXISTS(SELECT 1 FROM session_bans WHERE session_id = $1 AND user_id = $2)`,
			sessionID, me).Scan(&banned); err != nil {
			httpx.Internal(c, "could not check ban")
			return
		}
		if banned {
			httpx.Error(c, http.StatusForbidden, "you are banned from this session")
			return
		}

		mutual, err := h.areMutual(c, me, hostID)
		if err != nil {
			httpx.Internal(c, "could not verify follow")
			return
		}
		if !mutual {
			httpx.Error(c, http.StatusForbidden, "you must follow each other with the host to join")
			return
		}
	}

	if _, err := h.d.DB.Exec(c,
		`INSERT INTO session_participants (session_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		sessionID, me); err != nil {
		httpx.Internal(c, "could not join session")
		return
	}
	h.leaveOtherActiveSessions(c, me, sessionID)
	c.JSON(http.StatusOK, gin.H{"session_id": sessionID, "code": code})
}

// leaveSession removes the caller from a session. When the host leaves, the
// whole session ends.
func (h *handler) leaveSession(c *gin.Context) {
	code := c.Param("code")
	me := authpkg.UserID(c)

	var sessionID, hostID int64
	err := h.d.DB.QueryRow(c,
		`SELECT id, host_id FROM ride_sessions WHERE code = $1`, code).Scan(&sessionID, &hostID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "session not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load session")
		return
	}

	if me == hostID {
		_, err = h.d.DB.Exec(c,
			`UPDATE ride_sessions SET status = 'ended', ended_at = now() WHERE id = $1 AND status = 'active'`, sessionID)
		if err == nil {
			h.publishControl(sessionID, gin.H{"type": "ended", "session_id": sessionID})
		}
	} else {
		_, err = h.d.DB.Exec(c,
			`DELETE FROM session_participants WHERE session_id = $1 AND user_id = $2`, sessionID, me)
		if err == nil {
			h.publishControl(sessionID, gin.H{"type": "left", "user_id": me, "session_id": sessionID})
		}
	}
	if err != nil {
		httpx.Internal(c, "could not leave session")
		return
	}
	c.Status(http.StatusNoContent)
}

// endSession lets the host end an active session.
func (h *handler) endSession(c *gin.Context) {
	var sessionID int64
	err := h.d.DB.QueryRow(c,
		`UPDATE ride_sessions SET status = 'ended', ended_at = now()
		 WHERE code = $1 AND host_id = $2 AND status = 'active' RETURNING id`,
		c.Param("code"), authpkg.UserID(c)).Scan(&sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "active session not found for host")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not end session")
		return
	}
	h.publishControl(sessionID, gin.H{"type": "ended", "session_id": sessionID})
	c.Status(http.StatusNoContent)
}

// getSession returns session metadata, participants and the target route
// geometry (if any). Used by the join/lobby screen.
func (h *handler) getSession(c *gin.Context) {
	code := c.Param("code")

	var (
		sessionID, hostID int64
		status            string
		routeID           *int64
	)
	err := h.d.DB.QueryRow(c,
		`SELECT id, host_id, status, route_id FROM ride_sessions WHERE code = $1`, code).
		Scan(&sessionID, &hostID, &status, &routeID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "session not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load session")
		return
	}

	prows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name FROM session_participants sp
		 JOIN users u ON u.id = sp.user_id WHERE sp.session_id = $1
		 ORDER BY sp.joined_at`, sessionID)
	if err != nil {
		httpx.Internal(c, "could not load participants")
		return
	}
	participants := make([]sessionUser, 0)
	for prows.Next() {
		var u sessionUser
		if err := prows.Scan(&u.ID, &u.Name); err != nil {
			prows.Close()
			httpx.Internal(c, "could not read participants")
			return
		}
		participants = append(participants, u)
	}
	prows.Close()

	routePoints := make([]latlon, 0)
	var resolvedRouteID int64
	if routeID != nil {
		resolvedRouteID = *routeID
		rrows, err := h.d.DB.Query(c,
			`SELECT ST_Y(d.geom) AS lat, ST_X(d.geom) AS lon
			 FROM (SELECT (ST_DumpPoints(path)).geom AS geom FROM routes WHERE id = $1) d`, *routeID)
		if err != nil {
			httpx.Internal(c, "could not load route geometry")
			return
		}
		for rrows.Next() {
			var p latlon
			if err := rrows.Scan(&p.Lat, &p.Lon); err != nil {
				rrows.Close()
				httpx.Internal(c, "could not read route geometry")
				return
			}
			routePoints = append(routePoints, p)
		}
		rrows.Close()
	}

	c.JSON(http.StatusOK, gin.H{
		"session_id":   sessionID,
		"code":         code,
		"host_id":      hostID,
		"status":       status,
		"route_id":     resolvedRouteID,
		"participants": participants,
		"route_points": routePoints,
	})
}

// myActiveSessions lists the active sessions the caller is a participant of, so
// the app can offer to rejoin after a restart.
func (h *handler) myActiveSessions(c *gin.Context) {
	me := authpkg.UserID(c)
	rows, err := h.d.DB.Query(c,
		`SELECT s.id, s.code, s.host_id, COALESCE(s.route_id, 0),
		        (SELECT COUNT(*) FROM session_participants p WHERE p.session_id = s.id)
		 FROM ride_sessions s
		 JOIN session_participants sp ON sp.session_id = s.id
		 WHERE sp.user_id = $1 AND s.status = 'active'
		 ORDER BY s.created_at DESC`, me)
	if err != nil {
		httpx.Internal(c, "could not list sessions")
		return
	}
	defer rows.Close()

	type item struct {
		SessionID    int64  `json:"session_id"`
		Code         string `json:"code"`
		HostID       int64  `json:"host_id"`
		RouteID      int64  `json:"route_id"`
		Participants int64  `json:"participants"`
		IsHost       bool   `json:"is_host"`
	}
	sessions := make([]item, 0)
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.SessionID, &it.Code, &it.HostID, &it.RouteID, &it.Participants); err != nil {
			httpx.Internal(c, "could not read sessions")
			return
		}
		it.IsHost = it.HostID == me
		sessions = append(sessions, it)
	}
	c.JSON(http.StatusOK, gin.H{"sessions": sessions})
}

// areMutual reports whether a and b follow each other.
func (h *handler) areMutual(ctx context.Context, a, b int64) (bool, error) {
	var mutual bool
	err := h.d.DB.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2)
		    AND EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = $1)`,
		a, b).Scan(&mutual)
	return mutual, err
}

type targetReq struct {
	UserID int64 `json:"user_id" binding:"required"`
}

// publishControl fans a non-position control event (kick/ban/host) out to the
// session's WebSocket clients. Control frames carry a "type" field; position
// frames do not, so clients can tell them apart.
func (h *handler) publishControl(sessionID int64, payload gin.H) {
	if data, err := json.Marshal(payload); err == nil {
		h.hub.publish(sessionID, data)
	}
}

// leaveOtherActiveSessions removes the user from every active session except
// keepID, ending any they host — enforcing a single active group ride. Best
// effort: failures here must not block the join/create that triggered it.
func (h *handler) leaveOtherActiveSessions(c *gin.Context, userID, keepID int64) {
	rows, err := h.d.DB.Query(c,
		`SELECT s.id, s.host_id FROM ride_sessions s
		 JOIN session_participants sp ON sp.session_id = s.id
		 WHERE sp.user_id = $1 AND s.status = 'active' AND s.id <> $2`, userID, keepID)
	if err != nil {
		return
	}
	type sess struct{ id, host int64 }
	var others []sess
	for rows.Next() {
		var s sess
		if err := rows.Scan(&s.id, &s.host); err == nil {
			others = append(others, s)
		}
	}
	rows.Close()

	for _, s := range others {
		if s.host == userID {
			if _, err := h.d.DB.Exec(c,
				`UPDATE ride_sessions SET status='ended', ended_at=now() WHERE id=$1 AND status='active'`, s.id); err == nil {
				h.publishControl(s.id, gin.H{"type": "ended", "session_id": s.id})
			}
		} else {
			if _, err := h.d.DB.Exec(c,
				`DELETE FROM session_participants WHERE session_id=$1 AND user_id=$2`, s.id, userID); err == nil {
				h.publishControl(s.id, gin.H{"type": "left", "user_id": userID, "session_id": s.id})
			}
		}
	}
}

// hostOnly loads the session by code and verifies the caller is its host,
// returning the session id. It writes the error response and returns ok=false
// otherwise.
func (h *handler) hostOnly(c *gin.Context, code string) (int64, int64, bool) {
	var sessionID, hostID int64
	err := h.d.DB.QueryRow(c, `SELECT id, host_id FROM ride_sessions WHERE code = $1`, code).Scan(&sessionID, &hostID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "session not found")
		return 0, 0, false
	}
	if err != nil {
		httpx.Internal(c, "could not load session")
		return 0, 0, false
	}
	if authpkg.UserID(c) != hostID {
		httpx.Error(c, http.StatusForbidden, "only the host can do this")
		return 0, 0, false
	}
	return sessionID, hostID, true
}

// kickParticipant removes a participant; banParticipant also bars them from
// rejoining. Host only.
func (h *handler) kickParticipant(c *gin.Context) { h.removeParticipant(c, false) }
func (h *handler) banParticipant(c *gin.Context)  { h.removeParticipant(c, true) }

func (h *handler) removeParticipant(c *gin.Context, ban bool) {
	var req targetReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	sessionID, hostID, ok := h.hostOnly(c, c.Param("code"))
	if !ok {
		return
	}
	if req.UserID == hostID {
		httpx.BadRequest(c, "host cannot be removed")
		return
	}

	tag, err := h.d.DB.Exec(c,
		`DELETE FROM session_participants WHERE session_id = $1 AND user_id = $2`,
		sessionID, req.UserID)
	if err != nil {
		httpx.Internal(c, "could not remove participant")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.BadRequest(c, "user is not a participant")
		return
	}
	if ban {
		if _, err := h.d.DB.Exec(c,
			`INSERT INTO session_bans (session_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			sessionID, req.UserID); err != nil {
			httpx.Internal(c, "could not ban participant")
			return
		}
	}

	kind := "kick"
	if ban {
		kind = "ban"
	}
	h.publishControl(sessionID, gin.H{"type": kind, "user_id": req.UserID, "session_id": sessionID})
	c.Status(http.StatusNoContent)
}

// transferHost hands the host role to another participant. Host only.
func (h *handler) transferHost(c *gin.Context) {
	var req targetReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	sessionID, hostID, ok := h.hostOnly(c, c.Param("code"))
	if !ok {
		return
	}
	if req.UserID == hostID {
		httpx.BadRequest(c, "already the host")
		return
	}

	var isParticipant bool
	if err := h.d.DB.QueryRow(c,
		`SELECT EXISTS(SELECT 1 FROM session_participants WHERE session_id = $1 AND user_id = $2)`,
		sessionID, req.UserID).Scan(&isParticipant); err != nil {
		httpx.Internal(c, "could not verify participant")
		return
	}
	if !isParticipant {
		httpx.BadRequest(c, "user is not a participant")
		return
	}

	if _, err := h.d.DB.Exec(c, `UPDATE ride_sessions SET host_id = $2 WHERE id = $1`, sessionID, req.UserID); err != nil {
		httpx.Internal(c, "could not transfer host")
		return
	}
	h.publishControl(sessionID, gin.H{"type": "host", "host_id": req.UserID, "session_id": sessionID})
	c.Status(http.StatusNoContent)
}

type wsPositionIn struct {
	Lat   float64 `json:"lat"`
	Lon   float64 `json:"lon"`
	Speed float64 `json:"speed"`
}

// sessionWS streams live positions for a session. The caller must be a
// participant; their inbound positions are fanned out to the other participants
// and theirs are forwarded back to them.
func (h *handler) sessionWS(c *gin.Context) {
	claims, err := h.d.JWT.Parse(c.Query("token"))
	if err != nil {
		httpx.Error(c, http.StatusUnauthorized, "invalid token")
		return
	}
	me := claims.UserID
	code := c.Param("code")

	var sessionID int64
	var status string
	err = h.d.DB.QueryRow(c,
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

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	client := &wsClient{send: make(chan []byte, 16), done: make(chan struct{})}
	h.hub.add(sessionID, client)
	defer func() {
		h.hub.remove(sessionID, client)
		close(client.done)
	}()

	// Writer goroutine: the only place that writes to the gorilla connection.
	go func() {
		for {
			select {
			case data := <-client.send:
				if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
					return
				}
			case <-client.done:
				return
			}
		}
	}()

	// Read loop: every inbound position is stamped and published to the session.
	for {
		var in wsPositionIn
		if err := conn.ReadJSON(&in); err != nil {
			return
		}
		pos := events.LivePosition{
			SessionID: sessionID,
			UserID:    me,
			Name:      name,
			Lat:       in.Lat,
			Lon:       in.Lon,
			Speed:     in.Speed,
			Ts:        time.Now().UnixMilli(),
		}
		if data, err := json.Marshal(pos); err == nil {
			h.hub.publish(sessionID, data)
		}
	}
}
