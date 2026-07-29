// Package wshub is the shared WebSocket fan-out used by every real-time
// feature: group ride positions, global chat, direct messages and event chat.
//
// It previously existed as three near-identical copies (telemetry.sessionHub,
// chat.roomHub, event.chatHub). They drifted, and a fix applied to one did not
// reach the others — so it lives here once.
//
// Model: clients are grouped into rooms keyed by an int64 (a session id, a
// conversation id, or a single fixed key for the global room). Within one
// replica the hub broadcasts locally; across replicas it relies on NATS. To
// keep delivery exactly-once, a local sender publishes to NATS and the per-room
// NATS subscription is the sole path that writes to local clients. Without
// NATS it falls back to a direct local broadcast so single-replica deployments
// still work.
package wshub

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
)

// Connection liveness settings.
//
// A mobile client loses signal in tunnels, switches cell towers, and gets
// NAT-timed-out constantly. When that happens the TCP connection dies without a
// FIN and a blocking read never returns — leaking the read goroutine, the write
// goroutine, the socket and the hub entry, permanently. PongWait + the ping
// keepalive are what make a dead connection observable.
const (
	// PongWait is how long a connection may go without a pong before it is
	// considered dead.
	PongWait = 60 * time.Second
	// PingInterval must be meaningfully shorter than PongWait so a healthy
	// client always refreshes its deadline in time.
	PingInterval = (PongWait * 9) / 10
	// WriteWait bounds a single frame write, so a client that has stopped
	// reading (backgrounded app, full TCP window) cannot block the writer
	// goroutine forever.
	WriteWait = 10 * time.Second
	// DefaultSendBuffer is the per-client outbound queue depth.
	DefaultSendBuffer = 16
)

// Client is one WebSocket connection. Frames are pushed onto send; a dedicated
// writer goroutine drains it so the hub never touches the gorilla writer
// directly (gorilla connections are not safe for concurrent writes).
type Client struct {
	// UserID lets the hub target a specific user's sockets, which is what
	// makes a server-side kick actually disconnect them.
	UserID int64

	send chan []byte
	done chan struct{}
	once sync.Once
}

// NewClient builds a client for the given user.
func NewClient(userID int64, buffer int) *Client {
	if buffer <= 0 {
		buffer = DefaultSendBuffer
	}
	return &Client{
		UserID: userID,
		send:   make(chan []byte, buffer),
		done:   make(chan struct{}),
	}
}

// Close signals the connection to shut down. It is idempotent: the hub, the
// read loop's defer and the shutdown hook may all call it.
func (c *Client) Close() { c.once.Do(func() { close(c.done) }) }

// Done is closed when the client is shutting down.
func (c *Client) Done() <-chan struct{} { return c.done }

// TrySend queues a frame without ever blocking: a slow client drops the frame
// rather than stalling the broadcast. For position data a stale frame is
// worthless anyway, so dropping is strictly better than buffering.
func (c *Client) TrySend(data []byte) {
	select {
	case c.send <- data:
	case <-c.done:
	default:
	}
}

// SendJSON marshals and queues a control frame for this client alone.
func (c *Client) SendJSON(payload any) {
	if data, err := json.Marshal(payload); err == nil {
		c.TrySend(data)
	}
}

// ConfigureReader bounds inbound frames and arms the liveness deadline. Call it
// before the read loop. maxFrameBytes guards against a hostile client streaming
// one unbounded frame to exhaust memory.
func ConfigureReader(conn *websocket.Conn, maxFrameBytes int64) {
	conn.SetReadLimit(maxFrameBytes)
	_ = conn.SetReadDeadline(time.Now().Add(PongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(PongWait))
	})
}

// WritePump is the only goroutine that writes to conn. It drains the send
// queue, emits keepalive pings, and bounds every write with a deadline. It
// returns when the client is closed or a write fails.
func (c *Client) WritePump(conn *websocket.Conn) {
	ticker := time.NewTicker(PingInterval)
	defer ticker.Stop()
	for {
		select {
		case data := <-c.send:
			_ = conn.SetWriteDeadline(time.Now().Add(WriteWait))
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(WriteWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.done:
			// Best effort: tell the peer why, then let the caller close.
			_ = conn.SetWriteDeadline(time.Now().Add(WriteWait))
			_ = conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			return
		}
	}
}

// CloseOnDone closes the underlying connection once the client is closed
// server-side. Without it a hub-initiated disconnect could not interrupt a read
// loop already blocked in ReadJSON.
func (c *Client) CloseOnDone(conn *websocket.Conn) {
	go func() {
		<-c.done
		_ = conn.Close()
	}()
}

// OriginChecker builds a websocket.Upgrader CheckOrigin function.
//
// The native mobile client sends no Origin header at all, so an absent Origin
// is allowed; a browser always sends one, and it must be on the allow-list.
// Returning true unconditionally (the previous behaviour) disables cross-site
// WebSocket hijacking protection entirely.
func OriginChecker(allowed []string) func(*http.Request) bool {
	set := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		set[strings.ToLower(strings.TrimSpace(o))] = struct{}{}
	}
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // native client
		}
		if _, ok := set[strings.ToLower(origin)]; ok {
			return true
		}
		// Same-origin requests are always fine.
		if u, err := url.Parse(origin); err == nil && strings.EqualFold(u.Host, r.Host) {
			return true
		}
		return false
	}
}

// disconnectMsg is the cross-replica control frame for a forced disconnect.
type disconnectMsg struct {
	Room   int64 `json:"room"`
	UserID int64 `json:"user_id"`
}

