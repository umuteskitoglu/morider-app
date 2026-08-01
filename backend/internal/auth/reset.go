package auth

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog"
	"golang.org/x/crypto/bcrypt"

	"github.com/morider/backend/pkg/httpx"
	"github.com/morider/backend/pkg/mail"
)

const (
	// resetCodeTTL is how long a mailed code stays usable. Long enough to
	// switch to a mail app and back, short enough that a code sitting in an
	// unattended inbox stops being a key to the account.
	resetCodeTTL = 15 * time.Minute

	// maxResetAttempts is the guess budget for one code. Six digits is a
	// million possibilities — trivial to brute force unmetered, unreachable
	// with five tries before the code has to be re-requested (which mails a
	// new one and retires the old).
	maxResetAttempts = 5

	// resetWorkTimeout bounds the background job that hashes, stores and mails
	// the code. The request has already been answered by then, so nothing is
	// waiting on it; this only stops a stuck SMTP relay leaking goroutines.
	resetWorkTimeout = 45 * time.Second
)

// invalidCodeMsg is the single answer to every failed reset: unknown address,
// expired code, wrong code, exhausted attempts. Distinguishing them would tell
// an attacker which addresses have Morider accounts and which codes are live.
const invalidCodeMsg = "invalid or expired code"

type forgotReq struct {
	Email string `json:"email" binding:"required,email"`
}

type resetReq struct {
	Email    string `json:"email" binding:"required,email"`
	Code     string `json:"code" binding:"required,len=6,numeric"`
	Password string `json:"password" binding:"required,min=6,max=72"`
}

// generateResetCode returns a uniformly random 6-digit code as a string,
// zero-padded so every code is the same length.
//
// crypto/rand, not math/rand: the package-level math/rand used for username
// suffixes is predictable from a few outputs, and a predictable reset code is
// an account takeover.
func generateResetCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// forgotPassword mails a one-time code to the address if it has an account.
//
// It answers 202 unconditionally and does the real work afterwards. That is
// not laziness about error reporting: the response must look identical whether
// or not the address is registered, and doing the lookup, the bcrypt hash and
// the SMTP round trip inline would make an unknown address answer measurably
// faster than a known one — the same enumeration oracle the login path spends
// a dummy bcrypt comparison to close.
func (h *handler) forgotPassword(c *gin.Context) {
	var req forgotReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	email := normaliseEmail(req.Email)
	if !h.allowCredentialAttempt(c, email) {
		return
	}

	c.JSON(http.StatusAccepted, gin.H{
		"message": "if the address has an account, a reset code has been sent",
	})

	go h.issueResetCode(email)
}

// issueResetCode runs detached from the request: it retires any outstanding
// codes for the account, stores a fresh one and mails it.
func (h *handler) issueResetCode(email string) {
	ctx, cancel := context.WithTimeout(context.Background(), resetWorkTimeout)
	defer cancel()

	log := h.d.Log.With().Str("flow", "password_reset").Logger()

	var (
		userID int64
		name   string
		to     string
	)
	err := h.d.DB.QueryRow(ctx,
		`SELECT id, name, email FROM users WHERE lower(email) = $1`, email,
	).Scan(&userID, &name, &to)
	if errors.Is(err, pgx.ErrNoRows) {
		// Nothing to do, and nothing the caller may learn about it.
		return
	}
	if err != nil {
		log.Error().Err(err).Msg("could not look up account for reset")
		return
	}

	code, err := generateResetCode()
	if err != nil {
		log.Error().Err(err).Msg("could not generate reset code")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(code), bcrypt.DefaultCost)
	if err != nil {
		log.Error().Err(err).Msg("could not hash reset code")
		return
	}

	// Requesting a new code retires the previous one. Otherwise every request
	// would widen the guess budget: five attempts per live code, times as many
	// codes as an attacker cares to trigger.
	if _, err := h.d.DB.Exec(ctx,
		`UPDATE password_resets SET consumed_at = now()
		 WHERE user_id = $1 AND consumed_at IS NULL`, userID); err != nil {
		log.Error().Err(err).Msg("could not retire previous reset codes")
		return
	}
	if _, err := h.d.DB.Exec(ctx,
		`INSERT INTO password_resets (user_id, code_hash, expires_at)
		 VALUES ($1, $2, now() + $3::interval)`,
		userID, string(hash), fmt.Sprintf("%d seconds", int(resetCodeTTL.Seconds())),
	); err != nil {
		log.Error().Err(err).Msg("could not store reset code")
		return
	}

	h.deliverResetCode(ctx, log, to, name, code)

	// Opportunistic prune. Spent and expired rows have no further use, and
	// piggybacking on a request that already touched this table avoids a
	// background sweeper for what is a very low-volume table.
	if _, err := h.d.DB.Exec(ctx,
		`DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'`,
	); err != nil {
		log.Warn().Err(err).Msg("could not prune expired reset codes")
	}
}

