package user

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// friendUser is a friend / request counterparty.
type friendUser struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// friendRequest is an incoming pending request (with the requester's info).
type friendRequest struct {
	ID   int64      `json:"id"`
	User friendUser `json:"user"`
}

// listFriends returns the caller's accepted friends.
func (h *handler) listFriends(c *gin.Context) {
	me := authpkg.UserID(c)
	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, u.email
		 FROM friendships f
		 JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
		 WHERE f.status = 'accepted' AND (f.requester_id = $1 OR f.addressee_id = $1)
		 ORDER BY u.name`, me)
	if err != nil {
		httpx.Internal(c, "could not list friends")
		return
	}
	defer rows.Close()

	friends := make([]friendUser, 0)
	for rows.Next() {
		var f friendUser
		if err := rows.Scan(&f.ID, &f.Name, &f.Email); err != nil {
			httpx.Internal(c, "could not read friends")
			return
		}
		friends = append(friends, f)
	}
	c.JSON(http.StatusOK, gin.H{"friends": friends})
}

// incomingRequests lists pending requests addressed to the caller.
func (h *handler) incomingRequests(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT f.id, u.id, u.name, u.email
		 FROM friendships f JOIN users u ON u.id = f.requester_id
		 WHERE f.addressee_id = $1 AND f.status = 'pending'
		 ORDER BY f.created_at DESC`, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not list requests")
		return
	}
	defer rows.Close()

	reqs := make([]friendRequest, 0)
	for rows.Next() {
		var r friendRequest
		if err := rows.Scan(&r.ID, &r.User.ID, &r.User.Name, &r.User.Email); err != nil {
			httpx.Internal(c, "could not read requests")
			return
		}
		reqs = append(reqs, r)
	}
	c.JSON(http.StatusOK, gin.H{"requests": reqs})
}

type sendRequestReq struct {
	Email  string `json:"email"`
	UserID int64  `json:"user_id"`
}

// sendRequest creates a pending friend request to a user identified by either
// user_id or email.
func (h *handler) sendRequest(c *gin.Context) {
	var req sendRequestReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	if req.UserID == 0 && req.Email == "" {
		httpx.BadRequest(c, "user_id or email is required")
		return
	}
	me := authpkg.UserID(c)

	var (
		target friendUser
		err    error
	)
	if req.UserID != 0 {
		err = h.d.DB.QueryRow(c, `SELECT id, name, email FROM users WHERE id = $1`, req.UserID).
			Scan(&target.ID, &target.Name, &target.Email)
	} else {
		err = h.d.DB.QueryRow(c, `SELECT id, name, email FROM users WHERE email = $1`, req.Email).
			Scan(&target.ID, &target.Name, &target.Email)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not find user")
		return
	}
	if target.ID == me {
		httpx.BadRequest(c, "cannot add yourself")
		return
	}

	// Reject if any relation already exists in either direction.
	var exists bool
	if err := h.d.DB.QueryRow(c,
		`SELECT EXISTS(SELECT 1 FROM friendships
		 WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
		me, target.ID).Scan(&exists); err != nil {
		httpx.Internal(c, "could not check friendship")
		return
	}
	if exists {
		httpx.Error(c, http.StatusConflict, "request already exists or you are already friends")
		return
	}

	if _, err := h.d.DB.Exec(c,
		`INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')`,
		me, target.ID); err != nil {
		httpx.Internal(c, "could not send request")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"status": "pending_out", "user": target})
}

// acceptRequest accepts a pending request addressed to the caller.
func (h *handler) acceptRequest(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid request id")
		return
	}
	tag, err := h.d.DB.Exec(c,
		`UPDATE friendships SET status = 'accepted'
		 WHERE id = $1 AND addressee_id = $2 AND status = 'pending'`,
		id, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not accept request")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "request not found")
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "friends"})
}

// declineRequest deletes a pending request addressed to the caller.
func (h *handler) declineRequest(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid request id")
		return
	}
	tag, err := h.d.DB.Exec(c,
		`DELETE FROM friendships WHERE id = $1 AND addressee_id = $2 AND status = 'pending'`,
		id, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not decline request")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "request not found")
		return
	}
	c.Status(http.StatusNoContent)
}

// removeFriend removes any friendship/request between the caller and userId.
func (h *handler) removeFriend(c *gin.Context) {
	other, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	if _, err := h.d.DB.Exec(c,
		`DELETE FROM friendships
		 WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
		authpkg.UserID(c), other); err != nil {
		httpx.Internal(c, "could not remove friend")
		return
	}
	c.Status(http.StatusNoContent)
}

// friendStatus reports the relationship between the caller and userId:
// none | pending_out | pending_in | friends.
func (h *handler) friendStatus(c *gin.Context) {
	other, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	me := authpkg.UserID(c)

	var rowID, requester int64
	var status string
	err = h.d.DB.QueryRow(c,
		`SELECT id, status, requester_id FROM friendships
		 WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
		me, other).Scan(&rowID, &status, &requester)
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusOK, gin.H{"status": "none"})
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load status")
		return
	}
	result := "friends"
	if status == "pending" {
		if requester == me {
			result = "pending_out"
		} else {
			result = "pending_in"
		}
	}
	c.JSON(http.StatusOK, gin.H{"status": result, "request_id": rowID})
}
