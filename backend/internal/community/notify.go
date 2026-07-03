package community

import (
	"context"

	"github.com/morider/backend/pkg/push"
)

// Push notifications are best-effort and never block the request that caused
// them, mirroring chat's notifyDM: each helper spawns a goroutine, queries the
// audience's push tokens and fires one batch send.

// notifyNewPost tells every active member (except the author) about a new
// broadcast in one of their communities.
func (h *handler) notifyNewPost(communityID, authorID int64, body string) {
	go func() {
		ctx := context.Background()
		var name, author string
		if err := h.d.DB.QueryRow(ctx,
			`SELECT c.name, u.name FROM communities c, users u WHERE c.id = $1 AND u.id = $2`,
			communityID, authorID).Scan(&name, &author); err != nil {
			return
		}
		snippet := body
		if len(snippet) > 120 {
			snippet = snippet[:120] + "…"
		}
		if snippet == "" {
			snippet = "Yeni bir yayın paylaşıldı"
		}
		tokens := h.memberTokens(ctx,
			`SELECT t.token FROM push_tokens t
			 JOIN community_members m ON m.user_id = t.user_id
			 WHERE m.community_id = $1 AND m.status = 'active' AND m.user_id <> $2`,
			communityID, authorID)
		_ = h.push.SendToTokens(ctx, tokens, push.Notification{
			Title: name,
			Body:  author + ": " + snippet,
			Data:  map[string]any{"type": "community_post", "community_id": communityID},
		})
	}()
}

// notifyJoinRequest tells a closed community's admins that a rider wants in.
func (h *handler) notifyJoinRequest(communityID, requesterID int64) {
	go func() {
		ctx := context.Background()
		var name, requester string
		if err := h.d.DB.QueryRow(ctx,
			`SELECT c.name, u.name FROM communities c, users u WHERE c.id = $1 AND u.id = $2`,
			communityID, requesterID).Scan(&name, &requester); err != nil {
			return
		}
		tokens := h.memberTokens(ctx,
			`SELECT t.token FROM push_tokens t
			 JOIN community_members m ON m.user_id = t.user_id
			 WHERE m.community_id = $1 AND m.status = 'active' AND m.role IN ('owner', 'admin')`,
			communityID)
		_ = h.push.SendToTokens(ctx, tokens, push.Notification{
			Title: name,
			Body:  requester + " topluluğa katılmak istiyor",
			Data:  map[string]any{"type": "community_join_request", "community_id": communityID},
		})
	}()
}

// notifyApproved tells a rider their join request was accepted.
func (h *handler) notifyApproved(communityID, userID int64) {
	go func() {
		ctx := context.Background()
		var name string
		if err := h.d.DB.QueryRow(ctx,
			`SELECT name FROM communities WHERE id = $1`, communityID).Scan(&name); err != nil {
			return
		}
		tokens := h.memberTokens(ctx,
			`SELECT token FROM push_tokens WHERE user_id = $1`, userID)
		_ = h.push.SendToTokens(ctx, tokens, push.Notification{
			Title: name,
			Body:  "Katılım isteğin onaylandı 🎉",
			Data:  map[string]any{"type": "community_approved", "community_id": communityID},
		})
	}()
}

// memberTokens runs a token query and collects the results, swallowing errors
// (push is best-effort).
func (h *handler) memberTokens(ctx context.Context, query string, args ...any) []string {
	rows, err := h.d.DB.Query(ctx, query, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var tokens []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil {
			tokens = append(tokens, t)
		}
	}
	return tokens
}
