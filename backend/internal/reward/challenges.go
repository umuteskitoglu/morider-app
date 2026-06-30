package reward

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
	"github.com/morider/backend/pkg/push"
)

// Challenges: time-boxed competitions over a rider metric. Progress is always
// derived from the rides table within the challenge window (so it is naturally
// consistent and needs no separate counters), and reaching the goal awards a
// per-challenge badge via the same idempotent rewards table the rules engine uses.

// validMetrics is the set of metrics a challenge can target. Cumulative metrics
// (distance km, elevation m, ride count) sum over the window; "best" metrics
// (avg_speed, top_speed in km/h) take the rider's single best ride in the window.
var validMetrics = map[string]bool{
	"distance": true, "elevation": true, "rides": true, "avg_speed": true, "top_speed": true,
}

// metricSQL is the per-metric aggregate over a rides row alias (e.g. "r" or "").
// Speed metrics are sanity-capped to ignore implausible GPS spikes.
func metricSQL(alias string) string {
	p := ""
	if alias != "" {
		p = alias + "."
	}
	return `CASE %[1]s
	            WHEN 'distance'  THEN SUM(` + p + `distance)
	            WHEN 'elevation' THEN SUM(` + p + `elevation_gain)
	            WHEN 'rides'     THEN COUNT(` + p + `id)::float8
	            WHEN 'avg_speed' THEN MAX(` + p + `avg_speed) FILTER (WHERE ` + p + `avg_speed BETWEEN 0 AND 400)
	            WHEN 'top_speed' THEN MAX(` + p + `max_speed) FILTER (WHERE ` + p + `max_speed BETWEEN 0 AND 400)
	        END`
}

// Challenge is the API representation of a challenge plus the caller's standing.
type Challenge struct {
	ID           int64     `json:"id"`
	CreatorID    int64     `json:"creator_id"`
	Title        string    `json:"title"`
	Description  string    `json:"description"`
	Metric       string    `json:"metric"`
	Goal         float64   `json:"goal"`
	StartsAt     time.Time `json:"starts_at"`
	EndsAt       time.Time `json:"ends_at"`
	Participants int64     `json:"participants"`
	Joined       bool      `json:"joined"`
	MyProgress   float64   `json:"my_progress"`
}

// ChallengeStanding is one participant's progress on a challenge.
type ChallengeStanding struct {
	UserID    int64   `json:"user_id"`
	Name      string  `json:"name"`
	AvatarURL string  `json:"avatar_url"`
	Progress  float64 `json:"progress"`
	Completed bool    `json:"completed"`
}

func registerChallengeRoutes(g *gin.RouterGroup, h *handler) {
	g.POST("/challenges", h.createChallenge)
	g.GET("/challenges", h.listChallenges)
	g.GET("/challenges/:id", h.getChallenge)
	g.POST("/challenges/:id/join", h.joinChallenge)
	g.POST("/challenges/:id/leave", h.leaveChallenge)
	g.POST("/challenges/:id/invite", h.inviteToChallenge)
	g.DELETE("/challenges/:id", h.deleteChallenge)

	// Invite inbox lives under its own prefix to avoid colliding with the
	// /challenges/:id param route. The gateway proxies it to this service too.
	g.GET("/challenge-invites", h.listInvites)
	g.POST("/challenge-invites/:iid/accept", h.acceptInvite)
	g.POST("/challenge-invites/:iid/decline", h.declineInvite)
}

type challengeReq struct {
	Title       string    `json:"title" binding:"required,max=120"`
	Description string    `json:"description" binding:"max=500"`
	Metric      string    `json:"metric" binding:"required"`
	Goal        float64   `json:"goal" binding:"required,gt=0"`
	StartsAt    time.Time `json:"starts_at" binding:"required"`
	EndsAt      time.Time `json:"ends_at" binding:"required"`
}

