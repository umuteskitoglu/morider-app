package community

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// Comment mirrors the feed comment shape on purpose: the mobile CommentsView
// component renders both without changes. ParentID is null for a top-level
// comment; the client builds the reply tree from these edges.
type Comment struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	Author    string    `json:"author"`
	Body      string    `json:"body"`
	ParentID  *int64    `json:"parent_id"`
	LikeCount int64     `json:"like_count"`
	Liked     bool      `json:"liked"`
	CreatedAt time.Time `json:"created_at"`
}

func (h *handler) listComments(c *gin.Context) {
	pid, _, ok := h.memberPost(c)
	if !ok {
		return
	}
	me := authpkg.UserID(c)
	rows, err := h.d.DB.Query(c,
		`SELECT cm.id, cm.user_id, u.name, cm.body, cm.parent_id, cm.created_at,
		        (SELECT COUNT(*) FROM community_post_comment_likes cl WHERE cl.comment_id = cm.id),
		        EXISTS(SELECT 1 FROM community_post_comment_likes cl WHERE cl.comment_id = cm.id AND cl.user_id = $2)
		 FROM community_post_comments cm JOIN users u ON u.id = cm.user_id
		 WHERE cm.post_id = $1 ORDER BY cm.created_at ASC LIMIT 500`, pid, me)
	if err != nil {
		httpx.Internal(c, "could not load comments")
		return
	}
	defer rows.Close()

	comments := make([]Comment, 0)
	for rows.Next() {
		var cm Comment
		if err := rows.Scan(&cm.ID, &cm.UserID, &cm.Author, &cm.Body, &cm.ParentID, &cm.CreatedAt, &cm.LikeCount, &cm.Liked); err != nil {
			httpx.Internal(c, "could not read comments")
			return
		}
		comments = append(comments, cm)
	}
	c.JSON(http.StatusOK, gin.H{"comments": comments})
}

type commentReq struct {
	Body     string `json:"body" binding:"required,max=2000"`
	ParentID *int64 `json:"parent_id"`
}

func (h *handler) addComment(c *gin.Context) {
	pid, _, ok := h.memberPost(c)
	if !ok {
		return
	}
	var req commentReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	// A reply must target a comment on the same post.
	if req.ParentID != nil {
		var exists bool
		if err := h.d.DB.QueryRow(c,
			`SELECT EXISTS(SELECT 1 FROM community_post_comments WHERE id = $1 AND post_id = $2)`,
			*req.ParentID, pid).Scan(&exists); err != nil {
			httpx.Internal(c, "could not validate reply")
			return
		}
		if !exists {
			httpx.BadRequest(c, "parent comment not found on this post")
			return
		}
	}
	var cm Comment
	err := h.d.DB.QueryRow(c,
		`WITH ins AS (
		    INSERT INTO community_post_comments (post_id, user_id, body, parent_id) VALUES ($1, $2, $3, $4)
		    RETURNING id, user_id, body, parent_id, created_at
		 )
		 SELECT ins.id, ins.user_id, u.name, ins.body, ins.parent_id, ins.created_at
		 FROM ins JOIN users u ON u.id = ins.user_id`,
		pid, authpkg.UserID(c), req.Body, req.ParentID,
	).Scan(&cm.ID, &cm.UserID, &cm.Author, &cm.Body, &cm.ParentID, &cm.CreatedAt)
	if err != nil {
		httpx.Internal(c, "could not add comment")
		return
	}
	c.JSON(http.StatusCreated, cm)
}

// memberComment resolves the :cid comment and verifies the caller is an active
// member of the community the comment's post belongs to.
func (h *handler) memberComment(c *gin.Context) (commentID int64, ok bool) {
	cid, ok := commentIDParam(c)
	if !ok {
		return 0, false
	}
	var communityID int64
	err := h.d.DB.QueryRow(c,
		`SELECT p.community_id FROM community_post_comments cm
		 JOIN community_posts p ON p.id = cm.post_id WHERE cm.id = $1`, cid,
	).Scan(&communityID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "comment not found")
		return 0, false
	}
	if err != nil {
		httpx.Internal(c, "could not load comment")
		return 0, false
	}
	if _, ok := h.requireActiveMember(c, communityID); !ok {
		return 0, false
	}
	return cid, true
}

func (h *handler) likeComment(c *gin.Context) {
	cid, ok := h.memberComment(c)
	if !ok {
		return
	}
	if _, err := h.d.DB.Exec(c,
		`INSERT INTO community_post_comment_likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		cid, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not like comment")
		return
	}
	h.respondCommentLikeCount(c, cid, true)
}

func (h *handler) unlikeComment(c *gin.Context) {
	cid, ok := h.memberComment(c)
	if !ok {
		return
	}
	if _, err := h.d.DB.Exec(c,
		`DELETE FROM community_post_comment_likes WHERE comment_id = $1 AND user_id = $2`,
		cid, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not unlike comment")
		return
	}
	h.respondCommentLikeCount(c, cid, false)
}

func (h *handler) respondCommentLikeCount(c *gin.Context, cid int64, liked bool) {
	var cnt int64
	if err := h.d.DB.QueryRow(c, `SELECT COUNT(*) FROM community_post_comment_likes WHERE comment_id = $1`, cid).Scan(&cnt); err != nil {
		httpx.Internal(c, "could not load like count")
		return
	}
	c.JSON(http.StatusOK, gin.H{"liked": liked, "like_count": cnt})
}
