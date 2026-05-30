// Package user implements the user profile service.
package user

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/httpx"
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
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	Country   string `json:"country"`
	AvatarURL string `json:"avatar_url"`
}

func (h *handler) get(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	var p profile
	err = h.d.DB.QueryRow(c,
		`SELECT id, name, email, COALESCE(country, ''), COALESCE(avatar_url, '') FROM users WHERE id = $1`, id,
	).Scan(&p.ID, &p.Name, &p.Email, &p.Country, &p.AvatarURL)
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
	Country   string `json:"country"`
	AvatarURL string `json:"avatar_url"`
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
	var p profile
	err = h.d.DB.QueryRow(c,
		`UPDATE users
		 SET name = COALESCE(NULLIF($2, ''), name),
		     country = COALESCE(NULLIF($3, ''), country),
		     avatar_url = COALESCE(NULLIF($4, ''), avatar_url),
		     updated_at = now()
		 WHERE id = $1
		 RETURNING id, name, email, COALESCE(country, ''), COALESCE(avatar_url, '')`,
		id, req.Name, req.Country, req.AvatarURL,
	).Scan(&p.ID, &p.Name, &p.Email, &p.Country, &p.AvatarURL)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not update user")
		return
	}
	c.JSON(http.StatusOK, p)
}
