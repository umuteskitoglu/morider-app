package chat

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/morider/backend/pkg/httpx"
)

// maxBodyLen bounds a single chat message.
const maxBodyLen = 1000

// globalMsg is the wire shape of a global-chat message, for both the REST history
// and the WebSocket fan-out.
type globalMsg struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	Name      string    `json:"name"`
	AvatarURL string    `json:"avatar_url"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}

// globalMessages returns recent global-chat history, oldest-first. Pass ?before=
// (a message id) to page backwards.
func (h *handler) globalMessages(c *gin.Context) {
	limit := 50
	if v, err := strconv.Atoi(c.Query("limit")); err == nil && v > 0 && v <= 200 {
		limit = v
	}
	before := int64(0)
	if v, err := strconv.ParseInt(c.Query("before"), 10, 64); err == nil {
		before = v
	}

	rows, err := h.d.DB.Query(c,
		`SELECT m.id, m.user_id, u.name, COALESCE(u.avatar_url, ''), m.body, m.created_at
		 FROM global_messages m JOIN users u ON u.id = m.user_id
		 WHERE ($1 = 0 OR m.id < $1)
		 ORDER BY m.id DESC LIMIT $2`, before, limit)
	if err != nil {
		httpx.Internal(c, "could not load messages")
		return
	}
	defer rows.Close()

	msgs := make([]globalMsg, 0)
	for rows.Next() {
		var m globalMsg
		if err := rows.Scan(&m.ID, &m.UserID, &m.Name, &m.AvatarURL, &m.Body, &m.CreatedAt); err != nil {
			httpx.Internal(c, "could not read messages")
			return
		}
		msgs = append(msgs, m)
	}
	// Reverse to oldest-first so the client can append in order.
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	c.JSON(http.StatusOK, gin.H{"messages": msgs})
}

type wsBodyIn struct {
	Body string `json:"body"`
}

// globalWS streams the community chat. Inbound messages are slow-mode limited,
// persisted and fanned out to every connected client.
func (h *handler) globalWS(c *gin.Context) {
	claims, err := h.d.JWT.Parse(c.Query("token"))
	if err != nil {
		httpx.Error(c, http.StatusUnauthorized, "invalid token")
		return
	}
	me := claims.UserID

	var name, avatar string
	if err := h.d.DB.QueryRow(c, `SELECT name, COALESCE(avatar_url, '') FROM users WHERE id = $1`, me).Scan(&name, &avatar); err != nil {
		httpx.Internal(c, "could not load user")
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	client := &wsClient{send: make(chan []byte, 32), done: make(chan struct{})}
	h.globalHub.add(globalRoom, client)
	defer func() {
		h.globalHub.remove(globalRoom, client)
		close(client.done)
	}()

	go pumpWriter(conn, client)

	for {
		var in wsBodyIn
		if err := conn.ReadJSON(&in); err != nil {
			return
		}
		body := in.Body
		if len(body) == 0 || len(body) > maxBodyLen {
			continue
		}

		// Slow mode is enforced atomically: the row is inserted only when the user
		// hasn't posted within the window, so the check and the write can't race
		// across the user's connections/devices. No rows back = rejected.
		var (
			id        int64
			createdAt time.Time
		)
		err := h.d.DB.QueryRow(c,
			`INSERT INTO global_messages (user_id, body)
			 SELECT $1, $2
			 WHERE NOT EXISTS (
			     SELECT 1 FROM global_messages
			     WHERE user_id = $1 AND created_at > now() - make_interval(secs => $3))
			 RETURNING id, created_at`,
			me, body, h.slowmode.Seconds()).Scan(&id, &createdAt)
		if errors.Is(err, pgx.ErrNoRows) {
			wait := h.globalSlowmodeWait(c, me)
			h.sendFrame(client, gin.H{"type": "slowmode", "retry_after_ms": wait.Milliseconds()})
			continue
		}
		if err != nil {
			h.d.Log.Error().Err(err).Msg("could not persist global message")
			continue
		}
		msg := globalMsg{ID: id, UserID: me, Name: name, AvatarURL: avatar, Body: body, CreatedAt: createdAt}
		if data, err := json.Marshal(msg); err == nil {
			h.globalHub.publish(globalRoom, data)
		}
	}
}

// globalSlowmodeWait returns how long the user must wait before posting again, or
// zero if they may post now.
func (h *handler) globalSlowmodeWait(c *gin.Context, userID int64) time.Duration {
	if h.slowmode <= 0 {
		return 0
	}
	var last time.Time
	err := h.d.DB.QueryRow(c,
		`SELECT created_at FROM global_messages WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, userID).Scan(&last)
	if err != nil {
		return 0 // no previous message (or read failed): allow.
	}
	if elapsed := time.Since(last); elapsed < h.slowmode {
		return h.slowmode - elapsed
	}
	return 0
}

// sendFrame marshals and pushes a control frame to a single client.
func (h *handler) sendFrame(client *wsClient, payload gin.H) {
	if data, err := json.Marshal(payload); err == nil {
		select {
		case client.send <- data:
		case <-client.done:
		default:
		}
	}
}
