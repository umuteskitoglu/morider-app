package community

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// Post is the API representation of a community broadcast. Route, Event and
// Poll are optional attachments (nil when the post is plain text/photos).
type Post struct {
	ID           int64     `json:"id"`
	CommunityID  int64     `json:"community_id"`
	UserID       int64     `json:"user_id"`
	Author       string    `json:"author"`
	Body         string    `json:"body"`
	Pinned       bool      `json:"pinned"`
	CreatedAt    time.Time `json:"created_at"`
	Photos       []string  `json:"photos"`
	LikeCount    int64     `json:"like_count"`
	CommentCount int64     `json:"comment_count"`
	Liked        bool      `json:"liked"`

	Route *RouteAttachment `json:"route,omitempty"`
	Event *EventAttachment `json:"event,omitempty"`
	Poll  *Poll            `json:"poll,omitempty"`
}

// RouteAttachment is the shared-route summary embedded in a post.
type RouteAttachment struct {
	ID       int64   `json:"id"`
	Name     string  `json:"name"`
	Distance float64 `json:"distance"`
}

// EventAttachment is the event-announcement summary embedded in a post.
type EventAttachment struct {
	ID      int64     `json:"id"`
	Code    string    `json:"code"`
	Title   string    `json:"title"`
	StartAt time.Time `json:"start_at"`
}

// Poll carries the question, its options with live counts and the viewer's vote.
type Poll struct {
	Question   string       `json:"question"`
	Options    []PollOption `json:"options"`
	TotalVotes int64        `json:"total_votes"`
	MyVote     *int64       `json:"my_vote"` // option id, null when the viewer has not voted
}

// PollOption is one answer of a poll.
type PollOption struct {
	ID    int64  `json:"id"`
	Label string `json:"label"`
	Votes int64  `json:"votes"`
}

// listPosts returns a community's broadcasts, pinned first then newest first.
// Posts of a public community are visible to any signed-in rider; a closed
// community only shows them to active members.
func (h *handler) listPosts(c *gin.Context) {
	id, ok := communityID(c)
	if !ok {
		return
	}
	privacy, ok := h.communityPrivacy(c, id)
	if !ok {
		return
	}
	if privacy == "closed" {
		if _, ok := h.requireActiveMember(c, id); !ok {
			return
		}
	}
	me := authpkg.UserID(c)

	rows, err := h.d.DB.Query(c,
		`SELECT p.id, p.community_id, p.user_id, u.name, p.body, p.pinned, p.created_at,
		        COALESCE(lc.cnt, 0), COALESCE(cc.cnt, 0), (ml.user_id IS NOT NULL),
		        p.route_id, r.name, r.distance,
		        p.event_id, e.code, e.title, e.start_at,
		        p.poll_question
		 FROM community_posts p
		 JOIN users u ON u.id = p.user_id
		 LEFT JOIN routes r ON r.id = p.route_id
		 LEFT JOIN events e ON e.id = p.event_id
		 LEFT JOIN (SELECT post_id, COUNT(*) cnt FROM community_post_likes GROUP BY post_id) lc ON lc.post_id = p.id
		 LEFT JOIN (SELECT post_id, COUNT(*) cnt FROM community_post_comments GROUP BY post_id) cc ON cc.post_id = p.id
		 LEFT JOIN community_post_likes ml ON ml.post_id = p.id AND ml.user_id = $2
		 WHERE p.community_id = $1
		 ORDER BY p.pinned DESC, p.created_at DESC LIMIT 50`, id, me)
	if err != nil {
		httpx.Internal(c, "could not load posts")
		return
	}
	defer rows.Close()

	posts := make([]Post, 0)
	ids := make([]int64, 0)
	pollIDs := make([]int64, 0)
	for rows.Next() {
		var p Post
		var routeID, eventID *int64
		var routeName *string
		var routeDistance *float64
		var eventCode, eventTitle *string
		var eventStart *time.Time
		var pollQuestion *string
		if err := rows.Scan(&p.ID, &p.CommunityID, &p.UserID, &p.Author, &p.Body, &p.Pinned, &p.CreatedAt,
			&p.LikeCount, &p.CommentCount, &p.Liked,
			&routeID, &routeName, &routeDistance,
			&eventID, &eventCode, &eventTitle, &eventStart,
			&pollQuestion); err != nil {
			httpx.Internal(c, "could not read posts")
			return
		}
		p.Photos = []string{}
		if routeID != nil && routeName != nil {
			p.Route = &RouteAttachment{ID: *routeID, Name: *routeName}
			if routeDistance != nil {
				p.Route.Distance = *routeDistance
			}
		}
		if eventID != nil && eventCode != nil && eventTitle != nil && eventStart != nil {
			p.Event = &EventAttachment{ID: *eventID, Code: *eventCode, Title: *eventTitle, StartAt: *eventStart}
		}
		if pollQuestion != nil {
			p.Poll = &Poll{Question: *pollQuestion, Options: []PollOption{}}
			pollIDs = append(pollIDs, p.ID)
		}
		posts = append(posts, p)
		ids = append(ids, p.ID)
	}
	if err := rows.Err(); err != nil {
		httpx.Internal(c, "could not read posts")
		return
	}

	byID := make(map[int64]*Post, len(posts))
	for i := range posts {
		byID[posts[i].ID] = &posts[i]
	}

	if len(ids) > 0 {
		prows, err := h.d.DB.Query(c,
			`SELECT post_id, url FROM community_post_photos WHERE post_id = ANY($1) ORDER BY post_id, position`, ids)
		if err != nil {
			httpx.Internal(c, "could not load photos")
			return
		}
		defer prows.Close()
		for prows.Next() {
			var postID int64
			var url string
			if err := prows.Scan(&postID, &url); err != nil {
				httpx.Internal(c, "could not read photos")
				return
			}
			if p := byID[postID]; p != nil {
				p.Photos = append(p.Photos, url)
			}
		}
	}

	if len(pollIDs) > 0 {
		if !h.attachPolls(c, byID, pollIDs, me) {
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"posts": posts})
}