func (h *handler) createChallenge(c *gin.Context) {
	var req challengeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	if !validMetrics[req.Metric] {
		httpx.BadRequest(c, "metric must be distance, elevation or rides")
		return
	}
	if !req.EndsAt.After(req.StartsAt) {
		httpx.BadRequest(c, "ends_at must be after starts_at")
		return
	}
	uid := authpkg.UserID(c)
	var id int64
	err := h.d.DB.QueryRow(c,
		`INSERT INTO challenges (creator_id, title, description, metric, goal, starts_at, ends_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
		uid, req.Title, req.Description, req.Metric, req.Goal, req.StartsAt, req.EndsAt,
	).Scan(&id)
	if err != nil {
		httpx.Internal(c, "could not create challenge")
		return
	}
	// The creator joins their own challenge automatically.
	if _, err := h.d.DB.Exec(c,
		`INSERT INTO challenge_participants (challenge_id, user_id) VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`, id, uid); err != nil {
		httpx.Internal(c, "could not join challenge")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

// listChallenges returns active and recently-ended challenges with the caller's
// progress and join state. Progress is computed in SQL via a CASE on the metric
// so it stays a single grouped query (no N+1).
func (h *handler) listChallenges(c *gin.Context) {
	uid := authpkg.UserID(c)
	progressExpr := fmt.Sprintf(metricSQL("r"), "c.metric")
	rows, err := h.d.DB.Query(c,
		`SELECT c.id, c.creator_id, c.title, COALESCE(c.description, ''), c.metric, c.goal, c.starts_at, c.ends_at,
		        (SELECT COUNT(*) FROM challenge_participants p WHERE p.challenge_id = c.id),
		        EXISTS(SELECT 1 FROM challenge_participants p WHERE p.challenge_id = c.id AND p.user_id = $1),
		        COALESCE(`+progressExpr+`, 0)
		 FROM challenges c
		 LEFT JOIN rides r ON r.user_id = $1
		      AND COALESCE(r.start_time, r.created_at) >= c.starts_at
		      AND COALESCE(r.start_time, r.created_at) <= c.ends_at
		 WHERE c.ends_at >= now() - interval '30 days'
		 GROUP BY c.id
		 ORDER BY c.ends_at ASC
		 LIMIT 100`, uid)
	if err != nil {
		httpx.Internal(c, "could not list challenges")
		return
	}
	defer rows.Close()
	out := make([]Challenge, 0)
	for rows.Next() {
		var ch Challenge
		if err := rows.Scan(&ch.ID, &ch.CreatorID, &ch.Title, &ch.Description, &ch.Metric, &ch.Goal,
			&ch.StartsAt, &ch.EndsAt, &ch.Participants, &ch.Joined, &ch.MyProgress); err != nil {
			httpx.Internal(c, "could not read challenges")
			return
		}
		out = append(out, ch)
	}
	c.JSON(http.StatusOK, gin.H{"challenges": out})
}

// getChallenge returns one challenge with its full standings (leaderboard).
func (h *handler) getChallenge(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid challenge id")
		return
	}
	uid := authpkg.UserID(c)
	var ch Challenge
	err = h.d.DB.QueryRow(c,
		`SELECT id, creator_id, title, COALESCE(description, ''), metric, goal, starts_at, ends_at,
		        (SELECT COUNT(*) FROM challenge_participants p WHERE p.challenge_id = challenges.id),
		        EXISTS(SELECT 1 FROM challenge_participants p WHERE p.challenge_id = challenges.id AND p.user_id = $2)
		 FROM challenges WHERE id = $1`, id, uid,
	).Scan(&ch.ID, &ch.CreatorID, &ch.Title, &ch.Description, &ch.Metric, &ch.Goal,
		&ch.StartsAt, &ch.EndsAt, &ch.Participants, &ch.Joined)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "challenge not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load challenge")
		return
	}

	// Standings: each participant's progress over the window, ranked.
	progressExpr := fmt.Sprintf(metricSQL("r"), "$2::text")
	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, COALESCE(u.avatar_url, ''),
		        COALESCE(`+progressExpr+`, 0) AS progress,
		        cp.completed_at IS NOT NULL
		 FROM challenge_participants cp
		 JOIN users u ON u.id = cp.user_id
		 LEFT JOIN rides r ON r.user_id = cp.user_id
		      AND COALESCE(r.start_time, r.created_at) >= $3
		      AND COALESCE(r.start_time, r.created_at) <= $4
		 WHERE cp.challenge_id = $1
		 GROUP BY u.id, u.name, u.avatar_url, cp.completed_at
		 ORDER BY progress DESC
		 LIMIT 100`, id, ch.Metric, ch.StartsAt, ch.EndsAt)
	if err != nil {
		httpx.Internal(c, "could not load standings")
		return
	}
	defer rows.Close()
	standings := make([]ChallengeStanding, 0)
	for rows.Next() {
		var s ChallengeStanding
		if err := rows.Scan(&s.UserID, &s.Name, &s.AvatarURL, &s.Progress, &s.Completed); err != nil {
			httpx.Internal(c, "could not read standings")
			return
		}
		if s.UserID == uid {
			ch.MyProgress = s.Progress
		}
		standings = append(standings, s)
	}
	c.JSON(http.StatusOK, gin.H{"challenge": ch, "standings": standings})
}

