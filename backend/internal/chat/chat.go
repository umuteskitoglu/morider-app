// Package chat implements the community global chat room and one-to-one direct
// messages. It reuses the WebSocket + NATS fan-out "hub" pattern from the event
// and telemetry services.
package chat

import (
	"context"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
	"golang.org/x/time/rate"

	"github.com/morider/backend/internal/server"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/events"
	"github.com/morider/backend/pkg/push"
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

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type handler struct {
	d         *server.Deps
	nats      *nats.Conn
	push      push.Sender
	globalHub *roomHub
	dmHub     *roomHub

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
	h := &handler{
		d:          deps,
		push:       push.ExpoSender{},
		slowmode:   cfg.GlobalChatSlowmode,
		dmLimiters: map[int64]*rate.Limiter{},
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

	// NATS is optional: without it the service still works within a single replica.
	if nc, err := nats.Connect(cfg.NATSURL, nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1)); err != nil {
		deps.Log.Warn().Err(err).Msg("nats unavailable, continuing without fan-out")
	} else {
		h.nats = nc
	}
	h.globalHub = newRoomHub(h.nats, func(int64) string { return events.SubjectGlobalChat })
	h.dmHub = newRoomHub(h.nats, events.SubjectDMChat)

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

// pumpWriter drains a client's send channel onto the gorilla connection. It is
// the only place that writes to conn, so callers must not write elsewhere.
func pumpWriter(conn *websocket.Conn, client *wsClient) {
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
}
