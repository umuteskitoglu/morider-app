package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
	"github.com/morider/backend/pkg/push"
)

// maxPendingRequestMsgs caps how many messages a requester may send into a
// not-yet-accepted conversation, so a stranger can't flood the request inbox.
const maxPendingRequestMsgs = 5

// conversation is the internal representation of a 1:1 conversation row.
type conversation struct {
	id          int64
	userA       int64 // always < userB
	userB       int64
	status      string
	requestedBy int64
}

func (cv conversation) has(userID int64) bool { return cv.userA == userID || cv.userB == userID }

func (cv conversation) other(userID int64) int64 {
	if cv.userA == userID {
		return cv.userB
	}
	return cv.userA
}

// loadConversation reads a conversation by id.
func (h *handler) loadConversation(ctx context.Context, id int64) (conversation, error) {
	var cv conversation
	err := h.d.DB.QueryRow(ctx,
		`SELECT id, user_a, user_b, status, requested_by FROM conversations WHERE id = $1`, id).
		Scan(&cv.id, &cv.userA, &cv.userB, &cv.status, &cv.requestedBy)
	return cv, err
}

type startReq struct {
	UserID int64 `json:"user_id" binding:"required"`
}

// startConversation finds or creates the conversation between the caller and the
// target user. If they mutually follow it is created already accepted; otherwise
// it starts as a pending request that only the caller may write to until the
// other side accepts. Returns the existing conversation unchanged if one exists.
func (h *handler) startConversation(c *gin.Context) {
	var req startReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	me := authpkg.UserID(c)
	if req.UserID == me {
		httpx.BadRequest(c, "cannot message yourself")
		return
	}

	var exists bool
	if err := h.d.DB.QueryRow(c, `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, req.UserID).Scan(&exists); err != nil {
		httpx.Internal(c, "could not load user")
		return
	}
	if !exists {
		httpx.Error(c, http.StatusNotFound, "user not found")
		return
	}

	blocked, err := h.blocked(c, me, req.UserID)
	if err != nil {
		httpx.Internal(c, "could not verify block")
		return
	}
	if blocked {
		httpx.Error(c, http.StatusForbidden, "blocked")
		return
	}

	a, b := me, req.UserID
	if a > b {
		a, b = b, a
	}
	mutual, err := h.areMutual(c, me, req.UserID)
	if err != nil {
		httpx.Internal(c, "could not verify follow")
		return
	}
	status := "pending"
	if mutual {
		status = "accepted"
	}

	var (
		convID     int64
		convStatus string
	)
	// On conflict keep the existing row (status/requester) and just touch it —
	// except a conversation the *other* party previously declined can be reopened
	// when the decliner reaches out (the original requester stays blocked).
	if err := h.d.DB.QueryRow(c,
		`INSERT INTO conversations (user_a, user_b, status, requested_by) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (user_a, user_b) DO UPDATE SET
		     updated_at = now(),
		     status = CASE
		         WHEN conversations.status = 'declined' AND conversations.requested_by <> $4 THEN excluded.status
		         ELSE conversations.status
		     END,
		     requested_by = CASE
		         WHEN conversations.status = 'declined' AND conversations.requested_by <> $4 THEN excluded.requested_by
		         ELSE conversations.requested_by
		     END
		 RETURNING id, status`, a, b, status, me).Scan(&convID, &convStatus); err != nil {
		httpx.Internal(c, "could not start conversation")
		return
	}
	c.JSON(http.StatusOK, gin.H{"conversation_id": convID, "status": convStatus})
}

// areMutual reports whether a and b follow each other.
func (h *handler) areMutual(ctx context.Context, a, b int64) (bool, error) {
	var mutual bool
	err := h.d.DB.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2)
		    AND EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = $1)`,
		a, b).Scan(&mutual)
	return mutual, err
}