func (h *handler) joinChallenge(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid challenge id")
		return
	}
	// Insert only when the challenge exists and has not ended.
	tag, err := h.d.DB.Exec(c,
		`INSERT INTO challenge_participants (challenge_id, user_id)
		 SELECT $1, $2 FROM challenges WHERE id = $1 AND ends_at >= now()
		 ON CONFLICT DO NOTHING`, id, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not join challenge")
		return
	}
	if tag.RowsAffected() == 0 {
		// Either already joined, or the challenge is missing/ended.
		httpx.Error(c, http.StatusConflict, "could not join (already joined or challenge ended)")
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *handler) leaveChallenge(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid challenge id")
		return
	}
	if _, err := h.d.DB.Exec(c,
		`DELETE FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2`,
		id, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not leave challenge")
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *handler) deleteChallenge(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid challenge id")
		return
	}
	tag, err := h.d.DB.Exec(c,
		`DELETE FROM challenges WHERE id = $1 AND creator_id = $2`, id, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not delete challenge")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "challenge not found")
		return
	}
	c.Status(http.StatusNoContent)
}

// Invite is a pending challenge invitation shown in the invitee's inbox.
type Invite struct {
	ID          int64   `json:"id"`
	ChallengeID int64   `json:"challenge_id"`
	Title       string  `json:"title"`
	Metric      string  `json:"metric"`
	Goal        float64 `json:"goal"`
	InviterName string  `json:"inviter_name"`
}

type inviteReq struct {
	UserID int64 `json:"user_id" binding:"required"`
}

// inviteToChallenge lets a participant invite another rider, recording a pending
// invite and pushing them a notification. Idempotent per (challenge, invitee).
func (h *handler) inviteToChallenge(c *gin.Context) {
	cid, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid challenge id")
		return
	}
	var req inviteReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	inviter := authpkg.UserID(c)
	if req.UserID == inviter {
		httpx.BadRequest(c, "kendine davet gönderemezsin")
		return
	}
	// Caller must be an active participant of a not-yet-ended challenge.
	var title string
	err = h.d.DB.QueryRow(c,
		`SELECT c.title FROM challenges c
		 JOIN challenge_participants p ON p.challenge_id = c.id AND p.user_id = $2
		 WHERE c.id = $1 AND c.ends_at >= now()`, cid, inviter).Scan(&title)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusForbidden, "bu meydan okumaya davet edemezsin")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load challenge")
		return
	}
	if _, err := h.d.DB.Exec(c,
		`INSERT INTO challenge_invites (challenge_id, inviter_id, invitee_id) VALUES ($1, $2, $3)
		 ON CONFLICT (challenge_id, invitee_id) DO NOTHING`, cid, inviter, req.UserID); err != nil {
		httpx.Internal(c, "could not create invite")
		return
	}

	var inviterName string
	_ = h.d.DB.QueryRow(c, `SELECT name FROM users WHERE id = $1`, inviter).Scan(&inviterName)
	h.notify(req.UserID, push.Notification{
		Title: "Sana meydan okundu! 🏍️",
		Body:  inviterName + " seni \"" + title + "\" yarışmasına davet etti",
		Data:  map[string]any{"type": "challenge_invite", "challenge_id": cid},
	})
	c.Status(http.StatusCreated)
}

