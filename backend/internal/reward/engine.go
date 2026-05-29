package reward

import (
	"context"
	"encoding/json"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/morider/backend/pkg/events"
)

// onRideCompleted is the NATS handler for ride.completed events. It re-evaluates
// the rider's badges from their full history, so it is naturally idempotent and
// resilient to replayed or out-of-order messages.
func (h *handler) onRideCompleted(msg *nats.Msg) {
	var evt events.RideCompleted
	if err := json.Unmarshal(msg.Data, &evt); err != nil {
		h.d.Log.Error().Err(err).Msg("invalid ride.completed event")
		return
	}
	// Background context: this runs outside any HTTP request lifecycle.
	h.evaluateAndAward(context.Background(), evt.UserID)
}

// evaluateAndAward loads the rider's stats, runs the rules and persists any
// newly earned badges. Existing badges are left untouched (ON CONFLICT).
func (h *handler) evaluateAndAward(ctx context.Context, userID int64) {
	stats, err := h.statsFor(ctx, userID)
	if err != nil {
		h.d.Log.Error().Err(err).Int64("user_id", userID).Msg("could not load rider stats")
		return
	}
	for _, b := range Evaluate(stats) {
		if _, err := h.d.DB.Exec(ctx,
			`INSERT INTO rewards (user_id, type, description)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (user_id, type) DO NOTHING`,
			userID, b.Type, b.Description,
		); err != nil {
			h.d.Log.Error().Err(err).Int64("user_id", userID).Str("type", b.Type).Msg("could not award badge")
			continue
		}
	}
}

// statsFor aggregates a rider's history into the Stats the rules consume. The
// scalar aggregates come from one query; the period-based metrics (streak,
// best week, best month) are computed in Go from a single per-ride scan.
func (h *handler) statsFor(ctx context.Context, userID int64) (Stats, error) {
	var s Stats
	if err := h.d.DB.QueryRow(ctx,
		`SELECT COUNT(*),
		        COALESCE(SUM(distance), 0),
		        COALESCE(MAX(distance), 0),
		        COALESCE(MAX(avg_speed) FILTER (WHERE avg_speed BETWEEN 0 AND 300), 0)
		 FROM rides WHERE user_id = $1`, userID,
	).Scan(&s.RideCount, &s.TotalDistance, &s.LongestRide, &s.MaxAvgSpeed); err != nil {
		return s, err
	}

	rows, err := h.d.DB.Query(ctx,
		`SELECT COALESCE(start_time, created_at), distance FROM rides WHERE user_id = $1`, userID)
	if err != nil {
		return s, err
	}
	defer rows.Close()

	var (
		points []RidePoint
		days   []time.Time
	)
	for rows.Next() {
		var p RidePoint
		if err := rows.Scan(&p.At, &p.Distance); err != nil {
			return s, err
		}
		points = append(points, p)
		days = append(days, p.At)
	}
	if err := rows.Err(); err != nil {
		return s, err
	}

	s.LongestStreak = LongestStreak(days)
	s.BestWeekDistance = BestWeekDistance(points)
	s.BestMonthDistance = BestMonthDistance(points)
	return s, nil
}
