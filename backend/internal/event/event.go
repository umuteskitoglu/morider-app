// Package event implements planned ride events: an organizer schedules a meet
// time and a departure time (with an optional route or free-form start/end
// locations), people join by code or invite link, set their RSVP and chat in
// real time. It mirrors the live group-ride session service in internal/telemetry.
package event

import (
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/nats-io/nats.go"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/httpx"
)

// Run boots the event service.
func Run(cfg config.Config) error {
	deps, err := server.New(context.Background(), "event", cfg)
	if err != nil {
		return err
	}
	h := &handler{d: deps}

	// NATS is optional: events and chat still work without it, only cross-replica
	// chat fan-out is skipped (the hub falls back to a local broadcast).
	if nc, err := nats.Connect(cfg.NATSURL, nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1)); err != nil {
		deps.Log.Warn().Err(err).Msg("nats unavailable, event chat fan-out disabled")
	} else {
		h.nats = nc
	}
	h.hub = newChatHub(h.nats)

	registerRoutes(deps, h)
	return deps.Run(config.ResolvePort("EVENT_PORT", "8088"))
}

func registerRoutes(d *server.Deps, h *handler) {
	g := d.Engine.Group("/api/events")
	jwt := d.JWT.Middleware()
	g.POST("", jwt, h.create)
	g.GET("", jwt, h.list)
	g.GET("/:code", jwt, h.get)
	g.PATCH("/:code", jwt, h.update)
	g.POST("/:code/rsvp", jwt, h.rsvp)
	g.POST("/:code/cancel", jwt, h.cancel)
	g.GET("/:code/messages", jwt, h.messages)
	// WebSocket auth uses ?token= because browsers cannot set custom headers.
	g.GET("/:code/ws", h.chatWS)
}

type handler struct {
	d    *server.Deps
	nats *nats.Conn
	hub  *chatHub
}

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

type latlon struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type eventUser struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	RSVP string `json:"rsvp"`
}

// create opens a new scheduled event hosted by the caller and adds the host as
// the first participant (RSVP "going"). A route is optional; without one the
// caller must supply at least a start location.
func (h *handler) create(c *gin.Context) {
	var req struct {
		Title       string    `json:"title" binding:"required"`
		Description string    `json:"description"`
		MeetAt      time.Time `json:"meet_at" binding:"required"`
		StartAt     time.Time `json:"start_at" binding:"required"`
		RouteID     *int64    `json:"route_id"`
		StartLat    *float64  `json:"start_lat"`
		StartLon    *float64  `json:"start_lon"`
		StartName   string    `json:"start_name"`
		EndLat      *float64  `json:"end_lat"`
		EndLon      *float64  `json:"end_lon"`
		EndName     string    `json:"end_name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	// A route OR a start location is required, so the event always has somewhere
	// to gather.
	if req.RouteID == nil && (req.StartLat == nil || req.StartLon == nil) {
		httpx.BadRequest(c, "either a route or a start location is required")
		return
	}

	host := authpkg.UserID(c)
	var (
		eventID int64
		code    string
	)
	// Retry on the rare code collision (unique violation).
	for attempt := 0; attempt < 5; attempt++ {
		gen, err := generateCode()
		if err != nil {
			httpx.Internal(c, "could not create event")
			return
		}
		err = h.d.DB.QueryRow(c,
			`INSERT INTO events (code, host_id, title, description, meet_at, start_at,
			        route_id, start_lat, start_lon, start_name, end_lat, end_lon, end_name)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
			gen, host, req.Title, req.Description, req.MeetAt, req.StartAt,
			req.RouteID, req.StartLat, req.StartLon, req.StartName, req.EndLat, req.EndLon, req.EndName,
		).Scan(&eventID)
		if err == nil {
			code = gen
			break
		}
		var pgErr *pgconn.PgError
		if !(errors.As(err, &pgErr) && pgErr.Code == "23505") {
			httpx.Internal(c, "could not create event")
			return
		}
	}
	if code == "" {
		httpx.Internal(c, "could not allocate event code")
		return
	}

	if _, err := h.d.DB.Exec(c,
		`INSERT INTO event_participants (event_id, user_id, rsvp) VALUES ($1, $2, 'going') ON CONFLICT DO NOTHING`,
		eventID, host); err != nil {
		httpx.Internal(c, "could not add host")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"event_id": eventID, "code": code})
}

