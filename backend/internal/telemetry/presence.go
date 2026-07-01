package telemetry

import (
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// Live "active riders" presence layer.
//
// Riders who opt in (users.share_live_location) periodically POST their position
// to /api/presence/heartbeat while the map is open. /api/presence/nearby returns
// everyone sharing within a radius whose heartbeat is recent. This is an ambient
// layer independent of group-ride sessions: it needs no room, so it is served by
// simple REST polling rather than the session WebSocket hub.

// presenceFreshWindow is how long a heartbeat keeps a rider "active" on the map.
// Clients heartbeat well inside this so a brief gap does not drop them; kept in
// sync with the interval literal in the nearby query.
const presenceFreshWindow = 90 * time.Second

// fuzzGrid is the grid (in degrees, ~500 m) that nearby positions are snapped to
// before being returned, so a rider's exact location is never exposed on the map.
// Exact coordinates are only shared deliberately via a direct message.
const fuzzGrid = 0.005

// defaultNearbyRadius and maxNearbyRadius bound the nearby search (meters).
const (
	defaultNearbyRadius = 25000.0
	maxNearbyRadius     = 100000.0
)

type heartbeatReq struct {
	Lat     float64 `json:"lat"`
	Lon     float64 `json:"lon"`
	Heading float64 `json:"heading"`
	Speed   float64 `json:"speed"`
}

// heartbeat records the caller's latest position for the active-riders map. If
// the caller has not opted into location sharing the row is removed instead, so
// toggling the setting off takes effect on the very next heartbeat.
func (h *handler) heartbeat(c *gin.Context) {
	var req heartbeatReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	me := authpkg.UserID(c)

	// Single round-trip: upsert the position only if the user opts into sharing.
	// A non-sharing user inserts no row (RETURNING yields none), which we treat as
	// inactive — the extra delete then only runs on that cold path.
	var active bool
	err := h.d.DB.QueryRow(c,
		`WITH me AS (SELECT share_live_location FROM users WHERE id = $1)
		 INSERT INTO rider_presence (user_id, lat, lon, geom, heading, speed, updated_at)
		 SELECT $1, $2, $3, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4, $5, now()
		 FROM me WHERE me.share_live_location
		 ON CONFLICT (user_id) DO UPDATE
		 SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, geom = EXCLUDED.geom,
		     heading = EXCLUDED.heading, speed = EXCLUDED.speed, updated_at = now()
		 RETURNING true`,
		me, req.Lat, req.Lon, req.Heading, req.Speed).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) {
		// Not sharing: make sure any stale row is gone, then report opted-out.
		_, _ = h.d.DB.Exec(c, `DELETE FROM rider_presence WHERE user_id = $1`, me)
		c.JSON(http.StatusOK, gin.H{"active": false})
		return
	}
	if err != nil {
		httpx.Internal(c, "could not save presence")
		return
	}
	c.JSON(http.StatusOK, gin.H{"active": active})
}

// offline drops the caller's presence row so they disappear from the map at once
// (e.g. when leaving the map screen or backgrounding the app).
func (h *handler) offline(c *gin.Context) {
	if _, err := h.d.DB.Exec(c, `DELETE FROM rider_presence WHERE user_id = $1`, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not clear presence")
		return
	}
	c.Status(http.StatusNoContent)
}

type nearbyRider struct {
	UserID    int64     `json:"user_id"`
	Name      string    `json:"name"`
	AvatarURL string    `json:"avatar_url"`
	Lat       float64   `json:"lat"`
	Lon       float64   `json:"lon"`
	Heading   float64   `json:"heading"`
	UpdatedAt time.Time `json:"updated_at"`
}

// nearby lists active riders sharing their location within radius of the given
// point. Returned coordinates are snapped to a coarse grid for privacy.
func (h *handler) nearby(c *gin.Context) {
	lat, err1 := strconv.ParseFloat(c.Query("lat"), 64)
	lon, err2 := strconv.ParseFloat(c.Query("lon"), 64)
	if err1 != nil || err2 != nil {
		httpx.BadRequest(c, "lat and lon are required")
		return
	}
	radius := defaultNearbyRadius
	if v, err := strconv.ParseFloat(c.Query("radius"), 64); err == nil && v > 0 {
		radius = math.Min(v, maxNearbyRadius)
	}

	rows, err := h.d.DB.Query(c,
		`SELECT p.user_id, u.name, COALESCE(u.avatar_url, ''), p.lat, p.lon, COALESCE(p.heading, 0), p.updated_at
		 FROM rider_presence p
		 JOIN users u ON u.id = p.user_id
		 WHERE u.share_live_location = true
		   AND p.user_id <> $1
		   -- Reciprocity: you only see other riders while you are sharing too.
		   AND EXISTS (SELECT 1 FROM users me WHERE me.id = $1 AND me.share_live_location)
		   AND p.updated_at > now() - interval '90 seconds'
		   AND ST_DWithin(p.geom, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4)
		 ORDER BY ST_Distance(p.geom, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography)
		 LIMIT 200`,
		authpkg.UserID(c), lat, lon, radius)
	if err != nil {
		httpx.Internal(c, "could not load nearby riders")
		return
	}
	defer rows.Close()

	riders := make([]nearbyRider, 0)
	for rows.Next() {
		var r nearbyRider
		if err := rows.Scan(&r.UserID, &r.Name, &r.AvatarURL, &r.Lat, &r.Lon, &r.Heading, &r.UpdatedAt); err != nil {
			httpx.Internal(c, "could not read nearby riders")
			return
		}
		r.Lat = snap(r.Lat)
		r.Lon = snap(r.Lon)
		riders = append(riders, r)
	}
	c.JSON(http.StatusOK, gin.H{"riders": riders})
}

// snap rounds a coordinate to the fuzz grid so exact positions are not exposed.
func snap(v float64) float64 {
	return math.Round(v/fuzzGrid) * fuzzGrid
}
