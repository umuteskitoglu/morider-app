// Package server wires the common pieces every Morider service shares:
// a configured Gin engine, a database pool, a JWT manager and graceful startup.
package server

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"golang.org/x/time/rate"

	"github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/db"
	"github.com/morider/backend/pkg/httpx"
	"github.com/morider/backend/pkg/logger"
	"github.com/morider/backend/pkg/metrics"
	"github.com/morider/backend/pkg/ratelimit"
)

// Timeouts for the HTTP server. WriteTimeout is deliberately NOT set: it also
// applies to hijacked WebSocket connections and would sever long-lived group
// ride sockets mid-ride. Per-request body size is bounded by bodyLimit instead,
// and per-frame write deadlines are handled by the WebSocket write pump.
const (
	readHeaderTimeout = 10 * time.Second
	idleTimeout       = 120 * time.Second
	maxHeaderBytes    = 1 << 16
	shutdownGrace     = 30 * time.Second
)

// Deps bundles everything a service handler needs.
type Deps struct {
	Cfg    config.Config
	Log    zerolog.Logger
	DB     *pgxpool.Pool
	JWT    *auth.Manager
	Engine *gin.Engine

	// closers run during shutdown, after HTTP draining has been requested but
	// before the database pool is released. WebSocket hubs register here so
	// hijacked connections are torn down instead of hanging until their read
	// deadline expires (http.Server.Shutdown does not track hijacked conns).
	closers []func()
}

// New builds a service with a database connection.
func New(ctx context.Context, name string, cfg config.Config) (*Deps, error) {
	log := logger.New(name)
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	return assemble(name, cfg, log, pool)
}

// NewWithoutDB builds a service that does not need a database (e.g. the gateway).
func NewWithoutDB(name string, cfg config.Config) (*Deps, error) {
	return assemble(name, cfg, logger.New(name), nil)
}

// AddCloser registers a shutdown hook. Hooks must be registered during startup
// (before Run) and are invoked once, in registration order.
func (d *Deps) AddCloser(fn func()) { d.closers = append(d.closers, fn) }

func assemble(name string, cfg config.Config, log zerolog.Logger, pool *pgxpool.Pool) (*Deps, error) {
	gin.SetMode(gin.ReleaseMode)
	engine := gin.New()

	// Make c.Done()/c.Err() defer to the request context so pgx cancels
	// in-flight queries when a client disconnects. Without this Gin returns a
	// context that never cancels and abandoned queries keep occupying pool
	// connections.
	engine.ContextWithFallback = true

	// Gin trusts every peer by default, which makes X-Forwarded-For (and
	// therefore ClientIP, and therefore the rate limiter) client-controlled.
	if err := engine.SetTrustedProxies(cfg.TrustedProxies); err != nil {
		return nil, fmt.Errorf("trusted proxies: %w", err)
	}

	m := metrics.New(name)
	engine.Use(gin.Recovery())
	engine.Use(m.Middleware())
	engine.Use(requestLogger(log))
	engine.Use(bodyLimit(cfg.MaxBodyBytes))

	// Probes are registered before the rate limiter so a traffic burst cannot
	// return 429 to Kubernetes and get a healthy pod killed.
	m.Expose(engine)
	httpx.Health(engine, name)
	httpx.Ready(engine, name, pool)

	// Everything registered after this point is rate limited.
	engine.Use(ratelimit.Middleware(rate.Limit(cfg.RateLimitRPS), cfg.RateLimitBurst))

	return &Deps{
		Cfg:    cfg,
		Log:    log,
		DB:     pool,
		JWT:    auth.NewManager(cfg.JWTSecret, cfg.JWTTTL),
		Engine: engine,
	}, nil
}

// bodyLimit caps request bodies so a single client cannot force the process to
// buffer an unbounded payload. WebSocket upgrades are exempt: their connection
// is hijacked and framed reads are bounded by SetReadLimit instead.
func bodyLimit(max int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if max > 0 && !websocket.IsWebSocketUpgrade(c.Request) {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, max)
		}
		c.Next()
	}
}

// Run starts the HTTP server and blocks until an interrupt signal is received.
func (d *Deps) Run(port string) error {
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           d.Engine,
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
	}

	serveErr := make(chan error, 1)
	go func() {
		d.Log.Info().Str("port", port).Msg("service listening")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			serveErr <- err
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	// A startup failure (e.g. port already bound) must surface immediately
	// rather than leaving the process blocked on a signal that never comes.
	select {
	case err := <-serveErr:
		return fmt.Errorf("listen on %s: %w", port, err)
	case <-quit:
	}

	d.Log.Info().Msg("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()

	// Close hijacked WebSocket connections so their handlers return and
	// Shutdown can complete.
	for _, fn := range d.closers {
		fn()
	}

	// Drain HTTP first: no handler can still need the pool once Shutdown
	// returns, so the pool is only released afterwards. Closing it first would
	// fail every in-flight request with "closed pool".
	err := srv.Shutdown(ctx)
	if d.DB != nil {
		d.DB.Close()
	}
	return err
}

func requestLogger(log zerolog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		// URL.Path only, never RawQuery: WebSocket auth passes a token there.
		log.Info().
			Str("method", c.Request.Method).
			Str("path", c.Request.URL.Path).
			Int("status", c.Writer.Status()).
			Dur("latency", time.Since(start)).
			Msg("request")
	}
}
