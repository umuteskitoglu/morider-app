package user

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// followUser is a follower / followee counterparty. Following reports whether
// the *caller* follows this user, so the client can render each row's button.
type followUser struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	Following bool   `json:"following"`
}

// listFollowing returns the users the caller follows. Every row is, by
// definition, someone the caller follows, so Following is always true.
func (h *handler) listFollowing(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, u.email, true
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

// listFollowers returns the users following the caller; Following marks the
// ones the caller follows back.
func (h *handler) listFollowers(c *gin.Context) {
	me := authpkg.UserID(c)
	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, u.email,
		        EXISTS(SELECT 1 FROM follows m WHERE m.follower_id = $1 AND m.followee_id = u.id)
		 FROM follows f JOIN users u ON u.id = f.follower_id
		 WHERE f.followee_id = $1
		 ORDER BY u.name`, me)
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

// listUserFollowing returns the users :userId follows, gated by canViewFollows.
func (h *handler) listUserFollowing(c *gin.Context) {
	target, ok := h.gateFollowList(c)
	if !ok {
		return
	}
	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, u.email,
		        EXISTS(SELECT 1 FROM follows m WHERE m.follower_id = $2 AND m.followee_id = u.id)
		 FROM follows f JOIN users u ON u.id = f.followee_id
		 WHERE f.follower_id = $1
		 ORDER BY u.name`, target, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not list following")
		return
	}
	users, scanned := scanFollowUsers(c, rows)
	if !scanned {
		return
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}

// listUserFollowers returns the users following :userId, gated by canViewFollows.
func (h *handler) listUserFollowers(c *gin.Context) {
	target, ok := h.gateFollowList(c)
	if !ok {
		return
	}
	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, u.email,
		        EXISTS(SELECT 1 FROM follows m WHERE m.follower_id = $2 AND m.followee_id = u.id)
		 FROM follows f JOIN users u ON u.id = f.follower_id
		 WHERE f.followee_id = $1
		 ORDER BY u.name`, target, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not list followers")
		return
	}
	users, scanned := scanFollowUsers(c, rows)
	if !scanned {
		return
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}

// gateFollowList parses :userId and enforces the Instagram-style visibility
// rule: the caller may view a user's follow lists only if it is their own, or
// there is a follow edge in either direction between them. On any failure it
// writes the response and returns ok=false; callers must stop.
func (h *handler) gateFollowList(c *gin.Context) (int64, bool) {
	target, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return 0, false
	}
	me := authpkg.UserID(c)
	if me == target {
		return target, true
	}
	var related bool
	if err := h.d.DB.QueryRow(c,
		`SELECT EXISTS(
		    SELECT 1 FROM follows
		    WHERE (follower_id = $1 AND followee_id = $2)
		       OR (follower_id = $2 AND followee_id = $1))`,
		me, target).Scan(&related); err != nil {
		httpx.Internal(c, "could not check access")
		return 0, false
	}
	if !related {
		httpx.Error(c, http.StatusForbidden, "follow lists are visible only to connections")
		return 0, false
	}
	return target, true
}

// scanFollowUsers drains rows of (id, name, email, following). On scan error it
// writes a 500 and returns ok=false; callers must stop.
func scanFollowUsers(c *gin.Context, rows pgx.Rows) ([]followUser, bool) {
	defer rows.Close()
	users := make([]followUser, 0)
	for rows.Next() {
		var u followUser
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.Following); err != nil {
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
