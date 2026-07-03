// Package community implements rider communities (Topluluk): clubs where only
// admins publish posts (announcements, shared routes, event announcements and
// polls) while regular members comment, like and vote. Photo handling and the
// comment/like model mirror the feed service; membership adds the role layer.
package community

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/httpx"
	"github.com/morider/backend/pkg/push"
)

const (
	maxPhotos      = 10
	maxPhotoBytes  = 10 << 20 // 10 MB
	mediaURLPrefix = "/api/communities/media/"
)

type handler struct {
	d         *server.Deps
	push      push.Sender
	uploadDir string
}

// Run boots the community service.
func Run(cfg config.Config) error {
	deps, err := server.New(context.Background(), "community", cfg)
	if err != nil {
		return err
	}
	h := &handler{d: deps, push: push.ExpoSender{}, uploadDir: cfg.UploadDir}
	if err := os.MkdirAll(h.uploadDir, 0o755); err != nil {
		return fmt.Errorf("could not create upload dir %q: %w", h.uploadDir, err)
	}

	// Push sender: FCM when a service-account file is configured, else Expo relay.
	if cfg.FCMCredentialsFile != "" {
		if sa, err := os.ReadFile(cfg.FCMCredentialsFile); err != nil {
			deps.Log.Warn().Err(err).Msg("could not read FCM credentials, falling back to Expo push")
		} else if sender, err := push.NewFCMSender(sa); err != nil {
			deps.Log.Warn().Err(err).Msg("invalid FCM credentials, falling back to Expo push")
		} else {
			h.push = sender
			deps.Log.Info().Msg("push: using FCM HTTP v1")
		}
	}

	registerRoutes(deps, h)
	return deps.Run(config.ResolvePort("COMMUNITY_PORT", "8090"))
}

func registerRoutes(d *server.Deps, h *handler) {
	// Media is public: <Image> cannot send a bearer token, and filenames are
	// unguessable random hex.
	d.Engine.GET("/api/communities/media/:file", h.media)

	g := d.Engine.Group("/api/communities", d.JWT.Middleware())
	g.POST("", h.createCommunity)
	g.GET("", h.listCommunities)
	g.GET("/:id", h.getCommunity)

	g.POST("/:id/join", h.join)
	g.DELETE("/:id/leave", h.leave)
	g.GET("/:id/members", h.listMembers)
	g.POST("/:id/requests/:uid/approve", h.approveRequest)
	g.POST("/:id/requests/:uid/reject", h.rejectRequest)
	g.POST("/:id/members/:uid/promote", h.promote)
	g.POST("/:id/members/:uid/demote", h.demote)
	g.DELETE("/:id/members/:uid", h.kick)

	// "posts" and "comments" are literal segments, so they coexist with the
	// ":id" wildcard above (same trick as the feed's /posts/mine vs /posts/:id).
	g.GET("/:id/posts", h.listPosts)
	g.POST("/:id/posts", h.createPost)
	g.DELETE("/posts/:pid", h.deletePost)
	g.POST("/posts/:pid/like", h.likePost)
	g.DELETE("/posts/:pid/like", h.unlikePost)
	g.GET("/posts/:pid/comments", h.listComments)
	g.POST("/posts/:pid/comments", h.addComment)
	g.POST("/comments/:cid/like", h.likeComment)
	g.DELETE("/comments/:cid/like", h.unlikeComment)
	g.POST("/posts/:pid/vote", h.vote)
}

