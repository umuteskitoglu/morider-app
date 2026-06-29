// Package ride implements the ride (recorded trip) service.
package ride

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/events"
	"github.com/morider/backend/pkg/httpx"
)

// Run boots the ride service.
func Run(cfg config.Config) error {
	deps, err := server.New(context.Background(), "ride", cfg)
	if err != nil {
		return err
	}
	h := &handler{d: deps}

	// NATS is optional: rides are still recorded without it, only the
	// ride.completed event (which drives reward badges) is skipped.
	if nc, err := nats.Connect(cfg.NATSURL, nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1)); err != nil {
		deps.Log.Warn().Err(err).Msg("nats unavailable, ride events disabled")
	} else {
		h.nats = nc
	}

	registerRoutes(deps, h)
	registerGarageRoutes(deps, h)
	return deps.Run(config.ResolvePort("RIDE_PORT", "8083"))
}

func registerRoutes(d *server.Deps, h *handler) {
	g := d.Engine.Group("/api/rides", d.JWT.Middleware())
	g.POST("", h.create)
	g.GET("", h.list)
	g.GET("/recap", h.recap)
	g.GET("/:id", h.get)
	g.GET("/:id/track", h.track)
	g.PATCH("/:id", h.update)
	g.DELETE("/:id", h.remove)
}

// maxTrackPoints caps how many telemetry points a single track response returns
// so a very long ride can't dump an unbounded payload to the client.
const maxTrackPoints = 5000

type handler struct {
	d    *server.Deps
	nats *nats.Conn
}

// Ride is the API representation of a recorded trip.
type Ride struct {
	ID             int64      `json:"id"`
	UserID         int64      `json:"user_id"`
	RouteID        *int64     `json:"route_id"`
	StartTime      *time.Time `json:"start_time"`
	EndTime        *time.Time `json:"end_time"`
	Distance       float64    `json:"distance"`
	AvgSpeed       float64    `json:"avg_speed"`
	ElevationGain  float64    `json:"elevation_gain"`
	Title          *string    `json:"title"`
	Notes          *string    `json:"notes"`
	MotorcycleID   *int64     `json:"motorcycle_id"`
	MotorcycleName *string    `json:"motorcycle_name"`
	MaxLeanRight   *float64   `json:"max_lean_right"`
	MaxLeanLeft    *float64   `json:"max_lean_left"`
}

type createReq struct {
	RouteID       *int64     `json:"route_id"`
	StartTime     *time.Time `json:"start_time"`
	EndTime       *time.Time `json:"end_time"`
	Distance      float64    `json:"distance" binding:"gte=0"`
	AvgSpeed      float64    `json:"avg_speed"`
	ElevationGain float64    `json:"elevation_gain"`
	MotorcycleID  *int64     `json:"motorcycle_id"`
	MaxLeanRight  *float64   `json:"max_lean_right"`
	MaxLeanLeft   *float64   `json:"max_lean_left"`
}

func (h *handler) create(c *gin.Context) {
	var req createReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}

	// Derive average speed from distance/duration when not supplied explicitly.
	if req.AvgSpeed == 0 && req.StartTime != nil && req.EndTime != nil {
		req.AvgSpeed = AvgSpeed(req.Distance, req.EndTime.Sub(*req.StartTime))
	}

	userID := authpkg.UserID(c)
	var r Ride
	err := h.d.DB.QueryRow(c,
		`INSERT INTO rides (user_id, route_id, start_time, end_time, distance, avg_speed, elevation_gain, motorcycle_id, max_lean_right, max_lean_left)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		 RETURNING id, user_id, route_id, start_time, end_time, distance, avg_speed, elevation_gain, title, notes, motorcycle_id, max_lean_right, max_lean_left`,
		userID, req.RouteID, req.StartTime, req.EndTime, req.Distance, req.AvgSpeed, req.ElevationGain, req.MotorcycleID, req.MaxLeanRight, req.MaxLeanLeft,
	).Scan(&r.ID, &r.UserID, &r.RouteID, &r.StartTime, &r.EndTime, &r.Distance, &r.AvgSpeed, &r.ElevationGain,
		&r.Title, &r.Notes, &r.MotorcycleID, &r.MaxLeanRight, &r.MaxLeanLeft)
	if err != nil {
		httpx.Internal(c, "could not create ride")
		return
	}
	h.publishCompleted(r)
	c.JSON(http.StatusCreated, r)
}

