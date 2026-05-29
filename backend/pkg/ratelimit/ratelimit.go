// Package ratelimit offers a simple per-client token bucket Gin middleware.
package ratelimit

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

// idleTTL is how long an idle client limiter is kept before being evicted, and
// sweepInterval is how often the store scans for idle limiters to drop. Without
// eviction the clients map would grow unbounded with one entry per source IP.
const (
	idleTTL       = 10 * time.Minute
	sweepInterval = time.Minute
)

type entry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

type limiterStore struct {
	mu      sync.Mutex
	clients map[string]*entry
	rate    rate.Limit
	burst   int
}

// Middleware limits each client IP to r requests/sec with the given burst.
func Middleware(r rate.Limit, burst int) gin.HandlerFunc {
	store := &limiterStore{
		clients: make(map[string]*entry),
		rate:    r,
		burst:   burst,
	}
	go store.sweepLoop()
	return func(c *gin.Context) {
		if !store.get(c.ClientIP()).Allow() {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate limit exceeded"})
			return
		}
		c.Next()
	}
}

func (s *limiterStore) get(key string) *rate.Limiter {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.clients[key]; ok {
		e.lastSeen = time.Now()
		return e.limiter
	}
	e := &entry{limiter: rate.NewLimiter(s.rate, s.burst), lastSeen: time.Now()}
	s.clients[key] = e
	return e.limiter
}

// sweepLoop periodically removes limiters for clients that have been idle longer
// than idleTTL so the store does not leak memory under churning client IPs.
func (s *limiterStore) sweepLoop() {
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for range ticker.C {
		cutoff := time.Now().Add(-idleTTL)
		s.mu.Lock()
		for key, e := range s.clients {
			if e.lastSeen.Before(cutoff) {
				delete(s.clients, key)
			}
		}
		s.mu.Unlock()
	}
}