// blocked reports whether a has blocked b or b has blocked a, in either
// direction — a block always stops contact both ways.
func (h *handler) blocked(ctx context.Context, a, b int64) (bool, error) {
	var block bool
	err := h.d.DB.QueryRow(ctx,
		`SELECT EXISTS(
		    SELECT 1 FROM user_blocks
		    WHERE (blocker_id = $1 AND blocked_id = $2)
		       OR (blocker_id = $2 AND blocked_id = $1))`,
		a, b).Scan(&block)
	return block, err
}

type conversationItem struct {
	ConversationID int64        `json:"conversation_id"`
	OtherUser      converseUser `json:"other_user"`
	Status         string       `json:"status"`
	IsRequest      bool         `json:"is_request"`
	LastMessage    *lastMessage `json:"last_message"`
	UnreadCount    int64        `json:"unread_count"`
}

type converseUser struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

type lastMessage struct {
	Body      string    `json:"body"`
	SenderID  int64     `json:"sender_id"`
	CreatedAt time.Time `json:"created_at"`
}

// listConversations returns the caller's conversations, newest activity first.
// The client splits them into "primary" and "requests" using is_request
// (a pending conversation the caller did not start). Declined ones are hidden.
func (h *handler) listConversations(c *gin.Context) {
	me := authpkg.UserID(c)
	rows, err := h.d.DB.Query(c,
		`SELECT c.id, c.status, c.requested_by,
		        ou.id, ou.name, COALESCE(ou.avatar_url, ''),
		        lm.body, lm.sender_id, lm.created_at,
		        (SELECT COUNT(*) FROM direct_messages d
		         WHERE d.conversation_id = c.id AND d.sender_id <> $1 AND d.read_at IS NULL)
		 FROM conversations c
		 JOIN users ou ON ou.id = CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END
		 LEFT JOIN LATERAL (
		     SELECT body, sender_id, created_at FROM direct_messages d
		     WHERE d.conversation_id = c.id ORDER BY d.id DESC LIMIT 1
		 ) lm ON true
		 WHERE (c.user_a = $1 OR c.user_b = $1) AND c.status <> 'declined'
		 ORDER BY COALESCE(lm.created_at, c.created_at) DESC`, me)
	if err != nil {
		httpx.Internal(c, "could not load conversations")
		return
	}
	defer rows.Close()

	items := make([]conversationItem, 0)
	for rows.Next() {
		var (
			it          conversationItem
			requestedBy int64
			body        *string
			senderID    *int64
			createdAt   *time.Time
		)
		if err := rows.Scan(&it.ConversationID, &it.Status, &requestedBy,
			&it.OtherUser.ID, &it.OtherUser.Name, &it.OtherUser.AvatarURL,
			&body, &senderID, &createdAt, &it.UnreadCount); err != nil {
			httpx.Internal(c, "could not read conversations")
			return
		}
		it.IsRequest = it.Status == "pending" && requestedBy != me
		if body != nil && senderID != nil && createdAt != nil {
			it.LastMessage = &lastMessage{Body: *body, SenderID: *senderID, CreatedAt: *createdAt}
		}
		items = append(items, it)
	}
	c.JSON(http.StatusOK, gin.H{"conversations": items})
}

