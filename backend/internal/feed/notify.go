package feed

import (
	"context"

	"github.com/morider/backend/pkg/notify"
)

// Likes and comments used to be silent: the feed service had no push dependency
// at all, so the events riders most want to hear about produced nothing. They go
// through pkg/notify now, which writes the bildirim merkezi row and fires the
// push without ever blocking these (hot) endpoints.

// commentSnippetMax bounds how much of a comment rides along in the push body.
const commentSnippetMax = 80

// notifyPostLike tells a rider their gönderi was liked.
//
// Likes collapse: ten people liking one photo leave one unread row the client
// renders as "Ali ve 9 kişi", not ten rows that bury everything else.
func (h *handler) notifyPostLike(ctx context.Context, postID, actorID int64) {
	owner, ok := h.postOwner(ctx, postID)
	if !ok || owner == actorID {
		return
	}
	h.notifier.To(owner, notify.Event{
		Kind:     notify.KindPostLike,
		ActorID:  actorID,
		EntityID: postID,
		Title:    "Yeni beğeni",
		Body:     h.notifier.UserName(ctx, actorID) + " gönderini beğendi",
		Collapse: "like",
	})
}

// notifyPostComment tells the post's owner about a new comment, and — when the
// comment is a reply — the author of the comment being replied to.
//
// Comments do not collapse: each one carries its own words, and folding them
// would throw away the only part a rider actually wants to read.
func (h *handler) notifyPostComment(ctx context.Context, postID int64, parentID *int64, actorID int64, actorName, body string) {
	snippet := body
	if len(snippet) > commentSnippetMax {
		snippet = snippet[:commentSnippetMax] + "…"
	}

	owner, ok := h.postOwner(ctx, postID)
	if ok && owner != actorID {
		h.notifier.To(owner, notify.Event{
			Kind:     notify.KindPostComment,
			ActorID:  actorID,
			EntityID: postID,
			Title:    "Yeni yorum",
			Body:     actorName + " gönderine yorum yaptı: " + snippet,
		})
	}
	if parentID == nil {
		return
	}

	var parentAuthor int64
	if err := h.d.DB.QueryRow(ctx,
		`SELECT user_id FROM post_comments WHERE id = $1`, *parentID).Scan(&parentAuthor); err != nil {
		return
	}
	// The post's owner was already told, and you are never told about your own
	// reply.
	if parentAuthor == actorID || (ok && parentAuthor == owner) {
		return
	}
	h.notifier.To(parentAuthor, notify.Event{
		Kind:     notify.KindPostComment,
		ActorID:  actorID,
		EntityID: postID,
		Title:    "Yorumuna yanıt",
		Body:     actorName + " yorumuna yanıt verdi: " + snippet,
	})
}

// postOwner resolves who a post belongs to. The bool reports whether it could be
// read at all — a missing post means nobody to notify, not an error worth
// failing the request over.
func (h *handler) postOwner(ctx context.Context, postID int64) (int64, bool) {
	var owner int64
	if err := h.d.DB.QueryRow(ctx, `SELECT user_id FROM posts WHERE id = $1`, postID).Scan(&owner); err != nil {
		return 0, false
	}
	return owner, true
}