// publishCompleted emits a ride.completed event so the reward service can
// evaluate badge rules. Best-effort: a publish failure never fails the request.
func (h *handler) publishCompleted(r Ride) {
	if h.nats == nil {
		return
	}
	data, err := json.Marshal(events.RideCompleted{
		UserID:   r.UserID,
		RideID:   r.ID,
		Distance: r.Distance,
	})
	if err != nil {
		return
	}
	if err := h.nats.Publish(events.SubjectRideCompleted, data); err != nil {
		h.d.Log.Warn().Err(err).Int64("ride_id", r.ID).Msg("could not publish ride.completed")
	}
}

func (h *handler) list(c *gin.Context) {
	userID := authpkg.UserID(c)
	rows, err := h.d.DB.Query(c,
		`SELECT r.id, r.user_id, r.route_id, r.start_time, r.end_time, r.distance, r.avg_speed, r.elevation_gain,
		        r.title, r.notes, r.motorcycle_id, m.name, r.max_lean_right, r.max_lean_left
		 FROM rides r LEFT JOIN motorcycles m ON m.id = r.motorcycle_id
		 WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 100`, userID)
	if err != nil {
		httpx.Internal(c, "could not list rides")
		return
	}
	defer rows.Close()

	rides := make([]Ride, 0)
	for rows.Next() {
		var r Ride
		if err := rows.Scan(&r.ID, &r.UserID, &r.RouteID, &r.StartTime, &r.EndTime, &r.Distance, &r.AvgSpeed, &r.ElevationGain,
			&r.Title, &r.Notes, &r.MotorcycleID, &r.MotorcycleName, &r.MaxLeanRight, &r.MaxLeanLeft); err != nil {
			httpx.Internal(c, "could not read rides")
			return
		}
		rides = append(rides, r)
	}
	c.JSON(http.StatusOK, gin.H{"rides": rides})
}

// recapStat aggregates a single ISO week of the caller's rides.
type recapStat struct {
	WeekStart       time.Time `json:"week_start"`
	Distance        float64   `json:"distance"`
	DurationSeconds float64   `json:"duration_seconds"`
	AvgSpeed        float64   `json:"avg_speed"`
	RideCount       int64     `json:"ride_count"`
}

// recap returns the caller's current-week ride summary alongside the previous
// week so the client can show week-over-week change. Weeks are ISO (Mon-start)
// in the server timezone, matching date_trunc('week', ...).
func (h *handler) recap(c *gin.Context) {
	// is_current is computed in SQL so the bucketing matches date_trunc exactly,
	// regardless of how the server and DB timezones line up.
	rows, err := h.d.DB.Query(c,
		`SELECT date_trunc('week', start_time) = date_trunc('week', now()) AS is_current,
		        COALESCE(SUM(distance), 0) AS dist,
		        COALESCE(SUM(EXTRACT(EPOCH FROM (end_time - start_time))), 0) AS dur,
		        COUNT(*) AS rides
		 FROM rides
		 WHERE user_id = $1 AND start_time IS NOT NULL
		   AND start_time >= date_trunc('week', now()) - interval '1 week'
		 GROUP BY is_current`, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not load recap")
		return
	}
	defer rows.Close()

	thisWeek := truncWeek(time.Now())
	week := recapStat{WeekStart: thisWeek}
	prev := recapStat{WeekStart: thisWeek.AddDate(0, 0, -7)}
	for rows.Next() {
		var isCurrent bool
		var s recapStat
		if err := rows.Scan(&isCurrent, &s.Distance, &s.DurationSeconds, &s.RideCount); err != nil {
			httpx.Internal(c, "could not read recap")
			return
		}
		s.AvgSpeed = AvgSpeed(s.Distance, time.Duration(s.DurationSeconds*float64(time.Second)))
		if isCurrent {
			s.WeekStart = week.WeekStart
			week = s
		} else {
			s.WeekStart = prev.WeekStart
			prev = s
		}
	}
	c.JSON(http.StatusOK, gin.H{"week": week, "prev_week": prev})
}

// truncWeek returns Monday 00:00 of t's ISO week (local tz), mirroring Postgres
// date_trunc('week', ...) so the WeekStart label lines up with the SQL bucket.
func truncWeek(t time.Time) time.Time {
	t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	offset := (int(t.Weekday()) + 6) % 7 // Go Sun=0..Sat=6; ISO week starts Mon.
	return t.AddDate(0, 0, -offset)
}