// dmMsg is the wire shape of a direct message.
type dmMsg struct {
	ID             int64     `json:"id"`
	ConversationID int64     `json:"conversation_id"`
	SenderID       int64     `json:"sender_id"`
	Name           string    `json:"name"`
	Body           string    `json:"body"`
	Lat            *float64  `json:"lat,omitempty"`
	Lon            *float64  `json:"lon,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

// dmMessages returns a conversation's history, oldest-first, and marks incoming
// messages as read. Caller must be a participant.
func (h *handler) dmMessages(c *gin.Context) {
	me := authpkg.UserID(c)
	convID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid conversation id")
		return
	}
	cv, err := h.loadConversation(c, convID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "conversation not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load conversation")
		return
	}
	if !cv.has(me) {
		httpx.Error(c, http.StatusForbidden, "not a participant")
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

	// Mark the other side's messages read, but only on the initial load — paging
	// backwards through history must not clear the whole thread's unread state.
	if before == 0 {
		_, _ = h.d.DB.Exec(c,
			`UPDATE direct_messages SET read_at = now()
			 WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL`, convID, me)
	}

	rows, err := h.d.DB.Query(c,
		`SELECT m.id, m.sender_id, u.name, m.body, m.lat, m.lon, m.created_at
		 FROM direct_messages m JOIN users u ON u.id = m.sender_id
		 WHERE m.conversation_id = $1 AND ($2 = 0 OR m.id < $2)
		 ORDER BY m.id DESC LIMIT $3`, convID, before, limit)
	if err != nil {
		httpx.Internal(c, "could not load messages")
		return
	}
	defer rows.Close()

	msgs := make([]dmMsg, 0)
	for rows.Next() {
		var m dmMsg
		m.ConversationID = convID
		if err := rows.Scan(&m.ID, &m.SenderID, &m.Name, &m.Body, &m.Lat, &m.Lon, &m.CreatedAt); err != nil {
			httpx.Internal(c, "could not read messages")
			return
		}
		msgs = append(msgs, m)
	}
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	c.JSON(http.StatusOK, gin.H{"messages": msgs, "status": cv.status})
}

// acceptConversation moves a pending request to accepted. Only the recipient
// (not the requester) may accept.
func (h *handler) acceptConversation(c *gin.Context) {
	h.setConversationStatus(c, "accepted")
}

// declineConversation hides and blocks a pending request. Only the recipient may
// decline.
func (h *handler) declineConversation(c *gin.Context) {
	h.setConversationStatus(c, "declined")
}

func (h *handler) setConversationStatus(c *gin.Context, status string) {
	me := authpkg.UserID(c)
	convID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid conversation id")
		return
	}
	tag, err := h.d.DB.Exec(c,
		`UPDATE conversations SET status = $3, updated_at = now()
		 WHERE id = $1 AND (user_a = $2 OR user_b = $2) AND status = 'pending' AND requested_by <> $2`,
		convID, me, status)
	if err != nil {
		httpx.Internal(c, "could not update conversation")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusConflict, "no pending request to update")
		return
	}
	c.Status(http.StatusNoContent)
}

type dmIn struct {
	Body string   `json:"body"`
	Lat  *float64 `json:"lat"`
	Lon  *float64 `json:"lon"`
}

// dmWS streams a single conversation. Inbound messages are rate limited,
// authorised against the conversation's status, persisted, fanned out, and (if
// the recipient is not connected) delivered as a push notification.
func (h *handler) dmWS(c *gin.Context) {
	claims, err := h.d.JWT.Parse(c.Query("token"))
	if err != nil {
		httpx.Error(c, http.StatusUnauthorized, "invalid token")
		return
	}
	me := claims.UserID
	convID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid conversation id")
		return
	}
	cv, err := h.loadConversation(c, convID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "conversation not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load conversation")
		return
	}
	if !cv.has(me) {
		httpx.Error(c, http.StatusForbidden, "not a participant")
		return
	}
	other := cv.other(me)

	blocked, err := h.blocked(c, me, other)
	if err != nil {
		httpx.Internal(c, "could not verify block")
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

	if blocked {
		_ = conn.WriteJSON(gin.H{"type": "blocked"})
		return
	}

	client := &wsClient{send: make(chan []byte, 32), done: make(chan struct{})}
	h.dmHub.add(convID, client)
	h.addPresence(convID, me)
	defer func() {
		h.removePresence(convID, me)
		h.dmHub.remove(convID, client)
		close(client.done)
	}()

	go pumpWriter(conn, client)

	// Track status locally; the recipient's first reply flips pending → accepted.
	status := cv.status
	for {
		var in dmIn
		if err := conn.ReadJSON(&in); err != nil {
			return
		}
		if len(in.Body) == 0 || len(in.Body) > maxBodyLen {
			continue
		}
		if !h.dmLimiter(me).Allow() {
			continue // drop floods from this user
		}

		if status == "declined" {
			h.sendFrame(client, gin.H{"type": "blocked"})
			continue
		}
		// Suppress the push for a still-pending request after the first message, so
		// an unaccepted stranger can't turn one request into a stream of pushes.
		suppressPush := false
		if status == "pending" {
			if me == cv.requestedBy {
				// Requester may send only a few messages until the recipient
				// accepts, so a stranger can't flood the request inbox.
				var sent int
				_ = h.d.DB.QueryRow(c,
					`SELECT COUNT(*) FROM direct_messages WHERE conversation_id = $1 AND sender_id = $2`,
					convID, me).Scan(&sent)
				if sent >= maxPendingRequestMsgs {
					h.sendFrame(client, gin.H{"type": "request_limit"})
					continue
				}
				suppressPush = sent > 0
			} else {
				// Recipient replied → implicitly accept the conversation.
				if _, err := h.d.DB.Exec(c,
					`UPDATE conversations SET status = 'accepted', updated_at = now() WHERE id = $1`, convID); err == nil {
					status = "accepted"
				}
			}
		}

		var (
			id        int64
			createdAt time.Time
		)
		if err := h.d.DB.QueryRow(c,
			`INSERT INTO direct_messages (conversation_id, sender_id, body, lat, lon)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
			convID, me, in.Body, in.Lat, in.Lon).Scan(&id, &createdAt); err != nil {
			h.d.Log.Error().Err(err).Msg("could not persist direct message")
			continue
		}
		msg := dmMsg{ID: id, ConversationID: convID, SenderID: me, Name: name, Body: in.Body, Lat: in.Lat, Lon: in.Lon, CreatedAt: createdAt}
		if data, err := json.Marshal(msg); err == nil {
			h.dmHub.publish(convID, data)
		}

		// Notify the recipient if they are not currently viewing this conversation.
		if !suppressPush && !h.isPresent(convID, other) {
			h.notifyDM(other, name, in.Body, convID)
		}
	}
}

