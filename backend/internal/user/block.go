package user

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// blockedUser is a row in the caller's blocked-users list.
type blockedUser struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

// listBlocked returns the users the caller has blocked.
func (h *handler) listBlocked(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, COALESCE(u.avatar_url, '')
		 FROM user_blocks b JOIN users u ON u.id = b.blocked_id
		 WHERE b.blocker_id = $1
		 ORDER BY u.name`, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not list blocked users")
		return
	}
	defer rows.Close()

	users := make([]blockedUser, 0)
	for rows.Next() {
		var u blockedUser
		if err := rows.Scan(&u.ID, &u.Name, &u.AvatarURL); err != nil {
			httpx.Internal(c, "could not read blocked users")
			return
		}
		users = append(users, u)
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}

// blockUser blocks :userId (idempotent) and, like Instagram, tears down any
// follow edge between the two users in both directions so a blocked user
// disappears from both follower/following lists too.
func (h *handler) blockUser(c *gin.Context) {
	target, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	me := authpkg.UserID(c)
	if target == me {
		httpx.BadRequest(c, "cannot block yourself")
		return
	}

	var exists bool
	if err := h.d.DB.QueryRow(c, `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, target).Scan(&exists); err != nil {
		httpx.Internal(c, "could not find user")
		return
	}
	if !exists {
		httpx.Error(c, http.StatusNotFound, "user not found")
		return
	}

	tx, err := h.d.DB.Begin(c)
	if err != nil {
		httpx.Internal(c, "could not block user")
		return
	}
	defer tx.Rollback(c)

	if _, err := tx.Exec(c,
		`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		me, target); err != nil {
		httpx.Internal(c, "could not block user")
		return
	}
	if _, err := tx.Exec(c,
		`DELETE FROM follows WHERE (follower_id = $1 AND followee_id = $2) OR (follower_id = $2 AND followee_id = $1)`,
		me, target); err != nil {
		httpx.Internal(c, "could not block user")
		return
	}
	if err := tx.Commit(c); err != nil {
		httpx.Internal(c, "could not block user")
		return
	}
	c.JSON(http.StatusOK, gin.H{"blocking": true})
}

// unblockUser removes the caller's block on :userId.
func (h *handler) unblockUser(c *gin.Context) {
	target, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	if _, err := h.d.DB.Exec(c,
		`DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
		authpkg.UserID(c), target); err != nil {
		httpx.Internal(c, "could not unblock user")
		return
	}
	c.Status(http.StatusNoContent)
}

// blockStatus reports whether the caller blocks :userId and vice versa.
func (h *handler) blockStatus(c *gin.Context) {
	target, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	me := authpkg.UserID(c)

	var blocking, blockedBy bool
	err = h.d.DB.QueryRow(c,
		`SELECT EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2),
		        EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id = $2 AND blocked_id = $1)`,
		me, target).Scan(&blocking, &blockedBy)
	if err != nil {
		httpx.Internal(c, "could not load status")
		return
	}
	c.JSON(http.StatusOK, gin.H{"blocking": blocking, "blocked_by": blockedBy})
}
