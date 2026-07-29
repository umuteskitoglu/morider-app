package telemetry

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/time/rate"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/events"
	"github.com/morider/backend/pkg/httpx"
	"github.com/morider/backend/pkg/wshub"
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

	// The session and its first participant are created together: as two
	// statements, a failure on the second left an orphaned session holding a
	// code nobody was in.
	tx, err := h.d.DB.Begin(c)
	if err != nil {
		httpx.Internal(c, "could not create session")
		return
	}
	defer func() { _ = tx.Rollback(c) }()

	var (
		sessionID int64
		code      string
	)
	// Retry on the rare code collision (unique violation). Each attempt runs in
	// its own savepoint: a failed INSERT aborts the surrounding transaction, so
	// without one the retry would fail too.
	for attempt := 0; attempt < 5; attempt++ {
		gen, err := generateCode()
		if err != nil {
			httpx.Internal(c, "could not create session")
			return
		}
		sp, err := tx.Begin(c) // nested Begin = SAVEPOINT
		if err != nil {
			httpx.Internal(c, "could not create session")
			return
		}
		err = sp.QueryRow(c,
			`INSERT INTO ride_sessions (code, host_id, route_id) VALUES ($1, $2, $3) RETURNING id`,
			gen, host, routeID).Scan(&sessionID)
		if err == nil {
			if err := sp.Commit(c); err != nil {
				httpx.Internal(c, "could not create session")
				return
			}
			code = gen
			break
		}
		_ = sp.Rollback(c)
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

	if _, err := tx.Exec(c,
		`INSERT INTO session_participants (session_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		sessionID, host); err != nil {
		httpx.Internal(c, "could not join session")
		return
	}
	if err := tx.Commit(c); err != nil {
		httpx.Internal(c, "could not create session")
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
		// Attendees of the event this session was started from may join even
		// without a mutual follow — RSVP "going" is the invite.
		if !mutual {
			var invited bool
			if err := h.d.DB.QueryRow(c,
				`SELECT EXISTS(
				    SELECT 1 FROM events e
				    JOIN event_participants ep ON ep.event_id = e.id
				    WHERE e.ride_session_id = $1 AND ep.user_id = $2 AND ep.rsvp = 'going')`,
				sessionID, me).Scan(&invited); err != nil {
				httpx.Internal(c, "could not verify invite")
				return
			}
			if !invited {
				httpx.Error(c, http.StatusForbidden, "you must follow each other with the host to join")
				return
			}
		}
	}

	if _, err := h.d.DB.Exec(c,
		`INSERT INTO session_participants (session_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		sessionID, me); err != nil {
		httpx.Internal(c, "could not join session")
		return
	}
	h.leaveOtherActiveSessions(c, me, sessionID)
	// Roster grew → re-evaluate group-ride badges for the whole pack.
	h.publishRoster(c, sessionID)
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
			h.hub.DisconnectRoom(sessionID)
		}
	} else {
		_, err = h.d.DB.Exec(c,
			`DELETE FROM session_participants WHERE session_id = $1 AND user_id = $2`, sessionID, me)
		if err == nil {
			h.publishControl(sessionID, gin.H{"type": "left", "user_id": me, "session_id": sessionID})
			h.hub.DisconnectUser(sessionID, me)
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
	// The session is over: no socket should keep streaming positions into it.
	h.hub.DisconnectRoom(sessionID)
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

	// A 6-character code is not an authorisation token. Without this check any
	// authenticated user could enumerate codes and read a pack's roster and
	// full planned route. Callers who are not yet participants must go through
	// join, which enforces the mutual-follow / event-invite rule.
	if me := authpkg.UserID(c); me != hostID {
		// Mirrors joinSession's rule, ban included: anyone who could join may
		// preview, and nobody else. Without the ban clause an ejected rider who
		// still mutually follows the host could keep reading the roster.
		var allowed bool
		if err := h.d.DB.QueryRow(c,
			`SELECT NOT EXISTS(SELECT 1 FROM session_bans WHERE session_id = $1 AND user_id = $2)
			    AND (
			     EXISTS(SELECT 1 FROM session_participants WHERE session_id = $1 AND user_id = $2)
			     OR EXISTS(
			         SELECT 1 FROM events e
			         JOIN event_participants ep ON ep.event_id = e.id
			         WHERE e.ride_session_id = $1 AND ep.user_id = $2 AND ep.rsvp = 'going')
			     OR (EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = $3)
			         AND EXISTS(SELECT 1 FROM follows WHERE follower_id = $3 AND followee_id = $2)))`,
			sessionID, me, hostID).Scan(&allowed); err != nil {
			httpx.Internal(c, "could not verify access")
			return
		}
		if !allowed {
			httpx.Error(c, http.StatusForbidden, "you must follow each other with the host to view this ride")
			return
		}
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
		// Bounded: an imported route can carry tens of thousands of vertices,
		// and this used to load every one into memory per request.
		rrows, err := h.d.DB.Query(c,
			`SELECT ST_Y(d.geom) AS lat, ST_X(d.geom) AS lon
			 FROM (SELECT (ST_DumpPoints(path)).geom AS geom FROM routes WHERE id = $1) d
			 LIMIT $2`, *routeID, maxRoutePoints)
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
	h.hub.PublishJSON(sessionID, payload)
}

// publishRoster announces a session's current participant set on NATS so the
// reward service can award group-ride badges to the whole pack. Best effort and
// a no-op without NATS.
func (h *handler) publishRoster(ctx context.Context, sessionID int64) {
	if h.nats == nil {
		return
	}
	rows, err := h.d.DB.Query(ctx, `SELECT user_id FROM session_participants WHERE session_id = $1`, sessionID)
	if err != nil {
		return
	}
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	// A connection failure mid-iteration would otherwise publish a silently
	// truncated roster, and the reward service would award group-ride badges to
	// only part of the pack.
	if rows.Err() != nil {
		return
	}
	if data, err := json.Marshal(events.SessionRoster{SessionID: sessionID, ParticipantIDs: ids}); err == nil {
		_ = h.nats.Publish(events.SubjectSessionRoster, data)
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
	// A partial read here would silently leave the user in two active sessions,
	// breaking the single-active-ride invariant this function exists to hold.
	if rows.Err() != nil {
		return
	}

	for _, s := range others {
		if s.host == userID {
			if _, err := h.d.DB.Exec(c,
				`UPDATE ride_sessions SET status='ended', ended_at=now() WHERE id=$1 AND status='active'`, s.id); err == nil {
				h.publishControl(s.id, gin.H{"type": "ended", "session_id": s.id})
				h.hub.DisconnectRoom(s.id)
			}
		} else {
			if _, err := h.d.DB.Exec(c,
				`DELETE FROM session_participants WHERE session_id=$1 AND user_id=$2`, s.id, userID); err == nil {
				h.publishControl(s.id, gin.H{"type": "left", "user_id": userID, "session_id": s.id})
				h.hub.DisconnectUser(s.id, userID)
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

	// Removal and the ban must land together: as two statements, a failure
	// between them returned 500 while the user was already kicked but not
	// banned, so they simply rejoined.
	tx, err := h.d.DB.Begin(c)
	if err != nil {
		httpx.Internal(c, "could not remove participant")
		return
	}
	defer func() { _ = tx.Rollback(c) }()

	tag, err := tx.Exec(c,
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
		if _, err := tx.Exec(c,
			`INSERT INTO session_bans (session_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			sessionID, req.UserID); err != nil {
			httpx.Internal(c, "could not ban participant")
			return
		}
	}
	if err := tx.Commit(c); err != nil {
		httpx.Internal(c, "could not remove participant")
		return
	}

	kind := "kick"
	if ban {
		kind = "ban"
	}
	h.publishControl(sessionID, gin.H{"type": kind, "user_id": req.UserID, "session_id": sessionID})
	// Enforce it server-side. The control frame above is a courtesy to a
	// well-behaved client; on its own it left a modified client subscribed to
	// the pack's live GPS for as long as it kept the socket open.
	h.hub.DisconnectUser(sessionID, req.UserID)
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

	// Check and update in one statement. As two, a participant leaving in the
	// gap between them transferred the session to somebody who was no longer in
	// it, leaving an orphaned ride nobody could end.
	var newHost int64
	err := h.d.DB.QueryRow(c,
		`UPDATE ride_sessions SET host_id = $2
		 WHERE id = $1 AND host_id = $3 AND status = 'active'
		   AND EXISTS (SELECT 1 FROM session_participants WHERE session_id = $1 AND user_id = $2)
		 RETURNING host_id`,
		sessionID, req.UserID, hostID).Scan(&newHost)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.BadRequest(c, "user is not a participant of this active session")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not transfer host")
		return
	}
	h.publishControl(sessionID, gin.H{"type": "host", "host_id": req.UserID, "session_id": sessionID})
	c.Status(http.StatusNoContent)
}

type wsPositionIn struct {
	// Type distinguishes special frames; empty means a regular position.
	// "sos" broadcasts a crash/emergency alert to the whole session.
	Type string `json:"type"`
	// HasLoc reports whether Lat/Lon are a real fix (false = no GPS yet, so
	// recipients must not navigate to 0,0).
	HasLoc bool    `json:"has_loc"`
	Lat    float64 `json:"lat"`
	Lon    float64 `json:"lon"`
	Speed  float64 `json:"speed"`
}

// sosCooldown throttles SOS frames from a single connection so a buggy or
// hostile client can't flood every participant with crash alerts.
const sosCooldown = 10 * time.Second

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

	// Bound inbound frames and arm the liveness deadline before anything else:
	// without them a connection dropped by a tunnel or a NAT timeout blocks the
	// read loop forever, leaking this goroutine, the writer, the socket and the
	// hub entry — and the ghost keeps receiving every broadcast.
	wshub.ConfigureReader(conn, maxPositionFrame)

	client := wshub.NewClient(me, wshub.DefaultSendBuffer)
	h.hub.Add(sessionID, client)
	defer func() {
		h.hub.Remove(sessionID, client)
		client.Close()
	}()
	// Lets a server-side kick/ban interrupt a read already in flight.
	client.CloseOnDone(conn)

	go client.WritePump(conn)

	// Read loop: every inbound position is stamped and published to the session.
	var lastSOS time.Time
	limiter := rate.NewLimiter(positionRate, positionRate*2)
	for {
		var in wsPositionIn
		if err := conn.ReadJSON(&in); err != nil {
			return
		}
		// Each frame fans out to every participant, so an unthrottled client is
		// an N-times amplifier against the whole pack and NATS.
		if !limiter.Allow() {
			continue
		}
		// SOS frame: rider's crash countdown expired (or manual emergency).
		// Fan it out as a control frame so every participant gets alerted.
		// Deliberately no speed: only the location needed to find the rider.
		if in.Type == "sos" {
			now := time.Now()
			if now.Sub(lastSOS) < sosCooldown {
				continue // drop floods from this connection
			}
			lastSOS = now
			hasLoc := in.HasLoc && validCoord(in.Lat, in.Lon)
			h.publishControl(sessionID, gin.H{
				"type":       "sos",
				"session_id": sessionID,
				"user_id":    me,
				"name":       name,
				"has_loc":    hasLoc,
				"lat":        in.Lat,
				"lon":        in.Lon,
				"ts":         now.UnixMilli(),
			})
			// Also push the crash location through the normal position channel so
			// participants' maps move the rider's marker to the crash site (and
			// anyone reconnecting sees it), but only when it's a real fix.
			if hasLoc {
				h.hub.PublishJSON(sessionID, events.LivePosition{
					SessionID: sessionID,
					UserID:    me,
					Name:      name,
					Lat:       in.Lat,
					Lon:       in.Lon,
					Ts:        now.UnixMilli(),
				})
			}
			continue
		}
		// Honour HasLoc on the regular path too. It was only checked for SOS
		// frames, so a rider without a fix was broadcast at 0,0 and every other
		// map moved their marker to the Gulf of Guinea.
		if !in.HasLoc || !validCoord(in.Lat, in.Lon) {
			continue
		}
		speed := in.Speed
		if math.IsNaN(speed) || math.IsInf(speed, 0) || speed < 0 || speed > maxPlausibleSpeed {
			speed = 0
		}
		h.hub.PublishJSON(sessionID, events.LivePosition{
			SessionID: sessionID,
			UserID:    me,
			Name:      name,
			Lat:       in.Lat,
			Lon:       in.Lon,
			Speed:     speed,
			Ts:        time.Now().UnixMilli(),
		})
	}
}

// maxPositionFrame bounds one inbound position frame (~150 bytes in practice).
const maxPositionFrame = 4 << 10

// maxRoutePoints caps the route geometry returned with a session.
const maxRoutePoints = 5000

// positionRate is the per-connection ceiling on position frames per second.
const positionRate = 5

// validCoord reports whether a coordinate pair is a finite, in-range fix.
func validCoord(lat, lon float64) bool {
	if math.IsNaN(lat) || math.IsNaN(lon) || math.IsInf(lat, 0) || math.IsInf(lon, 0) {
		return false
	}
	return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}
