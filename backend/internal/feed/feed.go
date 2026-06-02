// Package feed implements the photo-sharing feed service: multipart photo
// upload, local file storage and a reverse-chronological feed.
package feed

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/httpx"
)

const (
	maxPhotos      = 10
	maxPhotoBytes  = 10 << 20 // 10 MB
	mediaURLPrefix = "/api/feed/media/"
)

// Run boots the feed service.
func Run(cfg config.Config) error {
	deps, err := server.New(context.Background(), "feed", cfg)
	if err != nil {
		return err
	}
	h := &handler{d: deps, uploadDir: cfg.UploadDir}
	if err := os.MkdirAll(h.uploadDir, 0o755); err != nil {
		return fmt.Errorf("could not create upload dir %q: %w", h.uploadDir, err)
	}
	registerRoutes(deps, h)
	return deps.Run(config.ResolvePort("FEED_PORT", "8087"))
}

func registerRoutes(d *server.Deps, h *handler) {
	// Media is public: <Image> cannot send a bearer token, and filenames are
	// unguessable random hex.
	d.Engine.GET("/api/feed/media/:file", h.media)

	g := d.Engine.Group("/api", d.JWT.Middleware())
	g.GET("/feed", h.list)
	g.GET("/feed/user/:uid", h.userPosts)
	g.POST("/feed/avatar", h.uploadAvatar)
	g.GET("/posts/mine", h.mine)
	g.POST("/posts", h.create)
	g.POST("/posts/:id/like", h.like)
	g.DELETE("/posts/:id/like", h.unlike)
	g.GET("/posts/:id/likes", h.likes)
	g.GET("/posts/:id/comments", h.listComments)
	g.POST("/posts/:id/comments", h.addComment)
	g.POST("/comments/:cid/like", h.likeComment)
	g.DELETE("/comments/:cid/like", h.unlikeComment)
}

type handler struct {
	d         *server.Deps
	uploadDir string
}

