// Package auth implements the authentication service (signup/login + JWT).
package auth

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/httpx"
)

// Run boots the auth service.
func Run(cfg config.Config) error {
	deps, err := server.New(context.Background(), "auth", cfg)
	if err != nil {
		return err
	}
	registerRoutes(deps)
	return deps.Run(config.ResolvePort("AUTH_PORT", "8081"))
}

func registerRoutes(d *server.Deps) {
	h := &handler{d: d}
	g := d.Engine.Group("/api/auth")
	g.POST("/signup", h.signup)
	g.POST("/login", h.login)
	g.GET("/me", d.JWT.Middleware(), h.me)
}

type handler struct{ d *server.Deps }

type signupReq struct {
	Name     string `json:"name" binding:"required"`
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=6,max=72"`
	Country  string `json:"country"`
}

type loginReq struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required"`
}

type authResp struct {
	Token string `json:"token"`
	User  user   `json:"user"`
}

type user struct {
	ID      int64  `json:"id"`
	Name    string `json:"name"`
	Email   string `json:"email"`
	Country string `json:"country"`
}

func (h *handler) signup(c *gin.Context) {
	var req signupReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		httpx.Internal(c, "could not hash password")
		return
	}

	var u user
	err = h.d.DB.QueryRow(c,
		`INSERT INTO users (name, email, password_hash, country)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, name, email, COALESCE(country, '')`,
		req.Name, req.Email, string(hash), req.Country,
	).Scan(&u.ID, &u.Name, &u.Email, &u.Country)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation
			httpx.Error(c, http.StatusConflict, "email already registered")
			return
		}
		httpx.Internal(c, "could not create user")
		return
	}

	h.respondWithToken(c, http.StatusCreated, u)
}

func (h *handler) login(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}

	var (
		u    user
		hash string
	)
	err := h.d.DB.QueryRow(c,
		`SELECT id, name, email, COALESCE(country, ''), password_hash
		 FROM users WHERE email = $1`, req.Email,
	).Scan(&u.ID, &u.Name, &u.Email, &u.Country, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		httpx.Internal(c, "login failed")
		return
	}

	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		httpx.Error(c, http.StatusUnauthorized, "invalid credentials")
		return
	}

	h.respondWithToken(c, http.StatusOK, u)
}

func (h *handler) me(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"user_id": authpkg.UserID(c), "email": authpkg.Email(c)})
}

func (h *handler) respondWithToken(c *gin.Context, status int, u user) {
	token, err := h.d.JWT.Issue(u.ID, u.Email)
	if err != nil {
		httpx.Internal(c, "could not issue token")
		return
	}
	c.JSON(status, authResp{Token: token, User: u})
}
