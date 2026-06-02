package event

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/events"
	"github.com/morider/backend/pkg/httpx"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

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

	client := &wsClient{send: make(chan []byte, 32), done: make(chan struct{})}
	h.hub.add(eventID, client)
	defer func() {
		h.hub.remove(eventID, client)
		close(client.done)
	}()

	// Writer goroutine: the only place that writes to the gorilla connection.
	go func() {
		for {
			select {
			case data := <-client.send:
				if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
					return
				}
			case <-client.done:
				return
			}
		}
	}()

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
		msg := chatMessage{ID: id, EventID: eventID, UserID: me, Name: name, Body: body, CreatedAt: createdAt}
		if data, err := json.Marshal(msg); err == nil {
			h.hub.publish(eventID, data)
		}
	}
}

// wsClient is a single chat WebSocket connection. Messages are pushed onto send;
// a dedicated writer goroutine drains it so the hub never touches the gorilla
// writer directly. done is closed on disconnect to stop that goroutine.
type wsClient struct {
	send chan []byte
	done chan struct{}
}

// chatHub fans chat messages out to the WebSocket clients of each event.
//
// Within one replica it broadcasts locally; across replicas it relies on NATS.
// To keep delivery exactly-once, a local sender publishes to NATS and the
// per-event NATS subscription is the sole path that writes to local clients.
// When NATS is unavailable it falls back to a direct local broadcast, so a
// single-replica deployment still works. Mirrors telemetry's sessionHub.
type chatHub struct {
	nats *nats.Conn
	mu   sync.Mutex
	subs map[int64]*chatSub
}

type chatSub struct {
	clients map[*wsClient]struct{}
	natsSub *nats.Subscription
}

func newChatHub(nc *nats.Conn) *chatHub {
	return &chatHub{nats: nc, subs: map[int64]*chatSub{}}
}

// add registers a client for an event, creating the per-event NATS subscription
// on the first client.
func (h *chatHub) add(eventID int64, c *wsClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.subs[eventID]
	if s == nil {
		s = &chatSub{clients: map[*wsClient]struct{}{}}
		h.subs[eventID] = s
		if h.nats != nil {
			if sub, err := h.nats.Subscribe(events.SubjectEventChat(eventID), func(m *nats.Msg) {
				h.broadcastLocal(eventID, m.Data)
			}); err == nil {
				s.natsSub = sub
			}
		}
	}
	s.clients[c] = struct{}{}
}

// remove drops a client, tearing down the NATS subscription once the last client
// of an event disconnects.
func (h *chatHub) remove(eventID int64, c *wsClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.subs[eventID]
	if s == nil {
		return
	}
	delete(s.clients, c)
	if len(s.clients) == 0 {
		if s.natsSub != nil {
			_ = s.natsSub.Unsubscribe()
		}
		delete(h.subs, eventID)
	}
}

// publish delivers a message to every participant of an event.
func (h *chatHub) publish(eventID int64, data []byte) {
	if h.nats != nil {
		_ = h.nats.Publish(events.SubjectEventChat(eventID), data)
		return
	}
	h.broadcastLocal(eventID, data)
}

// broadcastLocal pushes data to the send channel of each local client. It never
// blocks: a slow client simply drops the frame.
func (h *chatHub) broadcastLocal(eventID int64, data []byte) {
	h.mu.Lock()
	s := h.subs[eventID]
	if s == nil {
		h.mu.Unlock()
		return
	}
	clients := make([]*wsClient, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		select {
		case c.send <- data:
		case <-c.done:
		default:
		}
	}
}
