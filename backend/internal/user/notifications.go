package user

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// The bildirim merkezi read API.
//
// It lives in the user service rather than a service of its own: user already
// owns push_tokens, follows and user_blocks, so a per-rider inbox belongs next
// to them. Producers in other services do not call this API — they write rows
// directly through pkg/notify against the shared database. The boundary here is
// a read boundary, nothing more.

// defaultNotificationLimit/maxNotificationLimit bound one page of the list.
const (
	defaultNotificationLimit = 30
	maxNotificationLimit     = 50
)

func registerNotificationRoutes(d *server.Deps, h *handler) {
	n := d.Engine.Group("/api/notifications", d.JWT.Middleware())
	n.GET("", h.listNotifications)
	n.GET("/unread-count", h.unreadCount)
	// Static "read"/"read-all" coexist with the ":id" wildcard: Gin matches
	// literal segments first (same trick as the feed's /posts/mine vs /posts/:id).
	n.POST("/read", h.markReadByEntity)
	n.POST("/read-all", h.markAllRead)
	n.POST("/:id/read", h.markRead)
}

// Notification is one row of the rider's bildirim merkezi.
type Notification struct {
	ID          int64          `json:"id"`
	Type        string         `json:"type"`
	ActorID     *int64         `json:"actor_id"`
	ActorName   string         `json:"actor_name"`
	ActorAvatar string         `json:"actor_avatar"`
	EntityID    *int64         `json:"entity_id"`
	Title       string         `json:"title"`
	Body        string         `json:"body"`
	Data        map[string]any `json:"data"`
	EventCount  int            `json:"event_count"`
	Read        bool           `json:"read"`
	CreatedAt   time.Time      `json:"created_at"`
}

// listNotifications returns a page of the caller's notifications, newest first.
//
// Pagination is keyset on id (?before=<id>) rather than an offset: the list
// grows at the head while you are reading it, and an offset would silently skip
// or repeat rows.
func (h *handler) listNotifications(c *gin.Context) {
	before, err := strconv.ParseInt(c.DefaultQuery("before", "0"), 10, 64)
	if err != nil || before < 0 {
		httpx.BadRequest(c, "invalid before cursor")
		return
	}
	limit := defaultNotificationLimit
	if raw := c.Query("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			httpx.BadRequest(c, "invalid limit")
			return
		}
		if n > maxNotificationLimit {
			n = maxNotificationLimit
		}
		limit = n
	}

	// The actor's name and avatar are resolved at read time, so a rider who
	// renamed themselves or changed their photo renders correctly in history.
	rows, err := h.d.DB.Query(c,
		`SELECT n.id, n.type, n.actor_id, COALESCE(u.name, ''), COALESCE(u.avatar_url, ''),
		        n.entity_id, n.title, n.body, n.data, n.event_count,
		        (n.read_at IS NOT NULL), n.created_at
		 FROM notifications n
		 LEFT JOIN users u ON u.id = n.actor_id
		 WHERE n.user_id = $1 AND ($2 = 0 OR n.id < $2)
		 ORDER BY n.id DESC
		 LIMIT $3`,
		authpkg.UserID(c), before, limit)
	if err != nil {
		httpx.Internal(c, "could not load notifications")
		return
	}
	defer rows.Close()

	list := make([]Notification, 0, limit)
	for rows.Next() {
		var n Notification
		var raw []byte
		if err := rows.Scan(&n.ID, &n.Type, &n.ActorID, &n.ActorName, &n.ActorAvatar,
			&n.EntityID, &n.Title, &n.Body, &raw, &n.EventCount, &n.Read, &n.CreatedAt); err != nil {
			httpx.Internal(c, "could not read notifications")
			return
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &n.Data)
		}
		if n.Data == nil {
			n.Data = map[string]any{}
		}
		list = append(list, n)
	}
	c.JSON(http.StatusOK, gin.H{"notifications": list})
}

// unreadCount backs the bell badge. Every signed-in device polls it, so it is
// deliberately the cheapest query in this file (partial index on user_id).
func (h *handler) unreadCount(c *gin.Context) {
	var count int64
	if err := h.d.DB.QueryRow(c,
		`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
		authpkg.UserID(c)).Scan(&count); err != nil {
		httpx.Internal(c, "could not count notifications")
		return
	}
	c.JSON(http.StatusOK, gin.H{"unread_count": count})
}

// markRead clears one notification.
func (h *handler) markRead(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid notification id")
		return
	}
	var marked int64
	err = h.d.DB.QueryRow(c,
		`UPDATE notifications SET read_at = now(), updated_at = now()
		 WHERE id = $1 AND user_id = $2 AND read_at IS NULL
		 RETURNING id`, id, authpkg.UserID(c)).Scan(&marked)
	if errors.Is(err, pgx.ErrNoRows) {
		// Already read, or not yours. Either way there is nothing to clear.
		httpx.Error(c, http.StatusNotFound, "notification not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not mark notification read")
		return
	}
	c.Status(http.StatusNoContent)
}

type markEntityReq struct {
	Type     string `json:"type" binding:"required,max=40"`
	EntityID int64  `json:"entity_id"`
}

// markReadByEntity clears everything the caller has about one thing.
//
// This is what a tapped push calls: the push payload deliberately carries no
// notification id (with fan-out the row id differs per recipient while the push
// body is shared), so the client clears by what the notification pointed at.
func (h *handler) markReadByEntity(c *gin.Context) {
	var req markEntityReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	tag, err := h.d.DB.Exec(c,
		`UPDATE notifications SET read_at = now(), updated_at = now()
		 WHERE user_id = $1 AND type = $2 AND entity_id = NULLIF($3, 0::bigint) AND read_at IS NULL`,
		authpkg.UserID(c), req.Type, req.EntityID)
	if err != nil {
		httpx.Internal(c, "could not mark notifications read")
		return
	}
	c.JSON(http.StatusOK, gin.H{"marked": tag.RowsAffected()})
}

// markAllRead empties the bell.
func (h *handler) markAllRead(c *gin.Context) {
	tag, err := h.d.DB.Exec(c,
		`UPDATE notifications SET read_at = now(), updated_at = now()
		 WHERE user_id = $1 AND read_at IS NULL`, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not mark notifications read")
		return
	}
	c.JSON(http.StatusOK, gin.H{"marked": tag.RowsAffected()})
}
