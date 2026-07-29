// Package telemetry ingests live GPS samples over WebSocket and batch REST,
// persists them to PostGIS and fans them out over NATS.
package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
	"golang.org/x/time/rate"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/events"
	"github.com/morider/backend/pkg/httpx"
	"github.com/morider/backend/pkg/push"
	"github.com/morider/backend/pkg/wshub"
)

// Run boots the telemetry service.
func Run(cfg config.Config) error {
	deps, err := server.New(context.Background(), "telemetry", cfg)
	if err != nil {
		return err
	}
	upgrader = websocket.Upgrader{CheckOrigin: wshub.OriginChecker(cfg.AllowedWSOrigins)}

	h := &handler{d: deps, push: push.ExpoSender{}}

	// Push sender: FCM when a service-account file is configured, else Expo relay.
	if cfg.FCMCredentialsFile != "" {
		if sa, err := os.ReadFile(cfg.FCMCredentialsFile); err != nil {
			deps.Log.Warn().Err(err).Msg("could not read FCM credentials, falling back to Expo push")
		} else if sender, err := push.NewFCMSender(sa); err != nil {
			deps.Log.Warn().Err(err).Msg("invalid FCM credentials, falling back to Expo push")
		} else {
			h.push = sender
			deps.Log.Info().Msg("push: using FCM HTTP v1")
		}
	}

	// NATS is optional: if it is unavailable the service still records points.
	if nc, err := nats.Connect(cfg.NATSURL, nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1)); err != nil {
		deps.Log.Warn().Err(err).Msg("nats unavailable, continuing without fan-out")
	} else {
		h.nats = nc
	}
	h.hub = wshub.New(h.nats, events.SubjectSessionPositions, events.SubjectSessionDisconnect)
	// Tear down live sockets on shutdown; http.Server.Shutdown does not track
	// hijacked connections.
	deps.AddCloser(h.hub.CloseAll)

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
	s.GET("", jwt, h.myActiveSessions)
	s.GET("/:code", jwt, h.getSession)
	s.POST("/:code/join", jwt, h.joinSession)
	s.POST("/:code/leave", jwt, h.leaveSession)
	s.POST("/:code/end", jwt, h.endSession)
	s.POST("/:code/kick", jwt, h.kickParticipant)
	s.POST("/:code/ban", jwt, h.banParticipant)
	s.POST("/:code/transfer", jwt, h.transferHost)
	s.POST("/:code/voice-token", jwt, h.voiceToken)
	s.GET("/:code/ws", h.sessionWS)

	// Emergency alerts. REST rather than the session socket so a solo rider is
	// covered too, and so the client can retry it once signal returns.
	sos := d.Engine.Group("/api/sos", jwt)
	sos.POST("", h.raiseSOS)
	sos.POST("/:id/resolve", h.resolveSOS)

	// Ambient "active riders" presence layer (REST polling, not a WS room).
	p := d.Engine.Group("/api/presence", jwt)
	p.POST("/heartbeat", h.heartbeat)
	p.POST("/offline", h.offline)
	p.GET("/nearby", h.nearby)
}

