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

// defaultMaxConns caps each pool small by default. Every Postgres backend costs
// several MB of RAM, so on a small host (and especially in the all-in-one
// process, which opens one pool per service) a low ceiling keeps memory bounded.
// Override per deploy with DB_MAX_CONNS.
const defaultMaxConns = 4

// Connect opens a pgx pool, retrying for a short window so services can start
// alongside the database in docker-compose.
func Connect(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid database url: %w", err)
	}

	// Keep the pool small and let idle connections drain so Postgres backends
	// are released when a service is quiet. MinConns=0 means nothing is held
	// open while idle.
	poolCfg.MaxConns = int32(getInt("DB_MAX_CONNS", defaultMaxConns))
	poolCfg.MinConns = 0
	poolCfg.MaxConnIdleTime = 60 * time.Second
	poolCfg.MaxConnLifetime = 30 * time.Minute

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