// Post is the API representation of a feed post.
type Post struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"user_id"`
	Author       string    `json:"author"`
	Caption      string    `json:"caption"`
	LocationName string    `json:"location_name"`
	Lat          *float64  `json:"lat"`
	Lon          *float64  `json:"lon"`
	CreatedAt    time.Time `json:"created_at"`
	Photos       []string  `json:"photos"`
	LikeCount    int64     `json:"like_count"`
	CommentCount int64     `json:"comment_count"`
	Liked        bool      `json:"liked"`
}

// Comment is the API representation of a post comment. ParentID is null for a
// top-level comment; the client builds the reply tree from these edges.
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

func (h *handler) create(c *gin.Context) {
	form, err := c.MultipartForm()
	if err != nil {
		httpx.BadRequest(c, "invalid multipart form")
		return
	}
	files := form.File["photos"]
	if len(files) == 0 {
		httpx.BadRequest(c, "at least one photo is required")
		return
	}
	if len(files) > maxPhotos {
		httpx.BadRequest(c, fmt.Sprintf("too many photos (max %d)", maxPhotos))
		return
	}

	// Save files first; collect their public URLs.
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

	caption := c.PostForm("caption")
	locationName := c.PostForm("location_name")
	lat := parseFloatPtr(c.PostForm("lat"))
	lon := parseFloatPtr(c.PostForm("lon"))
	uid := authpkg.UserID(c)

	tx, err := h.d.DB.Begin(c)
	if err != nil {
		httpx.Internal(c, "could not create post")
		return
	}
	defer tx.Rollback(c)

	var post Post
	err = tx.QueryRow(c,
		`INSERT INTO posts (user_id, caption, location_name, lat, lon)
		 VALUES ($1, $2, NULLIF($3, ''), $4, $5)
		 RETURNING id, user_id, COALESCE(caption, ''), COALESCE(location_name, ''), lat, lon, created_at`,
		uid, caption, locationName, lat, lon,
	).Scan(&post.ID, &post.UserID, &post.Caption, &post.LocationName, &post.Lat, &post.Lon, &post.CreatedAt)
	if err != nil {
		httpx.Internal(c, "could not create post")
		return
	}
	for i, url := range urls {
		if _, err := tx.Exec(c,
			`INSERT INTO post_photos (post_id, url, position) VALUES ($1, $2, $3)`, post.ID, url, i,
		); err != nil {
			httpx.Internal(c, "could not save post photos")
			return
		}
	}
	if err := tx.Commit(c); err != nil {
		httpx.Internal(c, "could not create post")
		return
	}

	post.Photos = urls
	post.Author = authpkg.Email(c) // best-effort; list endpoint returns the real name
	c.JSON(http.StatusCreated, post)
}

// uploadAvatar stores a single (already client-cropped) profile photo and returns
// its public media URL. The caller persists that URL on their user record via
// the user service. Reuses the same storage and public /media/ serving as posts.
func (h *handler) uploadAvatar(c *gin.Context) {
	fh, err := c.FormFile("photo")
	if err != nil {
		httpx.BadRequest(c, "a photo is required")
		return
	}
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
	c.JSON(http.StatusCreated, gin.H{"url": mediaURLPrefix + name})
}

// list returns the global feed (newest first).
func (h *handler) list(c *gin.Context) {
	h.respondPosts(c, "", nil)
}

// mine returns only the authenticated user's posts (for the profile grid).
func (h *handler) mine(c *gin.Context) {
	h.respondPosts(c, "p.user_id = $2", authpkg.UserID(c))
}

// userPosts returns a given user's posts (for visiting their profile).
func (h *handler) userPosts(c *gin.Context) {
	uid, err := strconv.ParseInt(c.Param("uid"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	h.respondPosts(c, "p.user_id = $2", uid)
}

// respondPosts runs the posts query (optionally filtered by extraWhere, which
// may reference $2), attaches like/comment counts, the viewer's like state and
// photos, then writes the JSON response. $1 is always the viewer's user id.
func (h *handler) respondPosts(c *gin.Context, extraWhere string, extraArg any) {
	args := []any{authpkg.UserID(c)}
	where := ""
	if extraWhere != "" {
		args = append(args, extraArg)
		where = " WHERE " + extraWhere
	}
	rows, err := h.d.DB.Query(c,
		`SELECT p.id, p.user_id, u.name, COALESCE(p.caption, ''), COALESCE(p.location_name, ''),
		        p.lat, p.lon, p.created_at,
		        COALESCE(lc.cnt, 0), COALESCE(cc.cnt, 0), (ml.user_id IS NOT NULL)
		 FROM posts p
		 JOIN users u ON u.id = p.user_id
		 LEFT JOIN (SELECT post_id, COUNT(*) cnt FROM post_likes GROUP BY post_id) lc ON lc.post_id = p.id
		 LEFT JOIN (SELECT post_id, COUNT(*) cnt FROM post_comments GROUP BY post_id) cc ON cc.post_id = p.id
		 LEFT JOIN post_likes ml ON ml.post_id = p.id AND ml.user_id = $1`+where+`
		 ORDER BY p.created_at DESC LIMIT 50`, args...)
	if err != nil {
		httpx.Internal(c, "could not load feed")
		return
	}
	defer rows.Close()

	posts := make([]Post, 0)
	byID := make(map[int64]*Post)
	ids := make([]int64, 0)
	for rows.Next() {
		var p Post
		if err := rows.Scan(&p.ID, &p.UserID, &p.Author, &p.Caption, &p.LocationName, &p.Lat, &p.Lon, &p.CreatedAt,
			&p.LikeCount, &p.CommentCount, &p.Liked); err != nil {
			httpx.Internal(c, "could not read feed")
			return
		}
		p.Photos = []string{}
		posts = append(posts, p)
		ids = append(ids, p.ID)
	}
	if err := rows.Err(); err != nil {
		httpx.Internal(c, "could not read feed")
		return
	}
	for i := range posts {
		byID[posts[i].ID] = &posts[i]
	}

	if len(ids) > 0 {
		prows, err := h.d.DB.Query(c,
			`SELECT post_id, url FROM post_photos WHERE post_id = ANY($1) ORDER BY post_id, position`, ids)
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

	c.JSON(http.StatusOK, gin.H{"posts": posts})
}

func (h *handler) media(c *gin.Context) {
	file := c.Param("file")
	// Reject path traversal; filenames are plain hex + extension.
	if strings.ContainsAny(file, "/\\") || strings.Contains(file, "..") {
		c.Status(http.StatusBadRequest)
		return
	}
	c.File(filepath.Join(h.uploadDir, file))
}

func (h *handler) like(c *gin.Context) {
	id, ok := postID(c)
	if !ok {
		return
	}
	if _, err := h.d.DB.Exec(c,
		`INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		id, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not like post")
		return
	}
	h.respondLikeCount(c, id, true)
}

func (h *handler) unlike(c *gin.Context) {
	id, ok := postID(c)
	if !ok {
		return
	}
	if _, err := h.d.DB.Exec(c,
		`DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2`, id, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not unlike post")
		return
	}
	h.respondLikeCount(c, id, false)
}

// Liker is a user who liked a post.
type Liker struct {
	UserID int64  `json:"user_id"`
	Name   string `json:"name"`
}

