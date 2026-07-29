package user

import (
	"net/http"

	"github.com/gin-gonic/gin"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// Account deletion.
//
// Required by App Store Review Guideline 5.1.1(v): an app that lets people
// create an account must let them delete it from inside the app. Google Play's
// data-deletion policy asks for the same thing. Until this existed, every
// submission was one reviewer away from a rejection.
//
// This is a hard delete. Every table that references users(id) does so with ON
// DELETE CASCADE, so one statement removes the rider's rides, telemetry,
// routes, posts, garage, rewards, follows, blocks and session membership.
//
// A soft delete with a grace period would be friendlier, but only if every
// read path across every service learned to filter deleted accounts — and a
// half-applied filter means a "deleted" rider still showing up in leaderboards
// and chat, which is worse than no grace period at all. So: irreversible, and
// the client says so plainly before asking for confirmation.

// deleteAccount removes the caller's account and everything cascading from it.
func (h *handler) deleteAccount(c *gin.Context) {
	me := authpkg.UserID(c)
	if me == 0 {
		httpx.Error(c, http.StatusUnauthorized, "not authenticated")
		return
	}

	tag, err := h.d.DB.Exec(c, `DELETE FROM users WHERE id = $1`, me)
	if err != nil {
		httpx.Internal(c, "could not delete account")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "user not found")
		return
	}

	// Uploaded files (avatars, post photos) live on disk and are not reached by
	// the cascade. They are orphaned by this delete and cleaned up out of band;
	// logged here so that job has something to reconcile against.
	h.d.Log.Warn().Int64("user_id", me).Msg("account deleted")

	c.JSON(http.StatusOK, gin.H{"deleted": true})
}