// deliverResetCode mails the code, or — when no relay is configured outside
// production — logs it so the flow can be exercised locally.
func (h *handler) deliverResetCode(ctx context.Context, log zerolog.Logger, to, name, code string) {
	subject := "Morider şifre sıfırlama kodun"
	body := fmt.Sprintf(`Merhaba %s,

Morider hesabının şifresini sıfırlamak için doğrulama kodun:

    %s

Kod %d dakika boyunca geçerli. Uygulamadaki "Şifremi unuttum" ekranına bu kodu ve yeni şifreni gir.

Bu isteği sen yapmadıysan yapman gereken bir şey yok — şifren değişmedi.

Morider`, name, code, int(resetCodeTTL.Minutes()))

	err := h.mail.Send(ctx, to, subject, body)
	if err == nil {
		log.Info().Msg("reset code mailed")
		return
	}
	if errors.Is(err, mail.ErrNotConfigured) {
		if h.d.Cfg.AppEnv == "production" {
			// Logging the code here would put an account-takeover credential
			// into the log pipeline, which is a worse outcome than the reset
			// simply not working until SMTP_HOST is set.
			log.Error().Msg("password reset requested but SMTP is not configured")
			return
		}
		log.Warn().Str("email", to).Str("code", code).
			Msg("SMTP not configured: reset code logged instead of mailed (development only)")
		return
	}
	log.Error().Err(err).Msg("could not mail reset code")
}

// resetPassword verifies a mailed code and sets the new password, returning a
// session token so the rider lands back in the app instead of being bounced to
// the login screen to retype what they just chose.
func (h *handler) resetPassword(c *gin.Context) {
	var req resetReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	email := normaliseEmail(req.Email)
	if !h.allowCredentialAttempt(c, email) {
		return
	}

	var (
		resetID  int64
		userID   int64
		codeHash string
		attempts int
	)
	err := h.d.DB.QueryRow(c,
		`SELECT r.id, r.user_id, r.code_hash, r.attempts
		 FROM password_resets r
		 JOIN users u ON u.id = r.user_id
		 WHERE lower(u.email) = $1 AND r.consumed_at IS NULL AND r.expires_at > now()
		 ORDER BY r.created_at DESC
		 LIMIT 1`, email,
	).Scan(&resetID, &userID, &codeHash, &attempts)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.BadRequest(c, invalidCodeMsg)
		return
	case err != nil:
		h.d.Log.Error().Err(err).Msg("could not load reset code")
		httpx.Internal(c, "password reset failed")
		return
	}

	if attempts >= maxResetAttempts {
		// Burn the code rather than leaving it to expire: an exhausted code is
		// already known to be under attack.
		h.consumeReset(c, resetID)
		httpx.BadRequest(c, invalidCodeMsg)
		return
	}
	// Count the attempt before checking it. Doing it the other way round means
	// a client that hangs up mid-comparison gets a free guess.
	if _, err := h.d.DB.Exec(c,
		`UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1`, resetID); err != nil {
		h.d.Log.Error().Err(err).Msg("could not record reset attempt")
		httpx.Internal(c, "password reset failed")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(codeHash), []byte(req.Code)) != nil {
		httpx.BadRequest(c, invalidCodeMsg)
		return
	}

	if len(req.Password) > 72 {
		httpx.BadRequest(c, "password must be at most 72 bytes")
		return
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		httpx.Internal(c, "could not hash password")
		return
	}

	tx, err := h.d.DB.Begin(c)
	if err != nil {
		h.d.Log.Error().Err(err).Msg("could not begin reset transaction")
		httpx.Internal(c, "password reset failed")
		return
	}
	defer tx.Rollback(c) //nolint:errcheck // no-op once committed

	var u user
	// email_verified is set here because holding the code proves control of
	// the mailbox — which is exactly what password signup never established.
	if err := tx.QueryRow(c,
		`UPDATE users SET password_hash = $1, email_verified = true
		 WHERE id = $2
		 RETURNING `+userColumns, string(newHash), userID,
	).Scan(&u.ID, &u.Name, &u.Username, &u.Email, &u.Country, &u.AvatarURL); err != nil {
		h.d.Log.Error().Err(err).Msg("could not update password")
		httpx.Internal(c, "password reset failed")
		return
	}
	// Every outstanding code for this account, not just the one used: after a
	// successful reset none of them should still open the door.
	if _, err := tx.Exec(c,
		`UPDATE password_resets SET consumed_at = now()
		 WHERE user_id = $1 AND consumed_at IS NULL`, userID); err != nil {
		h.d.Log.Error().Err(err).Msg("could not consume reset codes")
		httpx.Internal(c, "password reset failed")
		return
	}
	if err := tx.Commit(c); err != nil {
		h.d.Log.Error().Err(err).Msg("could not commit password reset")
		httpx.Internal(c, "password reset failed")
		return
	}

	h.respondWithToken(c, http.StatusOK, u)
}

// consumeReset marks one code as spent, best-effort.
func (h *handler) consumeReset(ctx context.Context, id int64) {
	if _, err := h.d.DB.Exec(ctx,
		`UPDATE password_resets SET consumed_at = now() WHERE id = $1`, id); err != nil {
		h.d.Log.Warn().Err(err).Msg("could not consume exhausted reset code")
	}
}
