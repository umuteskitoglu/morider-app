// Command morider is a single binary that runs any one of the Morider
// microservices, selected with the -service flag. docker-compose launches one
// container per service using the same image.
//
// For small hosts (e.g. a 2 GB VPS) the special service name "all" runs every
// service in a single process: one Go runtime instead of nine, and one set of
// connection pools. The gateway still proxies to the others over localhost, so
// no routing changes are needed — just point the gateway's *_SERVICE_URL at
// http://localhost:<port>. See docker-compose.prod.yml.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/morider/backend/internal/auth"
	"github.com/morider/backend/internal/event"
	"github.com/morider/backend/internal/feed"
	"github.com/morider/backend/internal/gateway"
	"github.com/morider/backend/internal/reward"
	"github.com/morider/backend/internal/ride"
	"github.com/morider/backend/internal/route"
	"github.com/morider/backend/internal/telemetry"
	"github.com/morider/backend/internal/user"
	"github.com/morider/backend/migrations"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/db"
	"github.com/morider/backend/pkg/migrate"
)

func main() {
	service := flag.String("service", "", "service to run: all|gateway|auth|user|ride|route|reward|telemetry|feed|event")
	flag.Parse()

	// Allow selecting the service via env too (handy in containers).
	name := *service
	if name == "" {
		name = os.Getenv("SERVICE")
	}

	cfg := config.Load()
	if err := cfg.Validate(); err != nil {
		log.Fatalf("invalid configuration: %v", err)
	}

	pool, err := db.Connect(context.Background(), cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("database connection failed: %v", err)
	}
	if err := migrate.Run(context.Background(), pool, migrations.FS); err != nil {
		log.Fatalf("migrations failed: %v", err)
	}
	pool.Close()

	runners := map[string]func(config.Config) error{
		"gateway":   gateway.Run,
		"auth":      auth.Run,
		"user":      user.Run,
		"ride":      ride.Run,
		"route":     route.Run,
		"reward":    reward.Run,
		"telemetry": telemetry.Run,
		"feed":      feed.Run,
		"event":     event.Run,
	}

	if name == "all" {
		if err := runAll(cfg, runners); err != nil {
			log.Fatalf("all-in-one mode failed: %v", err)
		}
		return
	}

	run, ok := runners[name]
	if !ok {
		fmt.Println("usage: morider -service=all|gateway|auth|user|ride|route|reward|telemetry|feed|event")
		os.Exit(2)
	}

	if err := run(cfg); err != nil {
		log.Fatalf("service %q failed: %v", name, err)
	}
}

// runAll launches every service in the current process, sharing one Go runtime.
// Each service's Run binds its own port and blocks on SIGINT/SIGTERM internally,
// so they are started as goroutines and the first result wins: a startup error
// (e.g. a port clash) is surfaced immediately, while on shutdown the signal
// reaches every service and the process exits once the first one returns.
func runAll(cfg config.Config, runners map[string]func(config.Config) error) error {
	// Backend services first, gateway last, so the gateway's upstreams are
	// already listening by the time it starts proxying.
	order := []string{
		"auth", "user", "ride", "route", "reward",
		"telemetry", "feed", "event", "gateway",
	}

	results := make(chan error, len(order))
	for _, name := range order {
		run := runners[name]
		go func(name string, run func(config.Config) error) {
			err := run(cfg)
			if err != nil {
				err = fmt.Errorf("service %q: %w", name, err)
			}
			results <- err
		}(name, run)
	}

	return <-results
}
