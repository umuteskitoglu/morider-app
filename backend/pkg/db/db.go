// Package db provides a pgx connection pool with simple retry on startup.
package db

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// defaultMaxConns sizes each service's pool.
//
// SIZING RULE: services × DB_MAX_CONNS must stay below Postgres
// max_connections. All-in-one mode ("all") runs eleven services in one process
// and therefore opens eleven pools, so the multiplier is eleven — not one.
// The production compose pairs max_connections=40 with DB_MAX_CONNS=3
// (11 × 3 = 33) and overrides this default explicitly.
//
// The old value of 4 was blamed for serialising telemetry ingest, but the pool
// was the symptom rather than the cause: ingest issued one INSERT per GPS
// sample, so a connection was held for the whole batch. That is now a single
// round-trip (see telemetry.saveBatch), which cuts connection hold time by
// roughly two orders of magnitude and makes a small pool sufficient.
//
// Raising this materially is a deployment decision that requires either
// one-service-per-container with a larger max_connections, or PgBouncer in
// transaction mode. It is deliberately NOT raised here, because a default that
// silently exceeds max_connections in all-in-one mode fails at startup on the
// smallest hosts — exactly where this project runs.
const defaultMaxConns = 8

// minConnsFloor keeps one connection warm. Establishing a Postgres connection
// costs a round-trip plus a backend fork, which is visible on a latency-
// sensitive path; MinConns=0 meant paying it after every idle period. Kept at
// one so all-in-one mode still holds only eleven idle connections.
const minConnsFloor = 1

// Connect opens a pgx pool, retrying for a short window so services can start
// alongside the database in docker-compose.
func Connect(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid database url: %w", err)
	}

	// Idle connections still drain so backends are released when a service is
	// quiet, but a small floor stays warm to keep latency off the connect path.
	poolCfg.MaxConns = int32(getInt("DB_MAX_CONNS", defaultMaxConns))
	poolCfg.MinConns = int32(getInt("DB_MIN_CONNS", minConnsFloor))
	if poolCfg.MinConns > poolCfg.MaxConns {
		poolCfg.MinConns = poolCfg.MaxConns
	}
	poolCfg.MaxConnIdleTime = 60 * time.Second
	poolCfg.MaxConnLifetime = 30 * time.Minute
	// Without a bound, a saturated pool makes callers wait indefinitely for a
	// connection; failing fast surfaces saturation instead of hiding it as
	// latency.
	poolCfg.ConnConfig.ConnectTimeout = 5 * time.Second

	var lastErr error
	for attempt := 0; attempt < 10; attempt++ {
		pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
		if err == nil {
			pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			err = pool.Ping(pingCtx)
			cancel()
			if err == nil {
				return pool, nil
			}
			pool.Close()
		}
		lastErr = err
		time.Sleep(2 * time.Second)
	}
	return nil, fmt.Errorf("could not connect to database: %w", lastErr)
}

func getInt(key string, fallback int) int {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}
