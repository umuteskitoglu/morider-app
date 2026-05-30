package user

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// followUser is a follower / followee counterparty.
type followUser struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// listFollowing returns the users the caller follows.
func (h *handler) listFollowing(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, u.email
		 FROM follows f JOIN users u ON u.id = f.followee_id
		 WHERE f.follower_id = $1
		 ORDER BY u.name`, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not list following")
		return
	}
	users, ok := scanFollowUsers(c, rows)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}

// listFollowers returns the users following the caller.
func (h *handler) listFollowers(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, u.email
		 FROM follows f JOIN users u ON u.id = f.follower_id
		 WHERE f.followee_id = $1
		 ORDER BY u.name`, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not list followers")
		return
	}
	users, ok := scanFollowUsers(c, rows)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}

// scanFollowUsers drains rows of (id, name, email). On scan error it writes a
// 500 and returns ok=false; callers must stop.
func scanFollowUsers(c *gin.Context, rows pgx.Rows) ([]followUser, bool) {
	defer rows.Close()
	users := make([]followUser, 0)
	for rows.Next() {
		var u followUser
		if err := rows.Scan(&u.ID, &u.Name, &u.Email); err != nil {
			httpx.Internal(c, "could not read users")
			return nil, false
		}
		users = append(users, u)
	}
	return users, true
}

// follow creates a follow edge from the caller to :userId (idempotent).
func (h *handler) follow(c *gin.Context) {
	target, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	me := authpkg.UserID(c)
	if target == me {
		httpx.BadRequest(c, "cannot follow yourself")
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

	if _, err := h.d.DB.Exec(c,
		`INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		me, target); err != nil {
		httpx.Internal(c, "could not follow user")
		return
	}
	c.JSON(http.StatusOK, gin.H{"following": true})
}

// unfollow removes the caller's follow edge to :userId.
func (h *handler) unfollow(c *gin.Context) {
	target, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	if _, err := h.d.DB.Exec(c,
		`DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`,
		authpkg.UserID(c), target); err != nil {
		httpx.Internal(c, "could not unfollow user")
		return
	}
	c.Status(http.StatusNoContent)
}

// followStatus reports whether the caller follows :userId and vice versa.
// following && followed_by == mutual ("friends").
func (h *handler) followStatus(c *gin.Context) {
	target, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	me := authpkg.UserID(c)

	var following, followedBy bool
	err = h.d.DB.QueryRow(c,
		`SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2),
		        EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = $1)`,
		me, target).Scan(&following, &followedBy)
	if err != nil {
		httpx.Internal(c, "could not load status")
		return
	}
	c.JSON(http.StatusOK, gin.H{"following": following, "followed_by": followedBy})
}
