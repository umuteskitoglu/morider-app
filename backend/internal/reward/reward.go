// Package reward implements the gamification (badges/points) service.
package reward

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/events"
	"github.com/morider/backend/pkg/httpx"
)

// Run boots the reward service.
func Run(cfg config.Config) error {
	deps, err := server.New(context.Background(), "reward", cfg)
	if err != nil {
		return err
	}
	h := &handler{d: deps}

	// NATS drives the automatic rules engine. It is optional: without it the
	// REST endpoints (including manual award) still work, only auto-badging stops.
	if nc, err := nats.Connect(cfg.NATSURL, nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1)); err != nil {
		deps.Log.Warn().Err(err).Msg("nats unavailable, automatic rewards disabled")
	} else {
		h.nats = nc
		if _, err := nc.Subscribe(events.SubjectRideCompleted, h.onRideCompleted); err != nil {
			deps.Log.Error().Err(err).Msg("could not subscribe to ride.completed")
		}
		if _, err := nc.Subscribe(events.SubjectSessionRoster, h.onSessionRoster); err != nil {
			deps.Log.Error().Err(err).Msg("could not subscribe to session.roster")
		}
	}

	registerRoutes(deps, h)
	return deps.Run(config.ResolvePort("REWARD_PORT", "8085"))
}

func registerRoutes(d *server.Deps, h *handler) {
	g := d.Engine.Group("/api", d.JWT.Middleware())
	g.GET("/rewards", h.list)
	g.POST("/rewards", h.award)
	g.PUT("/rewards/showcase", h.showcase)
	g.GET("/rewards/user/:uid", h.userBadges)
	g.GET("/leaderboard/top", h.leaderboard)
	g.GET("/leaderboard/following", h.leaderboardFollowing)
	registerChallengeRoutes(g, h)
}

type handler struct {
	d    *server.Deps
	nats *nats.Conn
}

// Reward is the API representation of an earned badge/achievement.
type Reward struct {
	ID          int64     `json:"id"`
	UserID      int64     `json:"user_id"`
	Type        string    `json:"type"`
	Description string    `json:"description"`
	AwardedAt   time.Time `json:"awarded_at"`
	Showcased   bool      `json:"showcased"`
}

func (h *handler) list(c *gin.Context) {
	h.queryRewards(c, "user_id = $1", authpkg.UserID(c))
}

// userBadges returns another user's showcased badges (for their profile).
func (h *handler) userBadges(c *gin.Context) {
	uid, err := strconv.ParseInt(c.Param("uid"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	h.queryRewards(c, "user_id = $1 AND showcased = true", uid)
}

func (h *handler) queryRewards(c *gin.Context, where string, arg any) {
	rows, err := h.d.DB.Query(c,
		`SELECT id, user_id, type, COALESCE(description, ''), awarded_at, showcased
		 FROM rewards WHERE `+where+` ORDER BY awarded_at DESC`, arg)
	if err != nil {
		httpx.Internal(c, "could not list rewards")
		return
	}
	defer rows.Close()

	rewards := make([]Reward, 0)
	for rows.Next() {
		var r Reward
		if err := rows.Scan(&r.ID, &r.UserID, &r.Type, &r.Description, &r.AwardedAt, &r.Showcased); err != nil {
			httpx.Internal(c, "could not read rewards")
			return
		}
		rewards = append(rewards, r)
	}
	c.JSON(http.StatusOK, gin.H{"rewards": rewards})
}

type showcaseReq struct {
	Types []string `json:"types"`
}

// showcase sets which of the caller's badges are featured on their profile.
func (h *handler) showcase(c *gin.Context) {
	var req showcaseReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	if _, err := h.d.DB.Exec(c,
		`UPDATE rewards SET showcased = (type = ANY($2)) WHERE user_id = $1`,
		authpkg.UserID(c), req.Types,
	); err != nil {
		httpx.Internal(c, "could not update showcase")
		return
	}
	h.queryRewards(c, "user_id = $1", authpkg.UserID(c))
}

type awardReq struct {
	Type        string `json:"type" binding:"required"`
	Description string `json:"description"`
}

func (h *handler) award(c *gin.Context) {
	var req awardReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	var r Reward
	err := h.d.DB.QueryRow(c,
		`INSERT INTO rewards (user_id, type, description)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, type) DO NOTHING
		 RETURNING id, user_id, type, COALESCE(description, ''), awarded_at`,
		authpkg.UserID(c), req.Type, req.Description,
	).Scan(&r.ID, &r.UserID, &r.Type, &r.Description, &r.AwardedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// No row returned means the unique (user_id, type) badge already exists.
		httpx.Error(c, http.StatusConflict, "reward already awarded")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not award reward")
		return
	}
	c.JSON(http.StatusCreated, r)
}

type leaderboardEntry struct {
	UserID        int64   `json:"user_id"`
	Name          string  `json:"name"`
	AvatarURL     string  `json:"avatar_url"`
	TotalDistance float64 `json:"total_distance"`
	RideCount     int64   `json:"ride_count"`
	AvgSpeed      float64 `json:"avg_speed"`
}

// leaderboard ranks every rider by total distance.
func (h *handler) leaderboard(c *gin.Context) {
	h.runLeaderboard(c, false)
}

// leaderboardFollowing ranks only the caller and the people they follow, so a
// rider competes within their own circle.
func (h *handler) leaderboardFollowing(c *gin.Context) {
	h.runLeaderboard(c, true)
}

// runLeaderboard ranks riders by total distance. With followingOnly the pool is
// the caller plus everyone they follow; otherwise it is everyone. ?period=week
// restricts the ride aggregates to the current ISO week (riders still appear
// with zeroed totals when they have no rides in range).
func (h *handler) runLeaderboard(c *gin.Context, followingOnly bool) {
	// Period filter lives in the LEFT JOIN's ON clause (not WHERE) so users with
	// no rides this week still show up at the bottom with zeros.
	rideFilter := ""
	if c.Query("period") == "week" {
		rideFilter = "AND r.start_time >= date_trunc('week', now())"
	}

	where := ""
	var args []any
	if followingOnly {
		where = `WHERE u.id = $1 OR u.id IN (SELECT followee_id FROM follows WHERE follower_id = $1)`
		args = append(args, authpkg.UserID(c))
	}

	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, COALESCE(u.avatar_url, ''),
		        COALESCE(SUM(r.distance), 0) AS total,
		        COUNT(r.id) AS rides,
		        COALESCE(SUM(r.distance) / NULLIF(SUM(EXTRACT(EPOCH FROM (r.end_time - r.start_time))) / 3600.0, 0), 0) AS avg_speed
		 FROM users u
		 LEFT JOIN rides r ON r.user_id = u.id `+rideFilter+`
		 `+where+`
		 GROUP BY u.id, u.name, u.avatar_url
		 ORDER BY total DESC
		 LIMIT 50`, args...)
	if err != nil {
		httpx.Internal(c, "could not load leaderboard")
		return
	}
	defer rows.Close()

	entries := make([]leaderboardEntry, 0)
	for rows.Next() {
		var e leaderboardEntry
		if err := rows.Scan(&e.UserID, &e.Name, &e.AvatarURL, &e.TotalDistance, &e.RideCount, &e.AvgSpeed); err != nil {
			httpx.Internal(c, "could not read leaderboard")
			return
		}
		entries = append(entries, e)
	}
	c.JSON(http.StatusOK, gin.H{"leaderboard": entries})
}
