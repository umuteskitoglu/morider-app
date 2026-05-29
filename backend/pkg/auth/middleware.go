package auth

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	ctxUserID = "auth_user_id"
	ctxEmail  = "auth_email"
)

// Middleware validates the Bearer token and stores the user id in the context.
func (m *Manager) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if header == "" || !strings.HasPrefix(header, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing bearer token"})
			return
		}
		tokenStr := strings.TrimPrefix(header, "Bearer ")
		claims, err := m.Parse(tokenStr)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
			return
		}
		c.Set(ctxUserID, claims.UserID)
		c.Set(ctxEmail, claims.Email)
		c.Next()
	}
}

// UserID returns the authenticated user id from the gin context.
func UserID(c *gin.Context) int64 {
	if v, ok := c.Get(ctxUserID); ok {
		if id, ok := v.(int64); ok {
			return id
		}
	}
	return 0
}

// Email returns the authenticated user's email from the gin context.
func Email(c *gin.Context) string {
	if v, ok := c.Get(ctxEmail); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