// attachPolls loads the options, counts and the viewer's vote for every poll
// post in byID. Returns false after responding with an error.
func (h *handler) attachPolls(c *gin.Context, byID map[int64]*Post, pollIDs []int64, me int64) bool {
	orows, err := h.d.DB.Query(c,
		`SELECT o.post_id, o.id, o.label,
		        (SELECT COUNT(*) FROM community_poll_votes v WHERE v.option_id = o.id),
		        EXISTS(SELECT 1 FROM community_poll_votes v WHERE v.option_id = o.id AND v.user_id = $2)
		 FROM community_poll_options o
		 WHERE o.post_id = ANY($1) ORDER BY o.post_id, o.position`, pollIDs, me)
	if err != nil {
		httpx.Internal(c, "could not load polls")
		return false
	}
	defer orows.Close()
	for orows.Next() {
		var postID int64
		var opt PollOption
		var mine bool
		if err := orows.Scan(&postID, &opt.ID, &opt.Label, &opt.Votes, &mine); err != nil {
			httpx.Internal(c, "could not read polls")
			return false
		}
		p := byID[postID]
		if p == nil || p.Poll == nil {
			continue
		}
		p.Poll.Options = append(p.Poll.Options, opt)
		p.Poll.TotalVotes += opt.Votes
		if mine {
			id := opt.ID
			p.Poll.MyVote = &id
		}
	}
	return true
}

