// Package user implements the user profile service.
package user

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/httpx"
)

// usernamePattern bounds a @username to a safe, predictable charset/length.
var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_]{3,20}$`)

// Allowed rider-profile values; mirrored by CHECK constraints in 0018.
var (
	licenseTypes = map[string]bool{"A1": true, "A2": true, "A": true, "B": true}
	bikeTypes    = map[string]bool{
		"naked": true, "sport": true, "touring": true, "adventure": true,
		"chopper": true, "enduro": true, "scooter": true, "custom": true,
	}
)

// Run boots the user service.
func Run(cfg config.Config) error {
	deps, err := server.New(context.Background(), "user", cfg)
	if err != nil {
		return err
	}
	registerRoutes(deps)
	return deps.Run(config.ResolvePort("USER_PORT", "8082"))
}

func registerRoutes(d *server.Deps) {
	h := &handler{d: d}
	g := d.Engine.Group("/api/users")
	g.GET("/:id", h.get)
	protected := g.Use(d.JWT.Middleware())
	protected.GET("/search", h.searchUsers)
	protected.PUT("/:id", h.update)

	f := d.Engine.Group("/api/follows", d.JWT.Middleware())
	f.GET("/following", h.listFollowing)
	f.GET("/followers", h.listFollowers)
	f.GET("/status/:userId", h.followStatus)
	f.PUT("/:userId", h.follow)
	f.DELETE("/:userId", h.unfollow)
}

type handler struct{ d *server.Deps }

type profile struct {
	ID             int64  `json:"id"`
	Name           string `json:"name"`
	Username       string `json:"username"`
	Email          string `json:"email"`
	Country        string `json:"country"`
	AvatarURL      string `json:"avatar_url"`
	Bio            string `json:"bio"`
	LicenseType    string `json:"license_type"`
	BikeType       string `json:"bike_type"`
	PostCount      int64  `json:"post_count"`
	FollowerCount  int64  `json:"follower_count"`
	FollowingCount int64  `json:"following_count"`
}

func (h *handler) get(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	var p profile
	err = h.d.DB.QueryRow(c,
		`SELECT u.id, u.name, COALESCE(u.username, ''), u.email, COALESCE(u.country, ''),
		        COALESCE(u.avatar_url, ''), COALESCE(u.bio, ''),
		        COALESCE(u.license_type, ''), COALESCE(u.bike_type, ''),
		        (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.archived_at IS NULL),
		        (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id),
		        (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id)
		 FROM users u WHERE u.id = $1`, id,
	).Scan(&p.ID, &p.Name, &p.Username, &p.Email, &p.Country, &p.AvatarURL, &p.Bio,
		&p.LicenseType, &p.BikeType, &p.PostCount, &p.FollowerCount, &p.FollowingCount)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load user")
		return
	}
	c.JSON(http.StatusOK, p)
}

// updateReq uses pointers so we can tell "field omitted" (nil → keep) from
// "field set to empty" (e.g. clearing the bio). COALESCE($n, col) keeps the
// existing value only when the arg is NULL.
type updateReq struct {
	Name      *string `json:"name"`
	Username  *string `json:"username"`
	Country   *string `json:"country"`
	AvatarURL *string `json:"avatar_url"`
	Bio       *string `json:"bio"`
	// license_type/bike_type keep the legacy empty-string-means-unchanged
	// convention (validated against allow-lists below).
	LicenseType string `json:"license_type"`
	BikeType    string `json:"bike_type"`
}

func (h *handler) update(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	if authpkg.UserID(c) != id {
		httpx.Error(c, http.StatusForbidden, "cannot edit another user")
		return
	}
	var req updateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	// Name and username are required fields: if supplied they must be non-empty.
	if req.Name != nil && strings.TrimSpace(*req.Name) == "" {
		httpx.BadRequest(c, "name cannot be empty")
		return
	}
	if req.Username != nil && !usernamePattern.MatchString(*req.Username) {
		httpx.BadRequest(c, "username must be 3-20 chars: letters, digits, underscore")
		return
	}
	if req.LicenseType != "" && !licenseTypes[req.LicenseType] {
		httpx.BadRequest(c, "license_type must be one of A1, A2, A, B")
		return
	}
	if req.BikeType != "" && !bikeTypes[req.BikeType] {
		httpx.BadRequest(c, "invalid bike_type")
		return
	}

	var p profile
	err = h.d.DB.QueryRow(c,
		`UPDATE users
		 SET name = COALESCE($2, name),
		     username = COALESCE($3, username),
		     country = COALESCE($4, country),
		     avatar_url = COALESCE($5, avatar_url),
		     bio = COALESCE($6, bio),
		     license_type = COALESCE(NULLIF($7, ''), license_type),
		     bike_type = COALESCE(NULLIF($8, ''), bike_type),
		     updated_at = now()
		 WHERE id = $1
		 RETURNING id, name, COALESCE(username, ''), email, COALESCE(country, ''),
		           COALESCE(avatar_url, ''), COALESCE(bio, ''),
		           COALESCE(license_type, ''), COALESCE(bike_type, ''),
		           (SELECT COUNT(*) FROM posts p WHERE p.user_id = users.id AND p.archived_at IS NULL),
		           (SELECT COUNT(*) FROM follows f WHERE f.followee_id = users.id),
		           (SELECT COUNT(*) FROM follows f WHERE f.follower_id = users.id)`,
		id, req.Name, req.Username, req.Country, req.AvatarURL, req.Bio, req.LicenseType, req.BikeType,
	).Scan(&p.ID, &p.Name, &p.Username, &p.Email, &p.Country, &p.AvatarURL, &p.Bio,
		&p.LicenseType, &p.BikeType, &p.PostCount, &p.FollowerCount, &p.FollowingCount)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "user not found")
		return
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation on username
		httpx.Error(c, http.StatusConflict, "username taken")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not update user")
		return
	}
	c.JSON(http.StatusOK, p)
}
