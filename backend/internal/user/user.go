// Package user implements the user profile service.
package user

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"

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
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Username    string `json:"username"`
	Email       string `json:"email"`
	Country     string `json:"country"`
	AvatarURL   string `json:"avatar_url"`
	LicenseType string `json:"license_type"`
	BikeType    string `json:"bike_type"`
}

func (h *handler) get(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	var p profile
	err = h.d.DB.QueryRow(c,
		`SELECT id, name, COALESCE(username, ''), email, COALESCE(country, ''), COALESCE(avatar_url, ''),
		        COALESCE(license_type, ''), COALESCE(bike_type, '')
		 FROM users WHERE id = $1`, id,
	).Scan(&p.ID, &p.Name, &p.Username, &p.Email, &p.Country, &p.AvatarURL, &p.LicenseType, &p.BikeType)
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

type updateReq struct {
	Name      string `json:"name"`
	Username  string `json:"username"`
	Country   string `json:"country"`
	AvatarURL string `json:"avatar_url"`
	// Empty string leaves the stored value untouched (same as the fields above).
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
	if req.Username != "" && !usernamePattern.MatchString(req.Username) {
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
		 SET name = COALESCE(NULLIF($2, ''), name),
		     username = COALESCE(NULLIF($3, ''), username),
		     country = COALESCE(NULLIF($4, ''), country),
		     avatar_url = COALESCE(NULLIF($5, ''), avatar_url),
		     license_type = COALESCE(NULLIF($6, ''), license_type),
		     bike_type = COALESCE(NULLIF($7, ''), bike_type),
		     updated_at = now()
		 WHERE id = $1
		 RETURNING id, name, COALESCE(username, ''), email, COALESCE(country, ''), COALESCE(avatar_url, ''),
		           COALESCE(license_type, ''), COALESCE(bike_type, '')`,
		id, req.Name, req.Username, req.Country, req.AvatarURL, req.LicenseType, req.BikeType,
	).Scan(&p.ID, &p.Name, &p.Username, &p.Email, &p.Country, &p.AvatarURL, &p.LicenseType, &p.BikeType)
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
