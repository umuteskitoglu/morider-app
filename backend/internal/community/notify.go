package community

import (
	"context"

	"github.com/morider/backend/pkg/notify"
)

// Community notifications go through pkg/notify: it writes the row the bildirim
// merkezi reads and fires the push, and it detaches so neither ever blocks the
// request that caused it. Each helper only resolves the Turkish copy and
// describes its audience.
//
// These used to run in a goroutine of their own because they also did the token
// query and the HTTP send. Now that notify owns both, all that is left here is
// one indexed single-row lookup — cheap enough to do inline, and inline means it
// is covered by gin.Recovery() instead of being a panic that takes the process
// down.

// notifyNewPost tells every active member (except the author) about a new
// broadcast in one of their communities.
//
// These collapse per community: an active topluluk that publishes five times
// before you next open the app leaves one row ("5 yeni yayın"), not five.
func (h *handler) notifyNewPost(ctx context.Context, communityID, postID, authorID int64, body string) {
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
	h.notifier.ToAudience(
		`SELECT user_id FROM community_members
		 WHERE community_id = $1 AND status = 'active'`,
		[]any{communityID},
		notify.Event{
			Kind:     notify.KindCommunityPost,
			ActorID:  authorID,
			EntityID: communityID,
			Title:    name,
			Body:     author + ": " + snippet,
			// The post id lets a tap land on the broadcast itself rather than on
			// the community's post list.
			Data:     map[string]any{"community_id": communityID, "post_id": postID},
			Collapse: "posts",
		})
}

// notifyJoinRequest tells a closed community's admins that a rider wants in.
func (h *handler) notifyJoinRequest(ctx context.Context, communityID, requesterID int64) {
	var name, requester string
	if err := h.d.DB.QueryRow(ctx,
		`SELECT c.name, u.name FROM communities c, users u WHERE c.id = $1 AND u.id = $2`,
		communityID, requesterID).Scan(&name, &requester); err != nil {
		return
	}
	h.notifier.ToAudience(
		`SELECT user_id FROM community_members
		 WHERE community_id = $1 AND status = 'active' AND role IN ('owner', 'admin')`,
		[]any{communityID},
		notify.Event{
			Kind:     notify.KindCommunityJoinRequest,
			ActorID:  requesterID,
			EntityID: communityID,
			Title:    name,
			Body:     requester + " topluluğa katılmak istiyor",
			Data:     map[string]any{"community_id": communityID},
		})
}

// notifyApproved tells a rider their join request was accepted.
func (h *handler) notifyApproved(ctx context.Context, communityID, userID, adminID int64) {
	var name string
	if err := h.d.DB.QueryRow(ctx,
		`SELECT name FROM communities WHERE id = $1`, communityID).Scan(&name); err != nil {
		return
	}
	h.notifier.To(userID, notify.Event{
		Kind:     notify.KindCommunityApproved,
		ActorID:  adminID,
		EntityID: communityID,
		Title:    name,
		Body:     "Katılım isteğin onaylandı 🎉",
		Data:     map[string]any{"community_id": communityID},
	})
}
