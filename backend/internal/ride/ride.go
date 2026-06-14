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
	g.GET("/:id", h.get)
}

type handler struct {
	d    *server.Deps
	nats *nats.Conn
}

// Ride is the API representation of a recorded trip.
type Ride struct {
	ID            int64      `json:"id"`
	UserID        int64      `json:"user_id"`
	RouteID       *int64     `json:"route_id"`
	StartTime     *time.Time `json:"start_time"`
	EndTime       *time.Time `json:"end_time"`
	Distance      float64    `json:"distance"`
	AvgSpeed      float64    `json:"avg_speed"`
	ElevationGain float64    `json:"elevation_gain"`
}

type createReq struct {
	RouteID       *int64     `json:"route_id"`
	StartTime     *time.Time `json:"start_time"`
	EndTime       *time.Time `json:"end_time"`
	Distance      float64    `json:"distance" binding:"gte=0"`
	AvgSpeed      float64    `json:"avg_speed"`
	ElevationGain float64    `json:"elevation_gain"`
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
		`INSERT INTO rides (user_id, route_id, start_time, end_time, distance, avg_speed, elevation_gain)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id, user_id, route_id, start_time, end_time, distance, avg_speed, elevation_gain`,
		userID, req.RouteID, req.StartTime, req.EndTime, req.Distance, req.AvgSpeed, req.ElevationGain,
	).Scan(&r.ID, &r.UserID, &r.RouteID, &r.StartTime, &r.EndTime, &r.Distance, &r.AvgSpeed, &r.ElevationGain)
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
		`SELECT id, user_id, route_id, start_time, end_time, distance, avg_speed, elevation_gain
		 FROM rides WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, userID)
	if err != nil {
		httpx.Internal(c, "could not list rides")
		return
	}
	defer rows.Close()

	rides := make([]Ride, 0)
	for rows.Next() {
		var r Ride
		if err := rows.Scan(&r.ID, &r.UserID, &r.RouteID, &r.StartTime, &r.EndTime, &r.Distance, &r.AvgSpeed, &r.ElevationGain); err != nil {
			httpx.Internal(c, "could not read rides")
			return
		}
		rides = append(rides, r)
	}
	c.JSON(http.StatusOK, gin.H{"rides": rides})
}

func (h *handler) get(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid ride id")
		return
	}
	var r Ride
	err = h.d.DB.QueryRow(c,
		`SELECT id, user_id, route_id, start_time, end_time, distance, avg_speed, elevation_gain
		 FROM rides WHERE id = $1 AND user_id = $2`, id, authpkg.UserID(c),
	).Scan(&r.ID, &r.UserID, &r.RouteID, &r.StartTime, &r.EndTime, &r.Distance, &r.AvgSpeed, &r.ElevationGain)
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

// AvgSpeed returns the average speed in km/h for a distance in km over a
// duration. It returns 0 when the duration is non-positive.
func AvgSpeed(distanceKm float64, dur time.Duration) float64 {
	hours := dur.Hours()
	if hours <= 0 {
		return 0
	}
	return distanceKm / hours
}
