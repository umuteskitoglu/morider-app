package community

import (
	"net/http"

	"github.com/gin-gonic/gin"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

type voteReq struct {
	OptionID int64 `json:"option_id" binding:"required"`
}

// vote records (or changes) the caller's vote on a post's poll and returns the
// updated results. The (post_id, user_id) primary key keeps it one vote per
// rider; voting again simply moves the vote.
func (h *handler) vote(c *gin.Context) {
	pid, _, ok := h.memberPost(c)
	if !ok {
		return
	}
	var req voteReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}

	// The chosen option must belong to this post's poll.
	var valid bool
	if err := h.d.DB.QueryRow(c,
		`SELECT EXISTS(SELECT 1 FROM community_poll_options WHERE id = $1 AND post_id = $2)`,
		req.OptionID, pid).Scan(&valid); err != nil {
		httpx.Internal(c, "could not validate vote")
		return
	}
	if !valid {
		httpx.BadRequest(c, "option not found on this poll")
		return
	}

	me := authpkg.UserID(c)
	if _, err := h.d.DB.Exec(c,
		`INSERT INTO community_poll_votes (post_id, option_id, user_id) VALUES ($1, $2, $3)
		 ON CONFLICT (post_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id`,
		pid, req.OptionID, me); err != nil {
		httpx.Internal(c, "could not save vote")
		return
	}

	h.respondPoll(c, pid, me)
}

// respondPoll returns the current poll state of a post.
func (h *handler) respondPoll(c *gin.Context, pid, me int64) {
	poll := &Poll{Options: []PollOption{}}
	if err := h.d.DB.QueryRow(c,
		`SELECT COALESCE(poll_question, '') FROM community_posts WHERE id = $1`, pid,
	).Scan(&poll.Question); err != nil {
		httpx.Internal(c, "could not load poll")
		return
	}

	rows, err := h.d.DB.Query(c,
		`SELECT o.id, o.label,
		        (SELECT COUNT(*) FROM community_poll_votes v WHERE v.option_id = o.id),
		        EXISTS(SELECT 1 FROM community_poll_votes v WHERE v.option_id = o.id AND v.user_id = $2)
		 FROM community_poll_options o WHERE o.post_id = $1 ORDER BY o.position`, pid, me)
	if err != nil {
		httpx.Internal(c, "could not load poll")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var opt PollOption
		var mine bool
		if err := rows.Scan(&opt.ID, &opt.Label, &opt.Votes, &mine); err != nil {
			httpx.Internal(c, "could not read poll")
			return
		}
		poll.Options = append(poll.Options, opt)
		poll.TotalVotes += opt.Votes
		if mine {
			id := opt.ID
			poll.MyVote = &id
		}
	}
	c.JSON(http.StatusOK, gin.H{"poll": poll})
}