// Community is the API representation of a community, including the viewer's
// own membership (empty strings when the viewer is not a member).
type Community struct {
	ID           int64     `json:"id"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	Privacy      string    `json:"privacy"`
	AvatarURL    string    `json:"avatar_url"`
	CreatedBy    int64     `json:"created_by"`
	CreatedAt    time.Time `json:"created_at"`
	MemberCount  int64     `json:"member_count"`
	MyRole       string    `json:"my_role"`
	MyStatus     string    `json:"my_status"`
	PendingCount int64     `json:"pending_count,omitempty"`
}

type createCommunityReq struct {
	Name        string `json:"name" binding:"required,max=80"`
	Description string `json:"description" binding:"max=1000"`
	Privacy     string `json:"privacy" binding:"omitempty,oneof=public closed"`
}

func (h *handler) createCommunity(c *gin.Context) {
	var req createCommunityReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(c, "name is required")
		return
	}
	if req.Privacy == "" {
		req.Privacy = "public"
	}
	uid := authpkg.UserID(c)

	tx, err := h.d.DB.Begin(c)
	if err != nil {
		httpx.Internal(c, "could not create community")
		return
	}
	defer tx.Rollback(c)

	var cm Community
	err = tx.QueryRow(c,
		`INSERT INTO communities (name, description, privacy, created_by)
		 VALUES ($1, NULLIF($2, ''), $3, $4)
		 RETURNING id, name, COALESCE(description, ''), privacy, COALESCE(avatar_url, ''), created_by, created_at`,
		req.Name, req.Description, req.Privacy, uid,
	).Scan(&cm.ID, &cm.Name, &cm.Description, &cm.Privacy, &cm.AvatarURL, &cm.CreatedBy, &cm.CreatedAt)
	if err != nil {
		httpx.Internal(c, "could not create community")
		return
	}
	if _, err := tx.Exec(c,
		`INSERT INTO community_members (community_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
		cm.ID, uid,
	); err != nil {
		httpx.Internal(c, "could not create community")
		return
	}
	if err := tx.Commit(c); err != nil {
		httpx.Internal(c, "could not create community")
		return
	}

	cm.MemberCount = 1
	cm.MyRole = "owner"
	cm.MyStatus = "active"
	c.JSON(http.StatusCreated, cm)
}

// listCommunities returns communities for discovery (?q= trigram search) or
// only the viewer's own memberships (?mine=1), most popular first.
func (h *handler) listCommunities(c *gin.Context) {
	uid := authpkg.UserID(c)
	args := []any{uid}
	where := []string{}
	if q := strings.TrimSpace(c.Query("q")); q != "" {
		args = append(args, "%"+q+"%")
		where = append(where, fmt.Sprintf("c.name ILIKE $%d", len(args)))
	}
	if c.Query("mine") == "1" {
		where = append(where, "me.user_id IS NOT NULL")
	}
	cond := ""
	if len(where) > 0 {
		cond = " WHERE " + strings.Join(where, " AND ")
	}

	rows, err := h.d.DB.Query(c,
		`SELECT c.id, c.name, COALESCE(c.description, ''), c.privacy, COALESCE(c.avatar_url, ''),
		        c.created_by, c.created_at,
		        (SELECT COUNT(*) FROM community_members a WHERE a.community_id = c.id AND a.status = 'active'),
		        COALESCE(me.role, ''), COALESCE(me.status, '')
		 FROM communities c
		 LEFT JOIN community_members me ON me.community_id = c.id AND me.user_id = $1`+cond+`
		 ORDER BY 8 DESC, c.created_at DESC LIMIT 100`, args...)
	if err != nil {
		httpx.Internal(c, "could not load communities")
		return
	}
	defer rows.Close()

	list := make([]Community, 0)
	for rows.Next() {
		var cm Community
		if err := rows.Scan(&cm.ID, &cm.Name, &cm.Description, &cm.Privacy, &cm.AvatarURL,
			&cm.CreatedBy, &cm.CreatedAt, &cm.MemberCount, &cm.MyRole, &cm.MyStatus); err != nil {
			httpx.Internal(c, "could not read communities")
			return
		}
		list = append(list, cm)
	}
	c.JSON(http.StatusOK, gin.H{"communities": list})
}

func (h *handler) getCommunity(c *gin.Context) {
	id, ok := communityID(c)
	if !ok {
		return
	}
	uid := authpkg.UserID(c)

	var cm Community
	err := h.d.DB.QueryRow(c,
		`SELECT c.id, c.name, COALESCE(c.description, ''), c.privacy, COALESCE(c.avatar_url, ''),
		        c.created_by, c.created_at,
		        (SELECT COUNT(*) FROM community_members a WHERE a.community_id = c.id AND a.status = 'active'),
		        COALESCE(me.role, ''), COALESCE(me.status, '')
		 FROM communities c
		 LEFT JOIN community_members me ON me.community_id = c.id AND me.user_id = $2
		 WHERE c.id = $1`, id, uid,
	).Scan(&cm.ID, &cm.Name, &cm.Description, &cm.Privacy, &cm.AvatarURL,
		&cm.CreatedBy, &cm.CreatedAt, &cm.MemberCount, &cm.MyRole, &cm.MyStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "community not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load community")
		return
	}

	if isAdminRole(cm.MyRole) && cm.MyStatus == "active" {
		if err := h.d.DB.QueryRow(c,
			`SELECT COUNT(*) FROM community_members WHERE community_id = $1 AND status = 'pending'`, id,
		).Scan(&cm.PendingCount); err != nil {
			httpx.Internal(c, "could not load community")
			return
		}
	}
	c.JSON(http.StatusOK, cm)
}

