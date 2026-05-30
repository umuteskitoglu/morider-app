// Package server wires the common pieces every Morider service shares:
// a configured Gin engine, a database pool, a JWT manager and graceful startup.
package server

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
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

// Deps bundles everything a service handler needs.
type Deps struct {
	Cfg    config.Config
	Log    zerolog.Logger
	DB     *pgxpool.Pool
	JWT    *auth.Manager
	Engine *gin.Engine
}

// New builds a service with a database connection.
func New(ctx context.Context, name string, cfg config.Config) (*Deps, error) {
	log := logger.New(name)
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	return assemble(name, cfg, log, pool), nil
}

// NewWithoutDB builds a service that does not need a database (e.g. the gateway).
func NewWithoutDB(name string, cfg config.Config) *Deps {
	return assemble(name, cfg, logger.New(name), nil)
}

func assemble(name string, cfg config.Config, log zerolog.Logger, pool *pgxpool.Pool) *Deps {
	gin.SetMode(gin.ReleaseMode)
	engine := gin.New()
	m := metrics.New(name)
	engine.Use(gin.Recovery())
	engine.Use(m.Middleware())
	engine.Use(requestLogger(log))
	engine.Use(ratelimit.Middleware(rate.Limit(cfg.RateLimitRPS), cfg.RateLimitBurst))
	m.Expose(engine)
	httpx.Health(engine, name)

	return &Deps{
		Cfg:    cfg,
		Log:    log,
		DB:     pool,
		JWT:    auth.NewManager(cfg.JWTSecret, cfg.JWTTTL),
		Engine: engine,
	}
}

// Run starts the HTTP server and blocks until an interrupt signal is received.
func (d *Deps) Run(port string) error {
	srv := &http.Server{
		Addr:    ":" + port,
		Handler: d.Engine,
	}

	go func() {
		d.Log.Info().Str("port", port).Msg("service listening")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			d.Log.Fatal().Err(err).Msg("server failed")
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	d.Log.Info().Msg("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if d.DB != nil {
		d.DB.Close()
	}
	return srv.Shutdown(ctx)
}

func requestLogger(log zerolog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		log.Info().
			Str("method", c.Request.Method).
			Str("path", c.Request.URL.Path).
			Int("status", c.Writer.Status()).
			Dur("latency", time.Since(start)).
			Msg("request")
	}
}
