// Package telemetry ingests live GPS samples over WebSocket and batch REST,
// persists them to PostGIS and fans them out over NATS.
package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/httpx"
)

// Run boots the telemetry service.
func Run(cfg config.Config) error {
	deps, err := server.New(context.Background(), "telemetry", cfg)
	if err != nil {
		return err
	}
	h := &handler{d: deps}

	// NATS is optional: if it is unavailable the service still records points.
	if nc, err := nats.Connect(cfg.NATSURL, nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1)); err != nil {
		deps.Log.Warn().Err(err).Msg("nats unavailable, continuing without fan-out")
	} else {
		h.nats = nc
	}
	h.hub = newSessionHub(h.nats)

	registerRoutes(deps, h)
	return deps.Run(config.ResolvePort("TELEMETRY_PORT", "8086"))
}

func registerRoutes(d *server.Deps, h *handler) {
	g := d.Engine.Group("/api/telemetry")
	// Bearer token in Authorization header for the REST batch endpoint.
	g.POST("", d.JWT.Middleware(), h.batch)
	// WebSocket auth uses ?token= because browsers cannot set custom headers.
	g.GET("/ws", h.ws)

	// Live group ride sessions. REST endpoints use the bearer header; the
	// WebSocket uses ?token= (browsers cannot set custom headers), so JWT is
	// applied per-route rather than on the whole group.
	s := d.Engine.Group("/api/sessions")
	jwt := d.JWT.Middleware()
	s.POST("", jwt, h.createSession)
	s.GET("/:code", jwt, h.getSession)
	s.POST("/:code/join", jwt, h.joinSession)
	s.POST("/:code/leave", jwt, h.leaveSession)
	s.POST("/:code/end", jwt, h.endSession)
	s.GET("/:code/ws", h.sessionWS)
}

type handler struct {
	d    *server.Deps
	nats *nats.Conn
	hub  *sessionHub
}

// Point is a single GPS sample.
type Point struct {
	RideID   int64     `json:"ride_id"`
	Lat      float64   `json:"lat"`
	Lon      float64   `json:"lon"`
	Altitude float64   `json:"altitude"`
	Speed    float64   `json:"speed"`
	Ts       time.Time `json:"ts"`
}

type batchReq struct {
	Points []Point `json:"points" binding:"required,min=1"`
}

func (h *handler) batch(c *gin.Context) {
	var req batchReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}

	userID := authpkg.UserID(c)
	ownership := map[int64]bool{}
	// Reject the whole batch if it references a ride the caller does not own.
	for _, p := range req.Points {
		owned, err := h.ownsRide(c, ownership, userID, p.RideID)
		if err != nil {
			httpx.Internal(c, "could not verify ride ownership")
			return
		}
		if !owned {
			httpx.Error(c, http.StatusForbidden, "ride does not belong to user")
			return
		}
	}

	saved := 0
	for _, p := range req.Points {
		if err := h.save(c, p); err != nil {
			h.d.Log.Error().Err(err).Msg("failed to save telemetry point")
			continue
		}
		saved++
	}
	c.JSON(http.StatusAccepted, gin.H{"saved": saved})
}

// ownsRide reports whether rideID belongs to userID, caching results so a batch
// or websocket session only hits the database once per distinct ride.
func (h *handler) ownsRide(ctx context.Context, cache map[int64]bool, userID, rideID int64) (bool, error) {
	if owned, seen := cache[rideID]; seen {
		return owned, nil
	}
	var owned bool
	err := h.d.DB.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM rides WHERE id = $1 AND user_id = $2)`,
		rideID, userID).Scan(&owned)
	if err != nil {
		return false, err
	}
	cache[rideID] = owned
	return owned, nil
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (h *handler) ws(c *gin.Context) {
	claims, err := h.d.JWT.Parse(c.Query("token"))
	if err != nil {
		httpx.Error(c, http.StatusUnauthorized, "invalid token")
		return
	}
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	userID := claims.UserID
	ownership := map[int64]bool{}
	for {
		var p Point
		if err := conn.ReadJSON(&p); err != nil {
			return
		}
		if p.Ts.IsZero() {
			p.Ts = time.Now()
		}
		owned, err := h.ownsRide(c, ownership, userID, p.RideID)
		if err != nil || !owned {
			_ = conn.WriteJSON(gin.H{"status": "rejected", "ride_id": p.RideID})
			continue
		}
		if err := h.save(c, p); err != nil {
			h.d.Log.Error().Err(err).Msg("failed to save telemetry point")
		}
		_ = conn.WriteJSON(gin.H{"status": "ok", "ride_id": p.RideID})
	}
}

func (h *handler) save(ctx context.Context, p Point) error {
	if p.Ts.IsZero() {
		p.Ts = time.Now()
	}
	_, err := h.d.DB.Exec(ctx,
		`INSERT INTO telemetry_points (ride_id, ts, lat, lon, altitude, speed, geom)
		 VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography)`,
		p.RideID, p.Ts, p.Lat, p.Lon, p.Altitude, p.Speed)
	if err != nil {
		return err
	}
	h.publish(p)
	return nil
}

func (h *handler) publish(p Point) {
	if h.nats == nil {
		return
	}
	if data, err := json.Marshal(p); err == nil {
		_ = h.nats.Publish("telemetry.points", data)
	}
}
