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

// Store is a set of token buckets keyed by an arbitrary string, with idle
// eviction. Exported so handlers can rate limit on a key that is only known
// after the request body is parsed — the login endpoint limits per targeted
// account, which a middleware cannot see without consuming the body.
type Store struct {
	mu      sync.Mutex
	clients map[string]*entry
	rate    rate.Limit
	burst   int
}

// NewStore builds a keyed limiter store and starts its eviction sweep.
func NewStore(r rate.Limit, burst int) *Store {
	s := &Store{clients: make(map[string]*entry), rate: r, burst: burst}
	go s.sweepLoop()
	return s
}

// Allow reports whether the given key may proceed, consuming a token if so.
func (s *Store) Allow(key string) bool { return s.get(key).Allow() }

type limiterStore = Store

// Middleware limits each client IP to r requests/sec with the given burst.
//
// Note that this is per-process: with N replicas the effective ceiling is N*r,
// and every bucket resets on deploy. It is a blunt safety net, not a quota.
func Middleware(r rate.Limit, burst int) gin.HandlerFunc {
	return Keyed(r, burst, func(c *gin.Context) string { return c.ClientIP() })
}

// Keyed limits by an arbitrary key derived from the request.
//
// The login endpoint needs this: limiting by IP alone lets a distributed
// credential-stuffing run walk through accounts freely, so auth routes key by
// IP *and* the targeted account.
func Keyed(r rate.Limit, burst int, key func(*gin.Context) string) gin.HandlerFunc {
	store := NewStore(r, burst)
	return func(c *gin.Context) {
		if !store.Allow(key(c)) {
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
