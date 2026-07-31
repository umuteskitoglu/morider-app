// Package chat implements the community global chat room and one-to-one direct
// messages. It reuses the WebSocket + NATS fan-out "hub" pattern from the event
// and telemetry services.
package chat

import (
	"context"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
	"golang.org/x/time/rate"

	"github.com/morider/backend/internal/server"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/events"
	"github.com/morider/backend/pkg/notify"
	"github.com/morider/backend/pkg/wshub"
)

// globalRoom is the single fixed room key used for the community-wide chat. Its
// NATS subject is constant, unlike direct-message rooms keyed by conversation id.
const globalRoom int64 = 0

// dmRateEvery/dmRateBurst bound how fast a single user may send direct messages.
// DMs have no slow mode (they must feel instant), but this token bucket still
// stops a client from flooding a conversation.
const (
	dmRateEvery = 200 * time.Millisecond // ~5 messages/second sustained
	dmRateBurst = 10
)

// upgrader is built in Run once the config is known, so the Origin allow-list
// can come from the environment.
var upgrader websocket.Upgrader

// maxChatFrame bounds a single inbound chat frame. Message bodies are capped
// well below this; the limit stops a client streaming an unbounded frame.
const maxChatFrame = 16 << 10

type handler struct {
	d         *server.Deps
	nats      *nats.Conn
	notifier  *notify.Notifier
	globalHub *wshub.Hub
	dmHub     *wshub.Hub

	// slowmode is the minimum interval between two global-chat messages from the
	// same user.
	slowmode time.Duration

	// dmLimiters holds one token-bucket limiter per user for direct messages.
	// dmPresence tracks which users have a conversation open on this replica, so
	// a message to a user actively viewing the thread skips the push. Both are
	// guarded by mu.
	mu         sync.Mutex
	dmLimiters map[int64]*rate.Limiter
	dmPresence map[int64]map[int64]int
}

// Run boots the chat service.
func Run(cfg config.Config) error {
	deps, err := server.New(context.Background(), "chat", cfg)
	if err != nil {
		return err
	}
	upgrader = websocket.Upgrader{CheckOrigin: wshub.OriginChecker(cfg.AllowedWSOrigins)}

	h := &handler{
		d:          deps,
		notifier:   notify.New(deps.DB, cfg, deps.Log),
		slowmode:   cfg.GlobalChatSlowmode,
		dmLimiters: map[int64]*rate.Limiter{},
	}

	// NATS is optional: without it the service still works within a single replica.
	if nc, err := nats.Connect(cfg.NATSURL, nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1)); err != nil {
		deps.Log.Warn().Err(err).Msg("nats unavailable, continuing without fan-out")
	} else {
		h.nats = nc
	}
	h.globalHub = wshub.New(h.nats, func(int64) string { return events.SubjectGlobalChat }, events.SubjectChatDisconnect)
	h.dmHub = wshub.New(h.nats, events.SubjectDMChat, "")
	deps.AddCloser(h.globalHub.CloseAll)
	deps.AddCloser(h.dmHub.CloseAll)

	registerRoutes(deps, h)
	return deps.Run(config.ResolvePort("CHAT_PORT", "8089"))
}

func registerRoutes(d *server.Deps, h *handler) {
	jwt := d.JWT.Middleware()

	// Global chat. WebSocket auth uses ?token= because browsers cannot set
	// custom headers, so JWT is applied per-route rather than on the group.
	g := d.Engine.Group("/api/chat")
	g.GET("/global/messages", jwt, h.globalMessages)
	g.GET("/global/ws", h.globalWS)

	// Direct messages. :id is the target user id for the start endpoint (POST
	// /api/dm) and the conversation id for every /:id/* route.
	dm := d.Engine.Group("/api/dm")
	dm.GET("", jwt, h.listConversations)
	dm.POST("", jwt, h.startConversation)
	dm.GET("/:id/messages", jwt, h.dmMessages)
	dm.POST("/:id/accept", jwt, h.acceptConversation)
	dm.POST("/:id/decline", jwt, h.declineConversation)
	dm.GET("/:id/ws", h.dmWS)
}

// dmLimiter returns the per-user direct-message limiter, creating it on first use.
func (h *handler) dmLimiter(userID int64) *rate.Limiter {
	h.mu.Lock()
	defer h.mu.Unlock()
	l := h.dmLimiters[userID]
	if l == nil {
		l = rate.NewLimiter(rate.Every(dmRateEvery), dmRateBurst)
		h.dmLimiters[userID] = l
	}
	return l
}

// serveClient wires the shared liveness handling onto a freshly upgraded
// connection: bounded frames, read deadline with ping/pong keepalive, a single
// writer goroutine, and a watchdog so a server-side close interrupts a blocked
// read. Callers must not write to conn themselves.
func serveClient(conn *websocket.Conn, client *wshub.Client) {
	wshub.ConfigureReader(conn, maxChatFrame)
	client.CloseOnDone(conn)
	go client.WritePump(conn)
}