type roomSub struct {
	clients map[*Client]struct{}
	natsSub *nats.Subscription
}

// Hub fans frames out to the clients of each room.
type Hub struct {
	nats       *nats.Conn
	subjectFor func(int64) string
	// controlSubject carries forced-disconnect commands to every replica. A
	// user kicked on replica A may hold their socket on replica B, so the
	// disconnect has to travel.
	controlSubject string

	mu   sync.Mutex
	subs map[int64]*roomSub
	ctrl *nats.Subscription
}

// New builds a hub. nc may be nil (single-replica / NATS down), in which case
// everything degrades to local-only broadcast. controlSubject may be empty to
// disable cross-replica disconnects.
func New(nc *nats.Conn, subjectFor func(int64) string, controlSubject string) *Hub {
	h := &Hub{
		nats:           nc,
		subjectFor:     subjectFor,
		controlSubject: controlSubject,
		subs:           map[int64]*roomSub{},
	}
	if nc != nil && controlSubject != "" {
		if sub, err := nc.Subscribe(controlSubject, func(m *nats.Msg) {
			var msg disconnectMsg
			if err := json.Unmarshal(m.Data, &msg); err == nil {
				h.disconnectLocal(msg.Room, msg.UserID)
			}
		}); err == nil {
			h.ctrl = sub
		}
	}
	return h
}

// Add registers a client for a room, creating the per-room NATS subscription on
// the first client.
func (h *Hub) Add(room int64, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.subs[room]
	if s == nil {
		s = &roomSub{clients: map[*Client]struct{}{}}
		h.subs[room] = s
		if h.nats != nil {
			if sub, err := h.nats.Subscribe(h.subjectFor(room), func(m *nats.Msg) {
				h.BroadcastLocal(room, m.Data)
			}); err == nil {
				s.natsSub = sub
			}
		}
	}
	s.clients[c] = struct{}{}
}

// Remove drops a client, tearing down the room's NATS subscription once the
// last client disconnects.
func (h *Hub) Remove(room int64, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.subs[room]
	if s == nil {
		return
	}
	delete(s.clients, c)
	if len(s.clients) == 0 {
		if s.natsSub != nil {
			_ = s.natsSub.Unsubscribe()
		}
		delete(h.subs, room)
	}
}

// Publish delivers a frame to every client of a room, across all replicas.
func (h *Hub) Publish(room int64, data []byte) {
	if h.nats != nil {
		if err := h.nats.Publish(h.subjectFor(room), data); err == nil {
			return
		}
	}
	h.BroadcastLocal(room, data)
}

// PublishJSON marshals and publishes a frame.
func (h *Hub) PublishJSON(room int64, payload any) {
	if data, err := json.Marshal(payload); err == nil {
		h.Publish(room, data)
	}
}

// BroadcastLocal pushes data to this replica's clients for a room.
func (h *Hub) BroadcastLocal(room int64, data []byte) {
	h.mu.Lock()
	s := h.subs[room]
	if s == nil {
		h.mu.Unlock()
		return
	}
	clients := make([]*Client, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		c.TrySend(data)
	}
}

// DisconnectUser force-closes every socket a user holds in a room, on every
// replica. This is the enforcement half of a kick or ban: publishing a "kick"
// frame and trusting the client to disconnect itself leaves a modified client
// subscribed to the room's live GPS indefinitely.
//
// The local disconnect happens unconditionally rather than only via the NATS
// round-trip, so revoking access never depends on the message bus being up.
func (h *Hub) DisconnectUser(room, userID int64) {
	h.disconnectLocal(room, userID)
	if h.nats != nil && h.controlSubject != "" {
		if data, err := json.Marshal(disconnectMsg{Room: room, UserID: userID}); err == nil {
			_ = h.nats.Publish(h.controlSubject, data)
		}
	}
}

// DisconnectRoom force-closes every socket in a room (e.g. the session ended).
func (h *Hub) DisconnectRoom(room int64) {
	h.disconnectLocal(room, 0)
	if h.nats != nil && h.controlSubject != "" {
		if data, err := json.Marshal(disconnectMsg{Room: room, UserID: 0}); err == nil {
			_ = h.nats.Publish(h.controlSubject, data)
		}
	}
}

// disconnectLocal closes matching clients on this replica. userID == 0 means
// every client in the room.
func (h *Hub) disconnectLocal(room, userID int64) {
	h.mu.Lock()
	s := h.subs[room]
	if s == nil {
		h.mu.Unlock()
		return
	}
	targets := make([]*Client, 0, len(s.clients))
	for c := range s.clients {
		if userID == 0 || c.UserID == userID {
			targets = append(targets, c)
		}
	}
	h.mu.Unlock()

	// Closed outside the lock: Close wakes the read loop, whose defer calls
	// Remove, which takes the same mutex.
	for _, c := range targets {
		c.Close()
	}
}

// CloseAll disconnects every client. Registered as a shutdown hook so hijacked
// WebSocket connections are torn down during a graceful stop instead of hanging
// until their read deadline expires.
func (h *Hub) CloseAll() {
	h.mu.Lock()
	if h.ctrl != nil {
		_ = h.ctrl.Unsubscribe()
		h.ctrl = nil
	}
	targets := make([]*Client, 0, len(h.subs))
	for _, s := range h.subs {
		for c := range s.clients {
			targets = append(targets, c)
		}
	}
	h.mu.Unlock()

	for _, c := range targets {
		c.Close()
	}
}
