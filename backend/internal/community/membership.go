package community

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// Member is the API representation of a community member (or join request).
type Member struct {
	UserID   int64     `json:"user_id"`
	Name     string    `json:"name"`
	Role     string    `json:"role"`
	Status   string    `json:"status"`
	JoinedAt time.Time `json:"joined_at"`
}

// join adds the caller to a community: instantly in a public one, as a pending
// request in a closed one. Idempotent — rejoining while already a member (or
// already pending) returns the existing state.
func (h *handler) join(c *gin.Context) {
	id, ok := communityID(c)
	if !ok {
		return
	}
	privacy, ok := h.communityPrivacy(c, id)
	if !ok {
		return
	}
	uid := authpkg.UserID(c)

	status := "active"
	if privacy == "closed" {
		status = "pending"
	}
	tag, err := h.d.DB.Exec(c,
		`INSERT INTO community_members (community_id, user_id, role, status)
		 VALUES ($1, $2, 'member', $3) ON CONFLICT DO NOTHING`, id, uid, status)
	if err != nil {
		httpx.Internal(c, "could not join community")
		return
	}
	if tag.RowsAffected() == 0 {
		// Already a member or already requested; report the current state.
		role, current, ok := h.membershipOf(c, id, uid)
		if !ok {
			return
		}
		c.JSON(http.StatusOK, gin.H{"role": role, "status": current})
		return
	}
	if status == "pending" {
		h.notifyJoinRequest(id, uid)
	}
	c.JSON(http.StatusCreated, gin.H{"role": "member", "status": status})
}

// leave removes the caller from a community (or cancels a pending request).
// The owner cannot leave; ownership transfer is not supported yet.
func (h *handler) leave(c *gin.Context) {
	id, ok := communityID(c)
	if !ok {
		return
	}
	uid := authpkg.UserID(c)
	role, _, ok := h.membershipOf(c, id, uid)
	if !ok {
		return
	}
	if role == "" {
		httpx.Error(c, http.StatusNotFound, "you are not a member of this community")
		return
	}
	if role == "owner" {
		httpx.BadRequest(c, "the owner cannot leave the community")
		return
	}
	if _, err := h.d.DB.Exec(c,
		`DELETE FROM community_members WHERE community_id = $1 AND user_id = $2`, id, uid); err != nil {
		httpx.Internal(c, "could not leave community")
		return
	}
	c.Status(http.StatusNoContent)
}

// listMembers returns the active members, owner/admins first. Admins may pass
// ?status=pending to review join requests instead.
func (h *handler) listMembers(c *gin.Context) {
	id, ok := communityID(c)
	if !ok {
		return
	}
	role, ok := h.requireActiveMember(c, id)
	if !ok {
		return
	}
	status := "active"
	if c.Query("status") == "pending" {
		if !isAdminRole(role) {
			httpx.Error(c, http.StatusForbidden, "only community admins can view join requests")
			return
		}
		status = "pending"
	}

	rows, err := h.d.DB.Query(c,
		`SELECT m.user_id, u.name, m.role, m.status, m.created_at
		 FROM community_members m JOIN users u ON u.id = m.user_id
		 WHERE m.community_id = $1 AND m.status = $2
		 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at
		 LIMIT 500`, id, status)
	if err != nil {
		httpx.Internal(c, "could not load members")
		return
	}
	defer rows.Close()

	members := make([]Member, 0)
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.UserID, &m.Name, &m.Role, &m.Status, &m.JoinedAt); err != nil {
			httpx.Internal(c, "could not read members")
			return
		}
		members = append(members, m)
	}
	c.JSON(http.StatusOK, gin.H{"members": members})
}

func (h *handler) approveRequest(c *gin.Context) {
	id, ok := communityID(c)
	if !ok {
		return
	}
	target, ok := memberIDParam(c)
	if !ok {
		return
	}
	if _, ok := h.requireAdmin(c, id); !ok {
		return
	}
	tag, err := h.d.DB.Exec(c,
		`UPDATE community_members SET status = 'active'
		 WHERE community_id = $1 AND user_id = $2 AND status = 'pending'`, id, target)
	if err != nil {
		httpx.Internal(c, "could not approve request")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "join request not found")
		return
	}
	h.notifyApproved(id, target)
	c.Status(http.StatusNoContent)
}

func (h *handler) rejectRequest(c *gin.Context) {
	id, ok := communityID(c)
	if !ok {
		return
	}
	target, ok := memberIDParam(c)
	if !ok {
		return
	}
	if _, ok := h.requireAdmin(c, id); !ok {
		return
	}
	tag, err := h.d.DB.Exec(c,
		`DELETE FROM community_members
		 WHERE community_id = $1 AND user_id = $2 AND status = 'pending'`, id, target)
	if err != nil {
		httpx.Internal(c, "could not reject request")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "join request not found")
		return
	}
	c.Status(http.StatusNoContent)
}

// promote elevates an active member to admin. Owner only.
func (h *handler) promote(c *gin.Context) {
	h.changeRole(c, "member", "admin")
}

// demote turns an admin back into a regular member. Owner only.
func (h *handler) demote(c *gin.Context) {
	h.changeRole(c, "admin", "member")
}

func (h *handler) changeRole(c *gin.Context, from, to string) {
	id, ok := communityID(c)
	if !ok {
		return
	}
	target, ok := memberIDParam(c)
	if !ok {
		return
	}
	role, ok := h.requireAdmin(c, id)
	if !ok {
		return
	}
	if role != "owner" {
		httpx.Error(c, http.StatusForbidden, "only the owner can change member roles")
		return
	}
	tag, err := h.d.DB.Exec(c,
		`UPDATE community_members SET role = $4
		 WHERE community_id = $1 AND user_id = $2 AND role = $3 AND status = 'active'`,
		id, target, from, to)
	if err != nil {
		httpx.Internal(c, "could not change role")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "member not found")
		return
	}
	c.Status(http.StatusNoContent)
}

// kick removes a member. Admins may kick regular members; only the owner may
// kick admins; nobody kicks the owner.
func (h *handler) kick(c *gin.Context) {
	id, ok := communityID(c)
	if !ok {
		return
	}
	target, ok := memberIDParam(c)
	if !ok {
		return
	}
	callerRole, ok := h.requireAdmin(c, id)
	if !ok {
		return
	}
	targetRole, _, ok := h.membershipOf(c, id, target)
	if !ok {
		return
	}
	if targetRole == "" {
		httpx.Error(c, http.StatusNotFound, "member not found")
		return
	}
	if targetRole == "owner" {
		httpx.BadRequest(c, "the owner cannot be removed")
		return
	}
	if targetRole == "admin" && callerRole != "owner" {
		httpx.Error(c, http.StatusForbidden, "only the owner can remove an admin")
		return
	}
	if _, err := h.d.DB.Exec(c,
		`DELETE FROM community_members WHERE community_id = $1 AND user_id = $2`, id, target); err != nil {
		httpx.Internal(c, "could not remove member")
		return
	}
	c.Status(http.StatusNoContent)
}
