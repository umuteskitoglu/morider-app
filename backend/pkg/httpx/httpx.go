// Package httpx contains small HTTP helpers shared across services.
package httpx

import (
	"net/http"

	"github.com/gin-gonic/gin"
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

// Health registers a simple liveness endpoint reporting the service name.
func Health(r gin.IRoutes, service string) {
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": service})
	})
}