type handler struct {
	d    *server.Deps
	nats *nats.Conn
	hub  *wshub.Hub
	// Used to reach riders whose app is backgrounded — the audience an SOS
	// most needs and the session WebSocket cannot serve.
	push push.Sender
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

// maxBatchPoints bounds one upload. At 1 Hz this is ~16 minutes of recording,
// comfortably more than a client buffers across a signal gap, while keeping the
// worst-case request bounded.
const maxBatchPoints = 1000

type batchReq struct {
	Points []Point `json:"points" binding:"required,min=1,max=1000"`
}

// validate rejects samples that are structurally impossible. Without this a
// client can broadcast lat=9999 (or leave a marker at 0,0 with no GPS fix) and
// every other rider's map follows it.
func (p Point) validate() error {
	switch {
	case p.RideID <= 0:
		return errors.New("ride_id is required")
	case math.IsNaN(p.Lat) || math.IsNaN(p.Lon) || math.IsInf(p.Lat, 0) || math.IsInf(p.Lon, 0):
		return errors.New("lat/lon must be finite")
	case p.Lat < -90 || p.Lat > 90:
		return errors.New("lat out of range")
	case p.Lon < -180 || p.Lon > 180:
		return errors.New("lon out of range")
	case math.IsNaN(p.Speed) || math.IsInf(p.Speed, 0) || p.Speed < 0 || p.Speed > maxPlausibleSpeed:
		return errors.New("speed out of range")
	}
	return nil
}

// maxPlausibleSpeed (m/s) is well past any production motorcycle; anything
// beyond it is a bad sensor reading or a forged sample.
const maxPlausibleSpeed = 150

func (h *handler) batch(c *gin.Context) {
	var req batchReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}

	userID := authpkg.UserID(c)
	ownership := newOwnershipCache()
	// Reject the whole batch if any point is malformed or references a ride the
	// caller does not own — a partially-applied batch the client cannot
	// reconcile is worse than a clean rejection it can retry.
	for i, p := range req.Points {
		if err := p.validate(); err != nil {
			httpx.BadRequest(c, fmt.Sprintf("points[%d]: %v", i, err))
			return
		}
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

	saved, err := h.saveBatch(c, req.Points)
	if err != nil {
		h.d.Log.Error().Err(err).Int("points", len(req.Points)).Msg("failed to save telemetry batch")
		httpx.Internal(c, "could not save points")
		return
	}
	for _, p := range req.Points {
		h.publish(p)
	}
	c.JSON(http.StatusAccepted, gin.H{"saved": saved})
}

// saveBatch inserts every point in a single round-trip.
//
// This used to be one INSERT per point in a Go loop: at 1 Hz per rider that
// serialised the platform's hottest write path through a handful of pool
// connections, starving every other query in the service.
//
// unnest is used rather than pgx.CopyFrom because geom is derived in SQL
// (ST_MakePoint) and COPY can only ship literal column values — CopyFrom would
// additionally require a trigger or a generated column. unnest keeps it to one
// round-trip with no schema change, which is the bulk of the win.
func (h *handler) saveBatch(ctx context.Context, points []Point) (int64, error) {
	n := len(points)
	var (
		rideIDs = make([]int64, n)
		stamps  = make([]time.Time, n)
		lats    = make([]float64, n)
		lons    = make([]float64, n)
		alts    = make([]float64, n)
		speeds  = make([]float64, n)
	)
	now := time.Now()
	for i, p := range points {
		if p.Ts.IsZero() {
			p.Ts = now
		}
		rideIDs[i], stamps[i] = p.RideID, p.Ts
		lats[i], lons[i] = p.Lat, p.Lon
		alts[i], speeds[i] = p.Altitude, p.Speed
	}

	tag, err := h.d.DB.Exec(ctx,
		`INSERT INTO telemetry_points (ride_id, ts, lat, lon, altitude, speed, geom)
		 SELECT t.ride_id, t.ts, t.lat, t.lon, t.altitude, t.speed,
		        ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography
		 FROM unnest($1::bigint[], $2::timestamptz[], $3::float8[],
		             $4::float8[], $5::float8[], $6::float8[])
		      AS t(ride_id, ts, lat, lon, altitude, speed)`,
		rideIDs, stamps, lats, lons, alts, speeds)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ownershipCache memoises ride-ownership lookups for one request or one
// connection. Entries expire so a revoked ride is re-checked, and the cache is
// bounded so a client streaming distinct ride ids cannot grow it without limit.
//
// Not safe for concurrent use: each instance belongs to a single request
// handler or a single WebSocket read loop.
type ownershipCache struct {
	entries map[int64]ownershipEntry
}

type ownershipEntry struct {
	owned     bool
	checkedAt time.Time
}

const (
	ownershipTTL     = 2 * time.Minute
	ownershipMaxSize = 64
)

func newOwnershipCache() *ownershipCache {
	return &ownershipCache{entries: make(map[int64]ownershipEntry)}
}

// ownsRide reports whether rideID belongs to userID, caching results so a batch
// or websocket session only hits the database once per distinct ride.
func (h *handler) ownsRide(ctx context.Context, cache *ownershipCache, userID, rideID int64) (bool, error) {
	if e, ok := cache.entries[rideID]; ok && time.Since(e.checkedAt) < ownershipTTL {
		return e.owned, nil
	}
	var owned bool
	err := h.d.DB.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM rides WHERE id = $1 AND user_id = $2)`,
		rideID, userID).Scan(&owned)
	if err != nil {
		return false, err
	}
	// A single ride per connection is the norm; hitting the cap means the client
	// is cycling ids, so drop everything rather than grow.
	if len(cache.entries) >= ownershipMaxSize {
		cache.entries = make(map[int64]ownershipEntry, ownershipMaxSize)
	}
	cache.entries[rideID] = ownershipEntry{owned: owned, checkedAt: time.Now()}
	return owned, nil
}

// upgrader is built in Run once the config is known, so the Origin allow-list
// can come from the environment.
var upgrader websocket.Upgrader

// maxPointFrame bounds a single inbound telemetry frame. A GPS sample is ~200
// bytes; 4 KiB is generous and stops a client streaming an unbounded frame.
const maxPointFrame = 4 << 10

// ingestRate is the per-connection ceiling on inbound samples. The client
// records at 1 Hz, so 5/s absorbs bursts after a signal gap while stopping a
// runaway or hostile client from saturating the write path.
const ingestRate = 5

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

	wshub.ConfigureReader(conn, maxPointFrame)

	// This endpoint replies per frame rather than broadcasting, so it drives the
	// write pump through a client with no hub membership — that still gives it
	// keepalive pings and bounded writes.
	client := wshub.NewClient(claims.UserID, wshub.DefaultSendBuffer)
	defer client.Close()
	client.CloseOnDone(conn)
	go client.WritePump(conn)

	userID := claims.UserID
	ownership := newOwnershipCache()
	limiter := rate.NewLimiter(ingestRate, ingestRate*2)

	for {
		var p Point
		if err := conn.ReadJSON(&p); err != nil {
			return
		}
		if !limiter.Allow() {
			continue // silently shed; the client retries from its own buffer
		}
		if err := p.validate(); err != nil {
			client.SendJSON(gin.H{"status": "rejected", "ride_id": p.RideID, "reason": err.Error()})
			continue
		}
		if p.Ts.IsZero() {
			p.Ts = time.Now()
		}
		owned, err := h.ownsRide(c, ownership, userID, p.RideID)
		if err != nil || !owned {
			client.SendJSON(gin.H{"status": "rejected", "ride_id": p.RideID})
			continue
		}
		if err := h.save(c, p); err != nil {
			h.d.Log.Error().Err(err).Msg("failed to save telemetry point")
			client.SendJSON(gin.H{"status": "error", "ride_id": p.RideID})
			continue
		}
		client.SendJSON(gin.H{"status": "ok", "ride_id": p.RideID})
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