// listInvites returns the caller's pending invites to still-active challenges.
func (h *handler) listInvites(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT ci.id, c.id, c.title, c.metric, c.goal, u.name
		 FROM challenge_invites ci
		 JOIN challenges c ON c.id = ci.challenge_id
		 JOIN users u ON u.id = ci.inviter_id
		 WHERE ci.invitee_id = $1 AND ci.status = 'pending' AND c.ends_at >= now()
		 ORDER BY ci.created_at DESC`, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not list invites")
		return
	}
	defer rows.Close()
	out := make([]Invite, 0)
	for rows.Next() {
		var iv Invite
		if err := rows.Scan(&iv.ID, &iv.ChallengeID, &iv.Title, &iv.Metric, &iv.Goal, &iv.InviterName); err != nil {
			httpx.Internal(c, "could not read invites")
			return
		}
		out = append(out, iv)
	}
	c.JSON(http.StatusOK, gin.H{"invites": out})
}

// acceptInvite marks the invite accepted and joins the caller to the challenge.
func (h *handler) acceptInvite(c *gin.Context) {
	iid, err := strconv.ParseInt(c.Param("iid"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid invite id")
		return
	}
	var cid int64
	err = h.d.DB.QueryRow(c,
		`UPDATE challenge_invites SET status = 'accepted'
		 WHERE id = $1 AND invitee_id = $2 AND status = 'pending'
		 RETURNING challenge_id`, iid, authpkg.UserID(c)).Scan(&cid)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "invite not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not accept invite")
		return
	}
	if _, err := h.d.DB.Exec(c,
		`INSERT INTO challenge_participants (challenge_id, user_id)
		 SELECT $1, $2 FROM challenges WHERE id = $1 AND ends_at >= now()
		 ON CONFLICT DO NOTHING`, cid, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not join challenge")
		return
	}
	c.JSON(http.StatusOK, gin.H{"challenge_id": cid})
}

// declineInvite marks the invite declined.
func (h *handler) declineInvite(c *gin.Context) {
	iid, err := strconv.ParseInt(c.Param("iid"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid invite id")
		return
	}
	if _, err := h.d.DB.Exec(c,
		`UPDATE challenge_invites SET status = 'declined'
		 WHERE id = $1 AND invitee_id = $2 AND status = 'pending'`, iid, authpkg.UserID(c)); err != nil {
		httpx.Internal(c, "could not decline invite")
		return
	}
	c.Status(http.StatusNoContent)
}

// notify pushes a notification to all of a user's registered devices in the
// background (best effort, never blocks or fails the request).
func (h *handler) notify(userID int64, n push.Notification) {
	go func() {
		ctx := context.Background()
		rows, err := h.d.DB.Query(ctx, `SELECT token FROM push_tokens WHERE user_id = $1`, userID)
		if err != nil {
			return
		}
		defer rows.Close()
		var tokens []string
		for rows.Next() {
			var t string
			if err := rows.Scan(&t); err == nil {
				tokens = append(tokens, t)
			}
		}
		_ = push.SendToTokens(ctx, tokens, n)
	}()
}

// challengeBadgeType is the stable rewards.type for completing a challenge.
func challengeBadgeType(id int64) string {
	return fmt.Sprintf("challenge_%d", id)
}

// evaluateChallenges checks the rider's joined, active, not-yet-completed
// challenges after a ride and marks/awards any whose goal is now met. Re-reading
// progress from rides keeps it idempotent and safe to call on every ride.
func (h *handler) evaluateChallenges(ctx context.Context, userID int64) {
	rows, err := h.d.DB.Query(ctx,
		`SELECT c.id, c.title, c.metric, c.goal, c.starts_at, c.ends_at
		 FROM challenges c
		 JOIN challenge_participants cp ON cp.challenge_id = c.id
		      AND cp.user_id = $1 AND cp.completed_at IS NULL
		 WHERE now() BETWEEN c.starts_at AND c.ends_at`, userID)
	if err != nil {
		h.d.Log.Error().Err(err).Int64("user_id", userID).Msg("could not load active challenges")
		return
	}
	type active struct {
		id            int64
		title, metric string
		goal          float64
		starts, ends  time.Time
	}
	var list []active
	for rows.Next() {
		var a active
		if err := rows.Scan(&a.id, &a.title, &a.metric, &a.goal, &a.starts, &a.ends); err != nil {
			rows.Close()
			h.d.Log.Error().Err(err).Msg("could not read active challenges")
			return
		}
		list = append(list, a)
	}
	rows.Close()

	for _, a := range list {
		progress, err := h.challengeProgress(ctx, userID, a.metric, a.starts, a.ends)
		if err != nil {
			h.d.Log.Error().Err(err).Int64("challenge_id", a.id).Msg("could not compute challenge progress")
			continue
		}
		if progress < a.goal {
			continue
		}
		// Mark complete (idempotent) and award the per-challenge badge.
		if _, err := h.d.DB.Exec(ctx,
			`UPDATE challenge_participants SET completed_at = now()
			 WHERE challenge_id = $1 AND user_id = $2 AND completed_at IS NULL`, a.id, userID); err != nil {
			h.d.Log.Error().Err(err).Int64("challenge_id", a.id).Msg("could not mark challenge complete")
			continue
		}
		if _, err := h.d.DB.Exec(ctx,
			`INSERT INTO rewards (user_id, type, description) VALUES ($1, $2, $3)
			 ON CONFLICT (user_id, type) DO NOTHING`,
			userID, challengeBadgeType(a.id), "Meydan okuma tamamlandı: "+a.title); err != nil {
			h.d.Log.Error().Err(err).Int64("challenge_id", a.id).Msg("could not award challenge badge")
		}
	}
}

// challengeProgress aggregates the rider's metric over the challenge window.
func (h *handler) challengeProgress(ctx context.Context, userID int64, metric string, starts, ends time.Time) (float64, error) {
	var progress float64
	progressExpr := fmt.Sprintf(metricSQL(""), "$4::text")
	err := h.d.DB.QueryRow(ctx,
		`SELECT COALESCE(`+progressExpr+`, 0)
		 FROM rides
		 WHERE user_id = $1
		   AND COALESCE(start_time, created_at) >= $2
		   AND COALESCE(start_time, created_at) <= $3`,
		userID, starts, ends, metric).Scan(&progress)
	return progress, err
}
