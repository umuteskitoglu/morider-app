package chat

import (
	"sync"

	"github.com/nats-io/nats.go"
)

// wsClient is a single chat WebSocket connection. Messages are pushed onto send;
// a dedicated writer goroutine drains it so the hub never touches the gorilla
// writer directly. done is closed on disconnect to stop that goroutine.
type wsClient struct {
	send chan []byte
	done chan struct{}
}

// roomHub fans messages out to the WebSocket clients of each "room". A room is
// identified by an int64 key: the global chat uses a single fixed key, while
// direct messages use the conversation id. subjectFor maps a key to its NATS
// subject.
//
// Within one replica it broadcasts locally; across replicas it relies on NATS.
// To keep delivery exactly-once, a local sender publishes to NATS and the
// per-room NATS subscription is the sole path that writes to local clients. When
// NATS is unavailable it falls back to a direct local broadcast, so a
// single-replica deployment still works. Mirrors telemetry's sessionHub and the
// event service's chatHub.
type roomHub struct {
	nats       *nats.Conn
	subjectFor func(int64) string
	mu         sync.Mutex
	subs       map[int64]*roomSub
}

type roomSub struct {
	clients map[*wsClient]struct{}
	natsSub *nats.Subscription
}

func newRoomHub(nc *nats.Conn, subjectFor func(int64) string) *roomHub {
	return &roomHub{nats: nc, subjectFor: subjectFor, subs: map[int64]*roomSub{}}
}

// add registers a client for a room, creating the per-room NATS subscription on
// the first client.
func (h *roomHub) add(room int64, c *wsClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.subs[room]
	if s == nil {
		s = &roomSub{clients: map[*wsClient]struct{}{}}
		h.subs[room] = s
		if h.nats != nil {
			if sub, err := h.nats.Subscribe(h.subjectFor(room), func(m *nats.Msg) {
				h.broadcastLocal(room, m.Data)
			}); err == nil {
				s.natsSub = sub
			}
		}
	}
	s.clients[c] = struct{}{}
}

// remove drops a client, tearing down the NATS subscription once the last client
// of a room disconnects.
func (h *roomHub) remove(room int64, c *wsClient) {
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

// publish delivers a message to every client of a room.
func (h *roomHub) publish(room int64, data []byte) {
	if h.nats != nil {
		_ = h.nats.Publish(h.subjectFor(room), data)
		return
	}
	h.broadcastLocal(room, data)
}

// broadcastLocal pushes data to the send channel of each local client. It never
// blocks: a slow client simply drops the frame.
func (h *roomHub) broadcastLocal(room int64, data []byte) {
	h.mu.Lock()
	s := h.subs[room]
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