// list returns the caller's upcoming events: those they host and those they have
// RSVP'd to, most recent meet time first.
func (h *handler) list(c *gin.Context) {
	me := authpkg.UserID(c)
	rows, err := h.d.DB.Query(c,
		`SELECT e.id, e.code, e.title, e.host_id, e.meet_at, e.start_at, e.status,
		        COALESCE(ep.rsvp, ''),
		        (SELECT COUNT(*) FROM event_participants p WHERE p.event_id = e.id AND p.rsvp = 'going')
		 FROM events e
		 LEFT JOIN event_participants ep ON ep.event_id = e.id AND ep.user_id = $1
		 WHERE e.status = 'scheduled'
		   AND e.meet_at >= now() - INTERVAL '12 hours'
		   AND (e.host_id = $1 OR ep.user_id = $1)
		 ORDER BY e.meet_at ASC`, me)
	if err != nil {
		httpx.Internal(c, "could not list events")
		return
	}
	defer rows.Close()

	type item struct {
		EventID   int64     `json:"event_id"`
		Code      string    `json:"code"`
		Title     string    `json:"title"`
		HostID    int64     `json:"host_id"`
		MeetAt    time.Time `json:"meet_at"`
		StartAt   time.Time `json:"start_at"`
		Status    string    `json:"status"`
		MyRSVP    string    `json:"my_rsvp"`
		GoingCount int64    `json:"going_count"`
		IsHost    bool      `json:"is_host"`
	}
	events := make([]item, 0)
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.EventID, &it.Code, &it.Title, &it.HostID, &it.MeetAt, &it.StartAt,
			&it.Status, &it.MyRSVP, &it.GoingCount); err != nil {
			httpx.Internal(c, "could not read events")
			return
		}
		it.IsHost = it.HostID == me
		events = append(events, it)
	}
	c.JSON(http.StatusOK, gin.H{"events": events})
}

// get returns full event detail: metadata, host, the target route geometry (if
// any) and the participant list with each person's RSVP.
func (h *handler) get(c *gin.Context) {
	code := c.Param("code")

	var (
		eventID, hostID                int64
		title, status                  string
		description, startName, endName *string
		meetAt, startAt                time.Time
		routeID                        *int64
		startLat, startLon             *float64
		endLat, endLon                 *float64
	)
	err := h.d.DB.QueryRow(c,
		`SELECT id, host_id, title, description, meet_at, start_at, status, route_id,
		        start_lat, start_lon, start_name, end_lat, end_lon, end_name
		 FROM events WHERE code = $1`, code).
		Scan(&eventID, &hostID, &title, &description, &meetAt, &startAt, &status, &routeID,
			&startLat, &startLon, &startName, &endLat, &endLon, &endName)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "event not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load event")
		return
	}

	prows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, ep.rsvp FROM event_participants ep
		 JOIN users u ON u.id = ep.user_id WHERE ep.event_id = $1
		 ORDER BY ep.joined_at`, eventID)
	if err != nil {
		httpx.Internal(c, "could not load participants")
		return
	}
	participants := make([]eventUser, 0)
	for prows.Next() {
		var u eventUser
		if err := prows.Scan(&u.ID, &u.Name, &u.RSVP); err != nil {
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
		"event_id":     eventID,
		"code":         code,
		"host_id":      hostID,
		"title":        title,
		"description":  deref(description),
		"meet_at":      meetAt,
		"start_at":     startAt,
		"status":       status,
		"route_id":     resolvedRouteID,
		"route_points": routePoints,
		"start_lat":    startLat,
		"start_lon":    startLon,
		"start_name":   deref(startName),
		"end_lat":      endLat,
		"end_lon":      endLon,
		"end_name":     deref(endName),
		"participants": participants,
	})
}

// update lets the host edit the event's plan. Host only.
func (h *handler) update(c *gin.Context) {
	var req struct {
		Title       *string    `json:"title"`
		Description *string    `json:"description"`
		MeetAt      *time.Time `json:"meet_at"`
		StartAt     *time.Time `json:"start_at"`
		RouteID     *int64     `json:"route_id"`
		StartLat    *float64   `json:"start_lat"`
		StartLon    *float64   `json:"start_lon"`
		StartName   *string    `json:"start_name"`
		EndLat      *float64   `json:"end_lat"`
		EndLon      *float64   `json:"end_lon"`
		EndName     *string    `json:"end_name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	eventID, ok := h.hostOnly(c, c.Param("code"))
	if !ok {
		return
	}
	// Common scalar fields: COALESCE keeps existing values for omitted fields.
	if _, err := h.d.DB.Exec(c,
		`UPDATE events SET
		    title       = COALESCE($2, title),
		    description = COALESCE($3, description),
		    meet_at     = COALESCE($4, meet_at),
		    start_at    = COALESCE($5, start_at)
		 WHERE id = $1`,
		eventID, req.Title, req.Description, req.MeetAt, req.StartAt); err != nil {
		httpx.Internal(c, "could not update event")
		return
	}

	// A route and free-form locations are mutually exclusive, just like on
	// create. Setting one clears the other so a stale plan can never linger
	// (e.g. switching to manual points must not leave the old route attached).
	var err error
	switch {
	case req.RouteID != nil:
		_, err = h.d.DB.Exec(c,
			`UPDATE events SET route_id = $2,
			    start_lat = NULL, start_lon = NULL, start_name = NULL,
			    end_lat = NULL, end_lon = NULL, end_name = NULL
			 WHERE id = $1`, eventID, *req.RouteID)
	case req.StartLat != nil && req.StartLon != nil:
		_, err = h.d.DB.Exec(c,
			`UPDATE events SET route_id = NULL,
			    start_lat = $2, start_lon = $3, start_name = $4,
			    end_lat = $5, end_lon = $6, end_name = $7
			 WHERE id = $1`, eventID, req.StartLat, req.StartLon, req.StartName,
			req.EndLat, req.EndLon, req.EndName)
	}
	if err != nil {
		httpx.Internal(c, "could not update event")
		return
	}
	c.Status(http.StatusNoContent)
}

