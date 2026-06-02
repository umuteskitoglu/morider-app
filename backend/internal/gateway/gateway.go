// Package gateway is a thin reverse proxy in front of the microservices.
package gateway

import (
	"net/http"
	"net/http/httputil"
	"net/url"

	"github.com/gin-gonic/gin"

	"github.com/morider/backend/internal/server"
	"github.com/morider/backend/pkg/config"
)

// Run boots the API gateway.
func Run(cfg config.Config) error {
	deps := server.NewWithoutDB("gateway", cfg)

	// Order matters: more specific prefixes first.
	routes := []struct {
		prefix string
		target string
	}{
		{"/api/auth", cfg.AuthURL},
		{"/api/users", cfg.UserURL},
		{"/api/follows", cfg.UserURL},
		{"/api/rides", cfg.RideURL},
		{"/api/routes", cfg.RouteURL},
		{"/api/rewards", cfg.RewardURL},
		{"/api/leaderboard", cfg.RewardURL},
		{"/api/telemetry", cfg.TelemetryURL},
		{"/api/sessions", cfg.TelemetryURL},
		{"/api/feed", cfg.FeedURL},
		{"/api/posts", cfg.FeedURL},
		{"/api/comments", cfg.FeedURL},
		{"/api/events", cfg.EventURL},
	}

	for _, r := range routes {
		proxy, err := newProxy(r.target)
		if err != nil {
			return err
		}
		deps.Engine.Any(r.prefix, gin.WrapH(proxy))
		deps.Engine.Any(r.prefix+"/*rest", gin.WrapH(proxy))
	}

	return deps.Run(config.ResolvePort("GATEWAY_PORT", "8080"))
}

func newProxy(target string) (*httputil.ReverseProxy, error) {
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	proxy := httputil.NewSingleHostReverseProxy(u)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"upstream unavailable"}`))
	}
	return proxy, nil
}