// notifyDM pushes a direct-message notification to all of a user's devices in the
// background (best effort, never blocks the WebSocket read loop).
func (h *handler) notifyDM(userID int64, senderName, body string, convID int64) {
	go func() {
		ctx := context.Background()
		rows, err := h.d.DB.Query(ctx, `SELECT token FROM push_tokens WHERE user_id = $1`, userID)
		if err != nil {
			return
		}
		defer rows.Close()
		var tokens []string
		for rows.Next() {
			var t string
			if err := rows.Scan(&t); err == nil {
				tokens = append(tokens, t)
			}
		}
		_ = h.push.SendToTokens(ctx, tokens, push.Notification{
			Title: senderName,
			Body:  body,
			Data:  map[string]any{"type": "dm", "conversation_id": convID},
		})
	}()
}

// --- per-conversation connection presence (local replica) ---
//
// Tracks which users currently have this conversation open, so a message to a
// user actively viewing the thread does not also fire a push notification.

func (h *handler) addPresence(convID, userID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.dmPresence == nil {
		h.dmPresence = map[int64]map[int64]int{}
	}
	room := h.dmPresence[convID]
	if room == nil {
		room = map[int64]int{}
		h.dmPresence[convID] = room
	}
	room[userID]++
}

func (h *handler) removePresence(convID, userID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.dmPresence[convID]
	if room == nil {
		return
	}
	room[userID]--
	if room[userID] <= 0 {
		delete(room, userID)
	}
	if len(room) == 0 {
		delete(h.dmPresence, convID)
	}
}

func (h *handler) isPresent(convID, userID int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.dmPresence[convID][userID] > 0
}