func (h *handler) media(c *gin.Context) {
	file := c.Param("file")
	// Reject path traversal; filenames are plain hex + extension.
	if strings.ContainsAny(file, "/\\") || strings.Contains(file, "..") {
		c.Status(http.StatusBadRequest)
		return
	}
	c.File(filepath.Join(h.uploadDir, file))
}

// --- shared helpers ---

func isAdminRole(role string) bool { return role == "owner" || role == "admin" }

// membershipOf returns the caller's membership in a community; empty strings
// mean "not a member". The bool reports a query failure (already responded).
func (h *handler) membershipOf(c *gin.Context, communityID, userID int64) (role, status string, ok bool) {
	err := h.d.DB.QueryRow(c,
		`SELECT role, status FROM community_members WHERE community_id = $1 AND user_id = $2`,
		communityID, userID).Scan(&role, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", true
	}
	if err != nil {
		httpx.Internal(c, "could not check membership")
		return "", "", false
	}
	return role, status, true
}

// requireActiveMember responds 403 unless the caller is an active member.
func (h *handler) requireActiveMember(c *gin.Context, communityID int64) (role string, ok bool) {
	role, status, ok := h.membershipOf(c, communityID, authpkg.UserID(c))
	if !ok {
		return "", false
	}
	if status != "active" {
		httpx.Error(c, http.StatusForbidden, "you must be a member of this community")
		return "", false
	}
	return role, true
}

// requireAdmin responds 403 unless the caller is an active owner/admin.
func (h *handler) requireAdmin(c *gin.Context, communityID int64) (role string, ok bool) {
	role, status, ok := h.membershipOf(c, communityID, authpkg.UserID(c))
	if !ok {
		return "", false
	}
	if status != "active" || !isAdminRole(role) {
		httpx.Error(c, http.StatusForbidden, "only community admins can do this")
		return "", false
	}
	return role, true
}

// communityPrivacy loads a community's privacy, responding 404 when missing.
func (h *handler) communityPrivacy(c *gin.Context, id int64) (string, bool) {
	var privacy string
	err := h.d.DB.QueryRow(c, `SELECT privacy FROM communities WHERE id = $1`, id).Scan(&privacy)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "community not found")
		return "", false
	}
	if err != nil {
		httpx.Internal(c, "could not load community")
		return "", false
	}
	return privacy, true
}

// postCommunity resolves a post's community and author, responding 404 when
// the post does not exist.
func (h *handler) postCommunity(c *gin.Context, postID int64) (communityID, authorID int64, ok bool) {
	err := h.d.DB.QueryRow(c,
		`SELECT community_id, user_id FROM community_posts WHERE id = $1`, postID,
	).Scan(&communityID, &authorID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "post not found")
		return 0, 0, false
	}
	if err != nil {
		httpx.Internal(c, "could not load post")
		return 0, 0, false
	}
	return communityID, authorID, true
}

func communityID(c *gin.Context) (int64, bool) {
	return pathID(c, "id", "invalid community id")
}

func postIDParam(c *gin.Context) (int64, bool) {
	return pathID(c, "pid", "invalid post id")
}

func commentIDParam(c *gin.Context) (int64, bool) {
	return pathID(c, "cid", "invalid comment id")
}

func memberIDParam(c *gin.Context) (int64, bool) {
	return pathID(c, "uid", "invalid user id")
}

func pathID(c *gin.Context, param, msg string) (int64, bool) {
	id, err := strconv.ParseInt(c.Param(param), 10, 64)
	if err != nil {
		httpx.BadRequest(c, msg)
		return 0, false
	}
	return id, true
}

func randomName() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func normalizeExt(filename, contentType string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".jpg", ".jpeg":
		return ".jpg"
	case ".png":
		return ".png"
	case ".webp":
		return ".webp"
	case ".heic":
		return ".heic"
	}
	switch contentType {
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/heic":
		return ".heic"
	default:
		return ".jpg"
	}
}