func (h *handler) get(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid ride id")
		return
	}
	var r Ride
	err = h.d.DB.QueryRow(c,
		`SELECT r.id, r.user_id, r.route_id, r.start_time, r.end_time, r.distance, r.avg_speed, r.elevation_gain,
		        r.title, r.notes, r.motorcycle_id, m.name, r.max_lean_right, r.max_lean_left
		 FROM rides r LEFT JOIN motorcycles m ON m.id = r.motorcycle_id
		 WHERE r.id = $1 AND r.user_id = $2`, id, authpkg.UserID(c),
	).Scan(&r.ID, &r.UserID, &r.RouteID, &r.StartTime, &r.EndTime, &r.Distance, &r.AvgSpeed, &r.ElevationGain,
		&r.Title, &r.Notes, &r.MotorcycleID, &r.MotorcycleName, &r.MaxLeanRight, &r.MaxLeanLeft)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "ride not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load ride")
		return
	}
	c.JSON(http.StatusOK, r)
}

// TrackPoint is one recorded GPS fix of a ride, returned in chronological order
// so the client can redraw the path, charts and stats.
type TrackPoint struct {
	Lat      float64   `json:"lat"`
	Lon      float64   `json:"lon"`
	Altitude float64   `json:"altitude"` // meters
	Speed    float64   `json:"speed"`    // m/s, as uploaded by the client
	Ts       time.Time `json:"ts"`
}

// track returns the telemetry trail of one of the caller's rides. Ownership is
// checked against the rides table first so a rider can't read another user's
// track by id. telemetry_points lives in the same database as rides.
func (h *handler) track(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid ride id")
		return
	}
	var exists bool
	err = h.d.DB.QueryRow(c,
		`SELECT EXISTS (SELECT 1 FROM rides WHERE id = $1 AND user_id = $2)`,
		id, authpkg.UserID(c)).Scan(&exists)
	if err != nil {
		httpx.Internal(c, "could not load ride")
		return
	}
	if !exists {
		httpx.Error(c, http.StatusNotFound, "ride not found")
		return
	}

	rows, err := h.d.DB.Query(c,
		`SELECT lat, lon, COALESCE(altitude, 0), COALESCE(speed, 0), ts
		 FROM telemetry_points WHERE ride_id = $1 ORDER BY ts ASC LIMIT $2`,
		id, maxTrackPoints)
	if err != nil {
		httpx.Internal(c, "could not load track")
		return
	}
	defer rows.Close()

	points := make([]TrackPoint, 0)
	for rows.Next() {
		var p TrackPoint
		if err := rows.Scan(&p.Lat, &p.Lon, &p.Altitude, &p.Speed, &p.Ts); err != nil {
			httpx.Internal(c, "could not read track")
			return
		}
		points = append(points, p)
	}
	c.JSON(http.StatusOK, gin.H{"points": points})
}

type updateReq struct {
	Title        *string `json:"title"`
	Notes        *string `json:"notes"`
	MotorcycleID *int64  `json:"motorcycle_id"`
}

// update edits the caller's ride title/notes and the linked motorcycle. All
// fields are optional; COALESCE keeps the existing value when a field is null,
// except motorcycle_id which is set directly so it can be cleared with null.
func (h *handler) update(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid ride id")
		return
	}
	var req updateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	var r Ride
	err = h.d.DB.QueryRow(c,
		`UPDATE rides SET title = COALESCE($1, title), notes = COALESCE($2, notes), motorcycle_id = $3
		 WHERE id = $4 AND user_id = $5
		 RETURNING id, user_id, route_id, start_time, end_time, distance, avg_speed, elevation_gain,
		           title, notes, motorcycle_id, max_lean_right, max_lean_left`,
		req.Title, req.Notes, req.MotorcycleID, id, authpkg.UserID(c),
	).Scan(&r.ID, &r.UserID, &r.RouteID, &r.StartTime, &r.EndTime, &r.Distance, &r.AvgSpeed, &r.ElevationGain,
		&r.Title, &r.Notes, &r.MotorcycleID, &r.MaxLeanRight, &r.MaxLeanLeft)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "ride not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not update ride")
		return
	}
	c.JSON(http.StatusOK, r)
}

// remove deletes one of the caller's rides; telemetry_points cascade away.
func (h *handler) remove(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid ride id")
		return
	}
	tag, err := h.d.DB.Exec(c, `DELETE FROM rides WHERE id = $1 AND user_id = $2`, id, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not delete ride")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "ride not found")
		return
	}
	c.Status(http.StatusNoContent)
}

// AvgSpeed returns the average speed in km/h for a distance in km over a
// duration. It returns 0 when the duration is non-positive.
func AvgSpeed(distanceKm float64, dur time.Duration) float64 {
	hours := dur.Hours()
	if hours <= 0 {
		return 0
	}
	return distanceKm / hours
}
