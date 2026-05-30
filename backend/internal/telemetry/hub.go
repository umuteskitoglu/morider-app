package telemetry

import (
	"sync"

	"github.com/nats-io/nats.go"

	"github.com/morider/backend/pkg/events"
)

// wsClient is a single session WebSocket connection. Positions are pushed onto
// send; a dedicated writer goroutine drains it so the hub never touches the
// gorilla writer directly. done is closed on disconnect to stop that goroutine.
type wsClient struct {
	send chan []byte
	done chan struct{}
}

// sessionHub fans live positions out to the WebSocket clients of each session.
//
// Within one replica it broadcasts locally; across replicas it relies on NATS.
// To keep delivery exactly-once, a local sender publishes to NATS and the
// per-session NATS subscription is the *sole* path that writes to local clients.
// When NATS is unavailable it falls back to a direct local broadcast, so a
// single-replica deployment still works.
type sessionHub struct {
	nats *nats.Conn
	mu   sync.Mutex
	subs map[int64]*sessionSub
}

type sessionSub struct {
	clients map[*wsClient]struct{}
	natsSub *nats.Subscription
}

func newSessionHub(nc *nats.Conn) *sessionHub {
	return &sessionHub{nats: nc, subs: map[int64]*sessionSub{}}
}

// add registers a client for a session, creating the per-session NATS
// subscription on the first client.
func (h *sessionHub) add(sessionID int64, c *wsClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.subs[sessionID]
	if s == nil {
		s = &sessionSub{clients: map[*wsClient]struct{}{}}
		h.subs[sessionID] = s
		if h.nats != nil {
			if sub, err := h.nats.Subscribe(events.SubjectSessionPositions(sessionID), func(m *nats.Msg) {
				h.broadcastLocal(sessionID, m.Data)
			}); err == nil {
				s.natsSub = sub
			}
		}
	}
	s.clients[c] = struct{}{}
}

// remove drops a client, tearing down the NATS subscription once the last client
// of a session disconnects.
func (h *sessionHub) remove(sessionID int64, c *wsClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.subs[sessionID]
	if s == nil {
		return
	}
	delete(s.clients, c)
	if len(s.clients) == 0 {
		if s.natsSub != nil {
			_ = s.natsSub.Unsubscribe()
		}
		delete(h.subs, sessionID)
	}
}

// publish delivers a position to every participant of a session.
func (h *sessionHub) publish(sessionID int64, data []byte) {
	if h.nats != nil {
		_ = h.nats.Publish(events.SubjectSessionPositions(sessionID), data)
		return
	}
	h.broadcastLocal(sessionID, data)
}

// broadcastLocal pushes data to the send channel of each local client. It never
// blocks: a slow client simply drops the frame.
func (h *sessionHub) broadcastLocal(sessionID int64, data []byte) {
	h.mu.Lock()
	s := h.subs[sessionID]
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
