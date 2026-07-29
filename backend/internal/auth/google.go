package auth

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/morider/backend/pkg/httpx"
	"github.com/morider/backend/pkg/oauth"
)

// userColumns is the projection every auth response is built from.
const userColumns = `id, name, COALESCE(username, ''), email, COALESCE(country, ''), COALESCE(avatar_url, '')`

type googleReq struct {
	IDToken string `json:"id_token" binding:"required"`
}

// googleSignIn exchanges a Google ID token for a Morider session token,
// creating or linking the account as needed.
//
// One endpoint covers both sign-up and sign-in: the client cannot know in
// advance whether the Google account is new to us, and asking it to guess would
// only produce a wrong answer to act on.
func (h *handler) googleSignIn(c *gin.Context) {
	var req googleReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	// Verification costs an outbound request on a cold key cache, so it is
	// throttled per source like the password endpoints.
	if !h.perIP.Allow(c.ClientIP()) {
		httpx.Error(c, http.StatusTooManyRequests, "too many attempts, please try again shortly")
		return
	}

	identity, err := h.google.Verify(c, req.IDToken)
	if errors.Is(err, oauth.ErrNotConfigured) {
		httpx.Error(c, http.StatusNotImplemented, "google sign-in is not enabled on this server")
		return
	}
	if err != nil {
		// The precise reason (bad audience, expired, unverified email) is useful
		// in logs but would only help an attacker probe if returned.
		h.d.Log.Warn().Err(err).Msg("google id token rejected")
		httpx.Error(c, http.StatusUnauthorized, "google sign-in failed")
		return
	}

	u, created, err := h.linkOrCreateGoogleUser(c, identity)
	if err != nil {
		h.d.Log.Error().Err(err).Msg("could not resolve google account")
		httpx.Internal(c, "could not complete google sign-in")
		return
	}

	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	h.respondWithToken(c, status, u)
}

// linkOrCreateGoogleUser resolves a verified Google identity to a Morider user.
//
// Resolution order matters:
//  1. by google_sub — the stable id, correct even if the user changed their
//     Google address since last time;
//  2. by email — first sign-in for someone who already has a password account,
//     which links the two rather than stranding them with a duplicate;
//  3. otherwise create a new account.
//
// Two devices signing in at once can race between steps, so a unique violation
// is treated as "somebody else just did step 3" and the whole resolution is
// retried rather than surfaced as an error.
func (h *handler) linkOrCreateGoogleUser(ctx context.Context, id *oauth.Identity) (user, bool, error) {
	for attempt := 0; attempt < 3; attempt++ {
		u, created, err := h.resolveGoogleUser(ctx, id)
		if err == nil {
			return u, created, nil
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			continue // concurrent create/link; re-read and use the winner's row
		}
		return user{}, false, err
	}
	return user{}, false, errors.New("could not resolve google account after retries")
}

func (h *handler) resolveGoogleUser(ctx context.Context, id *oauth.Identity) (user, bool, error) {
	tx, err := h.d.DB.Begin(ctx)
	if err != nil {
		return user{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Returning user, matched on Google's stable subject id.
	var u user
	err = tx.QueryRow(ctx,
		`SELECT `+userColumns+` FROM users WHERE google_sub = $1`, id.Subject).
		Scan(&u.ID, &u.Name, &u.Username, &u.Email, &u.Country, &u.AvatarURL)
	if err == nil {
		// Fill in an avatar only if the user has none; never overwrite one they
		// chose themselves.
		if u.AvatarURL == "" && id.Picture != "" {
			if err := tx.QueryRow(ctx,
				`UPDATE users SET avatar_url = $2, updated_at = now() WHERE id = $1
				 RETURNING COALESCE(avatar_url, '')`, u.ID, id.Picture).Scan(&u.AvatarURL); err != nil {
				return user{}, false, err
			}
		}
		return u, false, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return user{}, false, err
	}

	// 2. Existing password account with the same verified address: link them.
	//
	// This is safe only because Verify rejects tokens whose email_verified is
	// not true — Google has proven control of the mailbox. Linking on an
	// unverified address would be an account-takeover vector.
	err = tx.QueryRow(ctx,
		`UPDATE users
		    SET google_sub = $2,
		        email_verified = true,
		        avatar_url = COALESCE(NULLIF(avatar_url, ''), NULLIF($3, '')),
		        updated_at = now()
		  WHERE lower(email) = $1 AND google_sub IS NULL
		  RETURNING `+userColumns,
		id.Email, id.Subject, id.Picture).
		Scan(&u.ID, &u.Name, &u.Username, &u.Email, &u.Country, &u.AvatarURL)
	if err == nil {
		return u, false, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return user{}, false, err
	}

	// 3. Brand new account. No password: this row is reachable via Google only,
	// which the users_has_auth_method constraint permits.
	name := id.Name
	if name == "" {
		name = displayNameFromEmail(id.Email)
	}
	base := generateUsername(id.Email)
	for attempt := 0; attempt < 5; attempt++ {
		username := base
		if attempt > 0 {
			username = fmt.Sprintf("%s%d", base, rand.Intn(9000)+1000)
		}
		sp, err := tx.Begin(ctx) // SAVEPOINT: a failed INSERT would abort the tx
		if err != nil {
			return user{}, false, err
		}
		err = sp.QueryRow(ctx,
			`INSERT INTO users (name, username, email, google_sub, email_verified, avatar_url)
			 VALUES ($1, $2, $3, $4, true, NULLIF($5, ''))
			 RETURNING `+userColumns,
			name, username, id.Email, id.Subject, id.Picture).
			Scan(&u.ID, &u.Name, &u.Username, &u.Email, &u.Country, &u.AvatarURL)
		if err == nil {
			if err := sp.Commit(ctx); err != nil {
				return user{}, false, err
			}
			return u, true, tx.Commit(ctx)
		}
		_ = sp.Rollback(ctx)

		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" &&
			pgErr.ConstraintName == "idx_users_username_lower" {
			continue // username clash only: pick another suffix
		}
		// Anything else (including a google_sub/email race) bubbles up so the
		// caller can re-resolve.
		return user{}, false, err
	}
	return user{}, false, errors.New("could not allocate a username")
}

// displayNameFromEmail derives a human-ish name when Google sends none, so the
// profile is not blank. The user can change it later.
func displayNameFromEmail(email string) string {
	local := email
	if i := strings.IndexByte(email, '@'); i > 0 {
		local = email[:i]
	}
	local = strings.NewReplacer(".", " ", "_", " ", "-", " ").Replace(local)
	fields := strings.Fields(local)
	for i, f := range fields {
		fields[i] = strings.ToUpper(f[:1]) + f[1:]
	}
	if len(fields) == 0 {
		return "Rider"
	}
	return strings.Join(fields, " ")
}
