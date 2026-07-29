package event

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
	"github.com/morider/backend/pkg/wshub"
)

// upgrader is built in Run once the config is known, so the Origin allow-list
// can come from the environment.
var upgrader websocket.Upgrader

// maxChatFrame bounds a single inbound chat frame.
const maxChatFrame = 16 << 10

// chatMessage is the wire shape of a single chat message, both for the REST
// history endpoint and the WebSocket fan-out.
type chatMessage struct {
	ID        int64     `json:"id"`
	EventID   int64     `json:"event_id"`
	UserID    int64     `json:"user_id"`
	Name      string    `json:"name"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}

// messages returns recent chat history for an event, oldest-first. Pass ?before=
// (a message id) to page backwards through older messages.
func (h *handler) messages(c *gin.Context) {
	var eventID int64
	if err := h.d.DB.QueryRow(c, `SELECT id FROM events WHERE code = $1`, c.Param("code")).Scan(&eventID); errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "event not found")
		return
	} else if err != nil {
		httpx.Internal(c, "could not load event")
		return
	}

	// Only participants may read the chat history — same rule the WebSocket
	// enforces, so the REST history can't leak around it.
	var isParticipant bool
	if err := h.d.DB.QueryRow(c,
		`SELECT EXISTS(SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2)`,
		eventID, authpkg.UserID(c)).Scan(&isParticipant); err != nil {
		httpx.Internal(c, "could not verify participant")
		return
	}
	if !isParticipant {
		httpx.Error(c, http.StatusForbidden, "join the event to see chat")
		return
	}

	limit := 50
	if v, err := strconv.Atoi(c.Query("limit")); err == nil && v > 0 && v <= 200 {
		limit = v
	}
	before := int64(0)
	if v, err := strconv.ParseInt(c.Query("before"), 10, 64); err == nil {
		before = v
	}

	// Fetch the newest `limit` rows (optionally older than `before`), then return
	// them oldest-first so the client can append in order.
	rows, err := h.d.DB.Query(c,
		`SELECT m.id, m.user_id, u.name, m.body, m.created_at
		 FROM event_messages m JOIN users u ON u.id = m.user_id
		 WHERE m.event_id = $1 AND ($2 = 0 OR m.id < $2)
		 ORDER BY m.id DESC LIMIT $3`, eventID, before, limit)
	if err != nil {
		httpx.Internal(c, "could not load messages")
		return
	}
	defer rows.Close()

	msgs := make([]chatMessage, 0)
	for rows.Next() {
		var m chatMessage
		m.EventID = eventID
		if err := rows.Scan(&m.ID, &m.UserID, &m.Name, &m.Body, &m.CreatedAt); err != nil {
			httpx.Internal(c, "could not read messages")
			return
		}
		msgs = append(msgs, m)
	}
	// Reverse to oldest-first.
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	c.JSON(http.StatusOK, gin.H{"messages": msgs})
}

type wsMessageIn struct {
	Body string `json:"body"`
}

// chatWS streams the event chat. The caller must be a participant. Inbound
// messages are persisted and fanned out to every connected participant.
func (h *handler) chatWS(c *gin.Context) {
	claims, err := h.d.JWT.Parse(c.Query("token"))
	if err != nil {
		httpx.Error(c, http.StatusUnauthorized, "invalid token")
		return
	}
	me := claims.UserID
	code := c.Param("code")

	var eventID int64
	var status string
	err = h.d.DB.QueryRow(c, `SELECT id, status FROM events WHERE code = $1`, code).Scan(&eventID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "event not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load event")
		return
	}

	var isParticipant bool
	if err := h.d.DB.QueryRow(c,
		`SELECT EXISTS(SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2)`,
		eventID, me).Scan(&isParticipant); err != nil {
		httpx.Internal(c, "could not verify participant")
		return
	}
	if !isParticipant {
		httpx.Error(c, http.StatusForbidden, "join the event to chat")
		return
	}

	var name string
	if err := h.d.DB.QueryRow(c, `SELECT name FROM users WHERE id = $1`, me).Scan(&name); err != nil {
		httpx.Internal(c, "could not load user")
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	// Bound inbound frames and arm the liveness deadline: without them a
	// connection dropped by a NAT timeout blocks this read loop forever, leaking
	// the goroutine, the socket and the hub entry.
	wshub.ConfigureReader(conn, maxChatFrame)

	client := wshub.NewClient(me, 32)
	h.hub.Add(eventID, client)
	defer func() {
		h.hub.Remove(eventID, client)
		client.Close()
	}()
	client.CloseOnDone(conn)

	go client.WritePump(conn)

	// Read loop: persist each message, then fan it out to the event.
	for {
		var in wsMessageIn
		if err := conn.ReadJSON(&in); err != nil {
			return
		}
		body := in.Body
		if len(body) == 0 || len(body) > 2000 {
			continue
		}
		var (
			id        int64
			createdAt time.Time
		)
		if err := h.d.DB.QueryRow(c,
			`INSERT INTO event_messages (event_id, user_id, body) VALUES ($1, $2, $3)
			 RETURNING id, created_at`, eventID, me, body).Scan(&id, &createdAt); err != nil {
			h.d.Log.Error().Err(err).Msg("could not persist chat message")
			continue
		}
		h.hub.PublishJSON(eventID, chatMessage{
			ID: id, EventID: eventID, UserID: me, Name: name, Body: body, CreatedAt: createdAt,
		})
	}
}