type rsvpReq struct {
	RSVP string `json:"rsvp" binding:"required,oneof=going maybe declined"`
}

// rsvp records (or updates) the caller's attendance. Anyone with the code may
// RSVP; this is also how a person joins an event.
func (h *handler) rsvp(c *gin.Context) {
	var req rsvpReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	me := authpkg.UserID(c)

	var eventID int64
	var status string
	err := h.d.DB.QueryRow(c,
		`SELECT id, status FROM events WHERE code = $1`, c.Param("code")).Scan(&eventID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "event not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load event")
		return
	}
	if status != "scheduled" {
		httpx.Error(c, http.StatusConflict, "event is no longer open")
		return
	}

	if _, err := h.d.DB.Exec(c,
		`INSERT INTO event_participants (event_id, user_id, rsvp) VALUES ($1, $2, $3)
		 ON CONFLICT (event_id, user_id) DO UPDATE SET rsvp = EXCLUDED.rsvp`,
		eventID, me, req.RSVP); err != nil {
		httpx.Internal(c, "could not save rsvp")
		return
	}
	c.JSON(http.StatusOK, gin.H{"event_id": eventID, "rsvp": req.RSVP})
}

// cancel marks an event cancelled. Host only.
func (h *handler) cancel(c *gin.Context) {
	var eventID int64
	err := h.d.DB.QueryRow(c,
		`UPDATE events SET status = 'cancelled'
		 WHERE code = $1 AND host_id = $2 AND status = 'scheduled' RETURNING id`,
		c.Param("code"), authpkg.UserID(c)).Scan(&eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "scheduled event not found for host")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not cancel event")
		return
	}
	c.Status(http.StatusNoContent)
}

// hostOnly loads the event by code and verifies the caller is its host,
// returning the event id. It writes the error response and returns ok=false
// otherwise.
func (h *handler) hostOnly(c *gin.Context, code string) (int64, bool) {
	var eventID, hostID int64
	err := h.d.DB.QueryRow(c, `SELECT id, host_id FROM events WHERE code = $1`, code).Scan(&eventID, &hostID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "event not found")
		return 0, false
	}
	if err != nil {
		httpx.Internal(c, "could not load event")
		return 0, false
	}
	if authpkg.UserID(c) != hostID {
		httpx.Error(c, http.StatusForbidden, "only the host can do this")
		return 0, false
	}
	return eventID, true
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
