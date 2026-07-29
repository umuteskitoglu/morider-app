// Package httpx contains small HTTP helpers shared across services.
package httpx

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Error writes a consistent JSON error envelope.
func Error(c *gin.Context, status int, message string) {
	c.AbortWithStatusJSON(status, gin.H{"error": message})
}

// BadRequest is a convenience helper for 400 responses.
func BadRequest(c *gin.Context, message string) {
	Error(c, http.StatusBadRequest, message)
}

// Internal is a convenience helper for 500 responses.
func Internal(c *gin.Context, message string) {
	Error(c, http.StatusInternalServerError, message)
}

// Health registers a liveness endpoint: the process is running and able to
// serve. It deliberately does not touch the database — a liveness probe that
// fails on a transient database blip gets healthy pods killed.
func Health(r gin.IRoutes, service string) {
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": service})
	})
}

// Ready registers a readiness endpoint that verifies the service can actually
// reach its dependencies, so Kubernetes stops routing traffic to a pod whose
// database is unreachable instead of serving 500s from it.
func Ready(r gin.IRoutes, service string, pool *pgxpool.Pool) {
	r.GET("/ready", func(c *gin.Context) {
		if pool != nil {
			ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
			defer cancel()
			if err := pool.Ping(ctx); err != nil {
				c.JSON(http.StatusServiceUnavailable, gin.H{
					"status": "unavailable", "service": service, "reason": "database",
				})
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"status": "ready", "service": service})
	})
}