func (h *handler) likes(c *gin.Context) {
	id, ok := postID(c)
	if !ok {
		return
	}
	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name FROM post_likes pl JOIN users u ON u.id = pl.user_id
		 WHERE pl.post_id = $1 ORDER BY pl.created_at DESC LIMIT 200`, id)
	if err != nil {
		httpx.Internal(c, "could not load likes")
		return
	}
	defer rows.Close()

	likers := make([]Liker, 0)
	for rows.Next() {
		var l Liker
		if err := rows.Scan(&l.UserID, &l.Name); err != nil {
			httpx.Internal(c, "could not read likes")
			return
		}
		likers = append(likers, l)
	}
	c.JSON(http.StatusOK, gin.H{"likers": likers})
}

func (h *handler) respondLikeCount(c *gin.Context, id int64, liked bool) {
	var cnt int64
	if err := h.d.DB.QueryRow(c, `SELECT COUNT(*) FROM post_likes WHERE post_id = $1`, id).Scan(&cnt); err != nil {
		httpx.Internal(c, "could not load like count")
		return
	}
	c.JSON(http.StatusOK, gin.H{"liked": liked, "like_count": cnt})
}

func (h *handler) listComments(c *gin.Context) {
	id, ok := postID(c)
	if !ok {
		return
	}
	me := authpkg.UserID(c)
	rows, err := h.d.DB.Query(c,
		`SELECT cm.id, cm.user_id, u.name, cm.body, cm.parent_id, cm.created_at,
		        (SELECT COUNT(*) FROM post_comment_likes cl WHERE cl.comment_id = cm.id),
		        EXISTS(SELECT 1 FROM post_comment_likes cl WHERE cl.comment_id = cm.id AND cl.user_id = $2)
		 FROM post_comments cm JOIN users u ON u.id = cm.user_id
		 WHERE cm.post_id = $1 ORDER BY cm.created_at ASC LIMIT 500`, id, me)
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
	id, ok := postID(c)
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
			`SELECT EXISTS(SELECT 1 FROM post_comments WHERE id = $1 AND post_id = $2)`,
			*req.ParentID, id).Scan(&exists); err != nil {
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
		    INSERT INTO post_comments (post_id, user_id, body, parent_id) VALUES ($1, $2, $3, $4)
		    RETURNING id, user_id, body, parent_id, created_at
		 )
		 SELECT ins.id, ins.user_id, u.name, ins.body, ins.parent_id, ins.created_at
		 FROM ins JOIN users u ON u.id = ins.user_id`,
		id, authpkg.UserID(c), req.Body, req.ParentID,
	).Scan(&cm.ID, &cm.UserID, &cm.Author, &cm.Body, &cm.ParentID, &cm.CreatedAt)
	if err != nil {
		httpx.Internal(c, "could not add comment")
		return
	}
	c.JSON(http.StatusCreated, cm)
}

// commentID parses the :cid route param.
func commentID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("cid"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid comment id")
		return 0, false
	}
	return id, true
}

func (h *handler) likeComment(c *gin.Context) {
	cid, ok := commentID(c)
	if !ok {
		return
	}
	if _, err := h.d.DB.Exec(c,
		`INSERT INTO post_comment_likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		cid, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not like comment")
		return
	}
	h.respondCommentLikeCount(c, cid, true)
}

func (h *handler) unlikeComment(c *gin.Context) {
	cid, ok := commentID(c)
	if !ok {
		return
	}
	if _, err := h.d.DB.Exec(c,
		`DELETE FROM post_comment_likes WHERE comment_id = $1 AND user_id = $2`,
		cid, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not unlike comment")
		return
	}
	h.respondCommentLikeCount(c, cid, false)
}

func (h *handler) respondCommentLikeCount(c *gin.Context, cid int64, liked bool) {
	var cnt int64
	if err := h.d.DB.QueryRow(c, `SELECT COUNT(*) FROM post_comment_likes WHERE comment_id = $1`, cid).Scan(&cnt); err != nil {
		httpx.Internal(c, "could not load like count")
		return
	}
	c.JSON(http.StatusOK, gin.H{"liked": liked, "like_count": cnt})
}

func postID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid post id")
		return 0, false
	}
	return id, true
}

func randomName() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func normalizeExt(filename, contentType string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".jpg", ".jpeg":
		return ".jpg"
	case ".png":
		return ".png"
	case ".webp":
		return ".webp"
	case ".heic":
		return ".heic"
	}
	switch contentType {
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/heic":
		return ".heic"
	default:
		return ".jpg"
	}
}

func parseFloatPtr(s string) *float64 {
	if s == "" {
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return &f
}
