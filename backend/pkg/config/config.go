// Package config loads service configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// defaultJWTSecret is the placeholder secret used for local development. It must
// never be used in production; Validate rejects it when APP_ENV=production.
const defaultJWTSecret = "change_me_in_production"

// defaultLiveKitSecret is the placeholder LiveKit API secret for local dev. Like
// the JWT secret, Validate rejects it when APP_ENV=production.
const defaultLiveKitSecret = "devsecret_change_me_in_production_32b"

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

	// TrustedProxies lists the CIDRs/IPs allowed to set X-Forwarded-For. Gin
	// defaults to trusting every peer, which lets any client forge its own
	// rate-limit identity; an empty list means "trust nobody" and ClientIP()
	// falls back to the real socket address. Set this to the gateway/ingress
	// hop only.
	TrustedProxies []string

	// MaxBodyBytes caps the size of any non-WebSocket request body.
	MaxBodyBytes int64

	// AllowedWSOrigins is the browser Origin allow-list for WebSocket upgrades.
	// The native mobile client sends no Origin and is always allowed.
	AllowedWSOrigins []string

	// Minimum interval between two global-chat messages from the same user
	// (slow mode). Guards the community room against flooding.
	GlobalChatSlowmode time.Duration

	// Routing engine (OSRM-compatible) used by the route service.
	RoutingURL     string
	RoutingProfile string

	// Elevation (DEM) endpoint, OpenTopoData-compatible, dataset included in
	// the URL. The public instance is rate limited; self-host for production.
	ElevationURL string

	// Geocoding (address search) endpoint, Nominatim-compatible. The public
	// instance has a strict usage policy; self-host for production.
	GeocodeURL string

	// Weather (forecast) endpoint, Open-Meteo-compatible. The public instance is
	// keyless and free for non-commercial use; self-host for production.
	WeatherURL string

	// Path to a Firebase service-account JSON. When set, the reward service sends
	// push via FCM HTTP v1; when empty it falls back to the Expo push relay.
	FCMCredentialsFile string

	// Directory where the feed service stores uploaded photos.
	UploadDir string

	// LiveKit (self-hosted SFU) powers always-on group ride voice chat. The
	// telemetry service mints room-join tokens; URL is the signalling endpoint
	// handed to clients.
	LiveKitURL       string
	LiveKitAPIKey    string
	LiveKitAPISecret string

	// Downstream service URLs used by the gateway.
	AuthURL      string
	UserURL      string
	RideURL      string
	RouteURL     string
	RewardURL    string
	TelemetryURL string
	FeedURL      string
	EventURL     string
	ChatURL      string
	CommunityURL string
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

		// Default to the private ranges docker-compose/k8s put the gateway on.
		// Deployments behind a cloud LB must set this to the LB's range.
		TrustedProxies: getList("TRUSTED_PROXIES", []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.1/32", "::1/128"}),
		MaxBodyBytes:   int64(getInt("MAX_BODY_BYTES", 1<<20)),

		AllowedWSOrigins: getList("ALLOWED_WS_ORIGINS", nil),

		GlobalChatSlowmode: time.Duration(getInt("GLOBAL_CHAT_SLOWMODE_SECONDS", 30)) * time.Second,

		RoutingURL:     getEnv("ROUTING_URL", "https://router.project-osrm.org"),
		RoutingProfile: getEnv("ROUTING_PROFILE", "driving"),

		ElevationURL: getEnv("ELEVATION_URL", "https://api.opentopodata.org/v1/srtm90m"),

		GeocodeURL: getEnv("GEOCODE_URL", "https://nominatim.openstreetmap.org"),

		WeatherURL: getEnv("WEATHER_URL", "https://api.open-meteo.com/v1/forecast"),

		FCMCredentialsFile: getEnv("FCM_CREDENTIALS_FILE", ""),

		UploadDir: getEnv("UPLOAD_DIR", "./uploads"),

		LiveKitURL:       getEnv("LIVEKIT_URL", "ws://localhost:7880"),
		LiveKitAPIKey:    getEnv("LIVEKIT_API_KEY", "devkey"),
		LiveKitAPISecret: getEnv("LIVEKIT_API_SECRET", defaultLiveKitSecret),

		AuthURL:      getEnv("AUTH_SERVICE_URL", "http://localhost:8081"),
		UserURL:      getEnv("USER_SERVICE_URL", "http://localhost:8082"),
		RideURL:      getEnv("RIDE_SERVICE_URL", "http://localhost:8083"),
		RouteURL:     getEnv("ROUTE_SERVICE_URL", "http://localhost:8084"),
		RewardURL:    getEnv("REWARD_SERVICE_URL", "http://localhost:8085"),
		TelemetryURL: getEnv("TELEMETRY_SERVICE_URL", "http://localhost:8086"),
		FeedURL:      getEnv("FEED_SERVICE_URL", "http://localhost:8087"),
		EventURL:     getEnv("EVENT_SERVICE_URL", "http://localhost:8088"),
		ChatURL:      getEnv("CHAT_SERVICE_URL", "http://localhost:8089"),
		CommunityURL: getEnv("COMMUNITY_SERVICE_URL", "http://localhost:8090"),
	}
}

// Validate checks for unsafe configuration before a service starts. In
// production it refuses to run with the development placeholder JWT secret, so a
// misconfigured deploy fails loudly instead of signing tokens anyone can forge.
func (c Config) Validate() error {
	if c.AppEnv == "production" && (c.JWTSecret == "" || c.JWTSecret == defaultJWTSecret) {
		return fmt.Errorf("JWT_SECRET must be set to a strong value when APP_ENV=production")
	}
	if c.AppEnv == "production" && (c.LiveKitAPISecret == "" || c.LiveKitAPISecret == defaultLiveKitSecret) {
		return fmt.Errorf("LIVEKIT_API_SECRET must be set to a strong value when APP_ENV=production")
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

// getList reads a comma-separated env var. An explicit empty value ("") is
// honoured as an empty list, which for TRUSTED_PROXIES means "trust nobody".
func getList(key string, fallback []string) []string {
	v, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func getFloat(key string, fallback float64) float64 {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			return n
		}
	}
	return fallback
}
