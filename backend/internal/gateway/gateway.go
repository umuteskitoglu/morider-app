// Package gateway is a thin reverse proxy in front of the microservices.
package gateway

import (
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/morider/backend/internal/server"
	"github.com/morider/backend/pkg/config"
)

// Run boots the API gateway.
func Run(cfg config.Config) error {
	deps, err := server.NewWithoutDB("gateway", cfg)
	if err != nil {
		return err
	}

	// Order matters: more specific prefixes first.
	routes := []struct {
		prefix string
		target string
	}{
		{"/api/auth", cfg.AuthURL},
		{"/api/users", cfg.UserURL},
		{"/api/follows", cfg.UserURL},
		{"/api/rides", cfg.RideURL},
		{"/api/garage", cfg.RideURL},
		{"/api/segments", cfg.RideURL},
		{"/api/routes", cfg.RouteURL},
		{"/api/pois", cfg.RouteURL},
		{"/api/weather", cfg.RouteURL},
		{"/api/rewards", cfg.RewardURL},
		{"/api/leaderboard", cfg.RewardURL},
		{"/api/challenges", cfg.RewardURL},
		{"/api/challenge-invites", cfg.RewardURL},
		{"/api/telemetry", cfg.TelemetryURL},
		{"/api/sessions", cfg.TelemetryURL},
		{"/api/presence", cfg.TelemetryURL},
		{"/api/sos", cfg.TelemetryURL},
		{"/api/feed", cfg.FeedURL},
		{"/api/posts", cfg.FeedURL},
		{"/api/comments", cfg.FeedURL},
		{"/api/events", cfg.EventURL},
		{"/api/chat", cfg.ChatURL},
		{"/api/dm", cfg.ChatURL},
		{"/api/communities", cfg.CommunityURL},
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

// proxyTransport is shared by every route. http.DefaultTransport is unsuitable
// here: it has no ResponseHeaderTimeout (so a hung upstream pins gateway
// goroutines indefinitely) and allows only 2 idle connections per host, which
// forces a fresh TCP+handshake on most proxied requests.
//
// ResponseHeaderTimeout bounds the wait for an upstream's *headers* only, so it
// does not interfere with WebSocket upgrades once they are established.
var proxyTransport = &http.Transport{
	Proxy: http.ProxyFromEnvironment,
	DialContext: (&net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
	MaxIdleConns:          200,
	MaxIdleConnsPerHost:   50,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   5 * time.Second,
	ExpectContinueTimeout: 1 * time.Second,
	ResponseHeaderTimeout: 30 * time.Second,
}

func newProxy(target string) (*httputil.ReverseProxy, error) {
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	proxy := httputil.NewSingleHostReverseProxy(u)
	proxy.Transport = proxyTransport
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"upstream unavailable"}`))
	}
	return proxy, nil
}
