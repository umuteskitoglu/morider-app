// Package auth implements the authentication service (signup/login + JWT).
package auth

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"regexp"
	"strings"

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
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Username  string `json:"username"`
	Email     string `json:"email"`
	Country   string `json:"country"`
	AvatarURL string `json:"avatar_url"`
}

// usernameSanitiser strips characters not allowed in a @username.
var usernameSanitiser = regexp.MustCompile(`[^a-z0-9_]`)

// generateUsername derives a base handle from the email local-part. The caller
// appends a numeric suffix on collision; a "rider" fallback keeps it valid when
// the local-part sanitises to fewer than 3 chars.
func generateUsername(email string) string {
	local := email
	if i := strings.IndexByte(email, '@'); i >= 0 {
		local = email[:i]
	}
	base := usernameSanitiser.ReplaceAllString(strings.ToLower(local), "")
	if len(base) > 16 {
		base = base[:16]
	}
	if len(base) < 3 {
		base = "rider"
	}
	return base
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

	// Auto-assign a unique @username derived from the email; on collision retry
	// with a numeric suffix. Users can change it later from their profile.
	base := generateUsername(req.Email)
	var u user
	for attempt := 0; attempt < 5; attempt++ {
		username := base
		if attempt > 0 {
			username = fmt.Sprintf("%s%d", base, rand.Intn(9000)+1000)
		}
		err = h.d.DB.QueryRow(c,
			`INSERT INTO users (name, username, email, password_hash, country)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING id, name, COALESCE(username, ''), email, COALESCE(country, ''), COALESCE(avatar_url, '')`,
			req.Name, username, req.Email, string(hash), req.Country,
		).Scan(&u.ID, &u.Name, &u.Username, &u.Email, &u.Country, &u.AvatarURL)
		if err == nil {
			h.respondWithToken(c, http.StatusCreated, u)
			return
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation
			if pgErr.ConstraintName == "idx_users_username_lower" {
				continue // username clash: pick another suffix
			}
			httpx.Error(c, http.StatusConflict, "email already registered")
			return
		}
		break // non-unique error: stop retrying
	}
	httpx.Internal(c, "could not create user")
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
		`SELECT id, name, COALESCE(username, ''), email, COALESCE(country, ''), COALESCE(avatar_url, ''), password_hash
		 FROM users WHERE email = $1`, req.Email,
	).Scan(&u.ID, &u.Name, &u.Username, &u.Email, &u.Country, &u.AvatarURL, &hash)
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