// createPost publishes a broadcast. Admin/owner only. Multipart form fields:
// body, photos[] (0-10), route_id, event_id, poll_question + poll_options[].
func (h *handler) createPost(c *gin.Context) {
	id, ok := communityID(c)
	if !ok {
		return
	}
	if _, ok := h.requireAdmin(c, id); !ok {
		return
	}
	form, err := c.MultipartForm()
	if err != nil {
		httpx.BadRequest(c, "invalid multipart form")
		return
	}

	body := strings.TrimSpace(c.PostForm("body"))
	files := form.File["photos"]
	if len(files) > maxPhotos {
		httpx.BadRequest(c, fmt.Sprintf("too many photos (max %d)", maxPhotos))
		return
	}

	// Optional route attachment: hydrated here so the response is complete.
	var route *RouteAttachment
	if s := c.PostForm("route_id"); s != "" {
		rid, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			httpx.BadRequest(c, "invalid route_id")
			return
		}
		route = &RouteAttachment{ID: rid}
		err = h.d.DB.QueryRow(c,
			`SELECT name, COALESCE(distance, 0) FROM routes WHERE id = $1`, rid,
		).Scan(&route.Name, &route.Distance)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.BadRequest(c, "route not found")
			return
		}
		if err != nil {
			httpx.Internal(c, "could not validate route")
			return
		}
	}

	// Optional event announcement.
	var event *EventAttachment
	if s := c.PostForm("event_id"); s != "" {
		eid, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			httpx.BadRequest(c, "invalid event_id")
			return
		}
		event = &EventAttachment{ID: eid}
		err = h.d.DB.QueryRow(c,
			`SELECT code, title, start_at FROM events WHERE id = $1`, eid,
		).Scan(&event.Code, &event.Title, &event.StartAt)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.BadRequest(c, "event not found")
			return
		}
		if err != nil {
			httpx.Internal(c, "could not validate event")
			return
		}
	}

	// Optional poll.
	pollQuestion := strings.TrimSpace(c.PostForm("poll_question"))
	pollOptions := make([]string, 0)
	for _, o := range form.Value["poll_options"] {
		if o = strings.TrimSpace(o); o != "" {
			pollOptions = append(pollOptions, o)
		}
	}
	if pollQuestion == "" && len(pollOptions) > 0 {
		httpx.BadRequest(c, "poll options require a poll question")
		return
	}
	if pollQuestion != "" && (len(pollOptions) < 2 || len(pollOptions) > 6) {
		httpx.BadRequest(c, "a poll needs 2 to 6 options")
		return
	}

	if body == "" && len(files) == 0 && route == nil && event == nil && pollQuestion == "" {
		httpx.BadRequest(c, "the post is empty")
		return
	}

	// Save photos first; collect their public URLs.
	urls := make([]string, 0, len(files))
	for _, fh := range files {
		if fh.Size > maxPhotoBytes {
			httpx.BadRequest(c, "photo too large (max 10MB)")
			return
		}
		if ct := fh.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(ct, "image/") {
			httpx.BadRequest(c, "only image files are allowed")
			return
		}
		name := randomName() + normalizeExt(fh.Filename, fh.Header.Get("Content-Type"))
		if err := c.SaveUploadedFile(fh, filepath.Join(h.uploadDir, name)); err != nil {
			httpx.Internal(c, "could not save photo")
			return
		}
		urls = append(urls, mediaURLPrefix+name)
	}

	uid := authpkg.UserID(c)
	tx, err := h.d.DB.Begin(c)
	if err != nil {
		httpx.Internal(c, "could not create post")
		return
	}
	defer tx.Rollback(c)

	var post Post
	var routeID, eventID *int64
	if route != nil {
		routeID = &route.ID
	}
	if event != nil {
		eventID = &event.ID
	}
	err = tx.QueryRow(c,
		`INSERT INTO community_posts (community_id, user_id, body, route_id, event_id, poll_question)
		 VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''))
		 RETURNING id, community_id, user_id, body, pinned, created_at`,
		id, uid, body, routeID, eventID, pollQuestion,
	).Scan(&post.ID, &post.CommunityID, &post.UserID, &post.Body, &post.Pinned, &post.CreatedAt)
	if err != nil {
		httpx.Internal(c, "could not create post")
		return
	}
	for i, url := range urls {
		if _, err := tx.Exec(c,
			`INSERT INTO community_post_photos (post_id, url, position) VALUES ($1, $2, $3)`, post.ID, url, i,
		); err != nil {
			httpx.Internal(c, "could not save post photos")
			return
		}
	}
	if pollQuestion != "" {
		post.Poll = &Poll{Question: pollQuestion, Options: make([]PollOption, 0, len(pollOptions))}
		for i, label := range pollOptions {
			var optID int64
			if err := tx.QueryRow(c,
				`INSERT INTO community_poll_options (post_id, label, position) VALUES ($1, $2, $3) RETURNING id`,
				post.ID, label, i,
			).Scan(&optID); err != nil {
				httpx.Internal(c, "could not save poll options")
				return
			}
			post.Poll.Options = append(post.Poll.Options, PollOption{ID: optID, Label: label})
		}
	}
	if err := tx.Commit(c); err != nil {
		httpx.Internal(c, "could not create post")
		return
	}

	post.Photos = urls
	post.Route = route
	post.Event = event
	post.Author = authpkg.Email(c) // best-effort; the list endpoint returns the real name

	h.notifyNewPost(id, uid, body)
	c.JSON(http.StatusCreated, post)
}

