// Command morider is a single binary that runs any one of the Morider
// microservices, selected with the -service flag. docker-compose launches one
// container per service using the same image.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/morider/backend/internal/auth"
	"github.com/morider/backend/internal/feed"
	"github.com/morider/backend/internal/gateway"
	"github.com/morider/backend/internal/reward"
	"github.com/morider/backend/internal/ride"
	"github.com/morider/backend/internal/route"
	"github.com/morider/backend/internal/telemetry"
	"github.com/morider/backend/internal/user"
	"github.com/morider/backend/pkg/config"
)

func main() {
	service := flag.String("service", "", "service to run: gateway|auth|user|ride|route|reward|telemetry|feed")
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

	runners := map[string]func(config.Config) error{
		"gateway":   gateway.Run,
		"auth":      auth.Run,
		"user":      user.Run,
		"ride":      ride.Run,
		"route":     route.Run,
		"reward":    reward.Run,
		"telemetry": telemetry.Run,
		"feed":      feed.Run,
	}

	run, ok := runners[name]
	if !ok {
		fmt.Println("usage: morider -service=gateway|auth|user|ride|route|reward|telemetry|feed")
		os.Exit(2)
	}

	if err := run(cfg); err != nil {
		log.Fatalf("service %q failed: %v", name, err)
	}
}
