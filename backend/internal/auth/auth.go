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
	"github.com/morider/backend/pkg/ratelimit"
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

// Credential endpoints get their own, much tighter bucket on top of the global
// per-IP limiter. Each attempt costs a bcrypt comparison (~60-100ms of CPU), so
// an unthrottled login route is both a credential-stuffing target and a cheap
// CPU-exhaustion DoS.
const (
	credentialRatePerSec = 0.2 // one attempt every 5s sustained
	credentialBurst      = 5
)

func registerRoutes(d *server.Deps) {
	h := &handler{
		d:          d,
		perIP:      ratelimit.NewStore(credentialRatePerSec, credentialBurst),
		perAccount: ratelimit.NewStore(credentialRatePerSec, credentialBurst),
	}
	g := d.Engine.Group("/api/auth")
	g.POST("/signup", h.signup)
	g.POST("/login", h.login)
	g.GET("/me", d.JWT.Middleware(), h.me)
}

type handler struct {
	d *server.Deps
	// Credential attempts are limited twice: per source IP (stops one host
	// hammering) and per targeted account (stops a distributed run converging
	// on one mailbox). The account key is only known after the body is parsed,
	// which is why this lives in the handler rather than in a middleware.
	perIP      *ratelimit.Store
	perAccount *ratelimit.Store
}

// normaliseEmail lowercases and trims an address so it maps to exactly one
// account. Postgres compares TEXT case-sensitively, so without this
// "Umut@x.com" and "umut@x.com" were two different users — one of which the
// rider could never log back into.
func normaliseEmail(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

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
	req.Email = normaliseEmail(req.Email)
	// binding's max=72 counts runes, but bcrypt's limit is 72 *bytes*: a
	// multibyte password could pass validation and then fail in the hasher,
	// surfacing as a confusing 500.
	if len(req.Password) > 72 {
		httpx.BadRequest(c, "password must be at most 72 bytes")
		return
	}
	if !h.allowCredentialAttempt(c, req.Email) {
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

// dummyHash is a valid bcrypt hash of a value nothing can match. The
// no-such-user path compares against it so a failed login costs the same
// ~100ms of bcrypt work as a real one.
//
// Without this, a missing account returned in about a millisecond while an
// existing one took two orders of magnitude longer — a trivially measurable
// oracle for enumerating which addresses have Morider accounts.
var dummyHash = []byte("$2a$10$N9qo8uLOickgx2ZMRZoMye1VdLNRr/5aPjMPGr8dcE9Wl8gCJ0Xhu")

func (h *handler) login(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	req.Email = normaliseEmail(req.Email)
	if !h.allowCredentialAttempt(c, req.Email) {
		return
	}

	var (
		u        user
		stored   string
		found    bool
		compared = dummyHash
	)
	err := h.d.DB.QueryRow(c,
		`SELECT id, name, COALESCE(username, ''), email, COALESCE(country, ''), COALESCE(avatar_url, ''), password_hash
		 FROM users WHERE lower(email) = $1`, req.Email,
	).Scan(&u.ID, &u.Name, &u.Username, &u.Email, &u.Country, &u.AvatarURL, &stored)
	switch {
	case err == nil:
		found, compared = true, []byte(stored)
	case errors.Is(err, pgx.ErrNoRows):
		// fall through to the dummy comparison below
	default:
		httpx.Internal(c, "login failed")
		return
	}

	// Always compare, so the response time does not reveal whether the account
	// exists. Both conditions are checked after the comparison for the same
	// reason.
	passwordOK := bcrypt.CompareHashAndPassword(compared, []byte(req.Password)) == nil
	if !found || !passwordOK {
		httpx.Error(c, http.StatusUnauthorized, "invalid credentials")
		return
	}

	h.respondWithToken(c, http.StatusOK, u)
}

// allowCredentialAttempt applies the per-IP and per-account limits, writing a
// 429 and returning false when either is exhausted.
func (h *handler) allowCredentialAttempt(c *gin.Context, email string) bool {
	if !h.perIP.Allow(c.ClientIP()) || !h.perAccount.Allow(email) {
		httpx.Error(c, http.StatusTooManyRequests, "too many attempts, please try again shortly")
		return false
	}
	return true
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