// deletePost removes a broadcast: its author or the community owner may do so.
// Dependent rows cascade away; stored photos are unlinked best-effort.
func (h *handler) deletePost(c *gin.Context) {
	pid, ok := postIDParam(c)
	if !ok {
		return
	}
	communityID, authorID, ok := h.postCommunity(c, pid)
	if !ok {
		return
	}
	uid := authpkg.UserID(c)
	if uid != authorID {
		role, _, ok := h.membershipOf(c, communityID, uid)
		if !ok {
			return
		}
		if role != "owner" {
			httpx.Error(c, http.StatusForbidden, "only the author or the community owner can delete this post")
			return
		}
	}

	// Collect media file names before the cascade removes the photo rows.
	var urls []string
	if rows, err := h.d.DB.Query(c, `SELECT url FROM community_post_photos WHERE post_id = $1`, pid); err == nil {
		for rows.Next() {
			var u string
			if rows.Scan(&u) == nil {
				urls = append(urls, u)
			}
		}
		rows.Close()
	}

	if _, err := h.d.DB.Exec(c, `DELETE FROM community_posts WHERE id = $1`, pid); err != nil {
		httpx.Internal(c, "could not delete post")
		return
	}

	// Best-effort disk cleanup; the row (the source of truth) is already gone.
	for _, u := range urls {
		name := strings.TrimPrefix(u, mediaURLPrefix)
		if name != "" && name != u {
			_ = os.Remove(filepath.Join(h.uploadDir, filepath.Base(name)))
		}
	}

	c.Status(http.StatusNoContent)
}

func (h *handler) likePost(c *gin.Context) {
	pid, _, ok := h.memberPost(c)
	if !ok {
		return
	}
	if _, err := h.d.DB.Exec(c,
		`INSERT INTO community_post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		pid, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not like post")
		return
	}
	h.respondLikeCount(c, pid, true)
}

func (h *handler) unlikePost(c *gin.Context) {
	pid, _, ok := h.memberPost(c)
	if !ok {
		return
	}
	if _, err := h.d.DB.Exec(c,
		`DELETE FROM community_post_likes WHERE post_id = $1 AND user_id = $2`,
		pid, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not unlike post")
		return
	}
	h.respondLikeCount(c, pid, false)
}

// memberPost resolves the :pid post and verifies the caller is an active
// member of its community.
func (h *handler) memberPost(c *gin.Context) (postID, communityID int64, ok bool) {
	pid, ok := postIDParam(c)
	if !ok {
		return 0, 0, false
	}
	cid, _, ok := h.postCommunity(c, pid)
	if !ok {
		return 0, 0, false
	}
	if _, ok := h.requireActiveMember(c, cid); !ok {
		return 0, 0, false
	}
	return pid, cid, true
}

func (h *handler) respondLikeCount(c *gin.Context, pid int64, liked bool) {
	var cnt int64
	if err := h.d.DB.QueryRow(c, `SELECT COUNT(*) FROM community_post_likes WHERE post_id = $1`, pid).Scan(&cnt); err != nil {
		httpx.Internal(c, "could not load like count")
		return
	}
	c.JSON(http.StatusOK, gin.H{"liked": liked, "like_count": cnt})
}
