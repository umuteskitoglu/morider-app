// Package config loads service configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// defaultJWTSecret is the placeholder secret used for local development. It must
// never be used in production; Validate rejects it when APP_ENV=production.
const defaultJWTSecret = "change_me_in_production"

// Config holds the runtime configuration shared across services.
type Config struct {
	AppEnv string

	DatabaseURL string
	RedisURL    string
	NATSURL     string

	JWTSecret string
	JWTTTL    time.Duration

	// Per-client-IP rate limit applied by every service (token bucket).
	RateLimitRPS   float64
	RateLimitBurst int

	// Routing engine (OSRM-compatible) used by the route service.
	RoutingURL     string
	RoutingProfile string

	// Elevation (DEM) endpoint, OpenTopoData-compatible, dataset included in
	// the URL. The public instance is rate limited; self-host for production.
	ElevationURL string

	// Directory where the feed service stores uploaded photos.
	UploadDir string

	// Downstream service URLs used by the gateway.
	AuthURL      string
	UserURL      string
	RideURL      string
	RouteURL     string
	RewardURL    string
	TelemetryURL string
	FeedURL      string
	EventURL     string
}

// Load reads configuration from the environment, applying sane defaults so the
// services can boot locally without a fully populated .env file.
func Load() Config {
	ttlHours := getInt("JWT_TTL_HOURS", 72)
	return Config{
		AppEnv:      getEnv("APP_ENV", "development"),
		DatabaseURL: getEnv("DATABASE_URL", "postgres://morider:morider_secret@localhost:5432/morider?sslmode=disable"),
		RedisURL:    getEnv("REDIS_URL", "redis://localhost:6379/0"),
		NATSURL:     getEnv("NATS_URL", "nats://localhost:4222"),

		JWTSecret: getEnv("JWT_SECRET", defaultJWTSecret),
		JWTTTL:    time.Duration(ttlHours) * time.Hour,

		RateLimitRPS:   getFloat("RATE_LIMIT_RPS", 50),
		RateLimitBurst: getInt("RATE_LIMIT_BURST", 100),

		RoutingURL:     getEnv("ROUTING_URL", "https://router.project-osrm.org"),
		RoutingProfile: getEnv("ROUTING_PROFILE", "driving"),

		ElevationURL: getEnv("ELEVATION_URL", "https://api.opentopodata.org/v1/srtm90m"),

		UploadDir: getEnv("UPLOAD_DIR", "./uploads"),

		AuthURL:      getEnv("AUTH_SERVICE_URL", "http://localhost:8081"),
		UserURL:      getEnv("USER_SERVICE_URL", "http://localhost:8082"),
		RideURL:      getEnv("RIDE_SERVICE_URL", "http://localhost:8083"),
		RouteURL:     getEnv("ROUTE_SERVICE_URL", "http://localhost:8084"),
		RewardURL:    getEnv("REWARD_SERVICE_URL", "http://localhost:8085"),
		TelemetryURL: getEnv("TELEMETRY_SERVICE_URL", "http://localhost:8086"),
		FeedURL:      getEnv("FEED_SERVICE_URL", "http://localhost:8087"),
		EventURL:     getEnv("EVENT_SERVICE_URL", "http://localhost:8088"),
	}
}

// Validate checks for unsafe configuration before a service starts. In
// production it refuses to run with the development placeholder JWT secret, so a
// misconfigured deploy fails loudly instead of signing tokens anyone can forge.
func (c Config) Validate() error {
	if c.AppEnv == "production" && (c.JWTSecret == "" || c.JWTSecret == defaultJWTSecret) {
		return fmt.Errorf("JWT_SECRET must be set to a strong value when APP_ENV=production")
	}
	return nil
}

// ResolvePort returns the port for a given service, reading the matching env var
// (e.g. AUTH_PORT) and falling back to the provided default.
func ResolvePort(envKey, fallback string) string {
	return getEnv(envKey, fallback)
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func getInt(key string, fallback int) int {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func getFloat(key string, fallback float64) float64 {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			return n
		}
	}
	return fallback
}
