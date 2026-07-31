package notify

import (
	"context"
	"time"
)

const (
	// pruneInterval is how often the retention sweep runs. There is no scheduler
	// in this stack (NATS carries events, not cron), so this is a plain ticker on
	// the one service that owns the read API.
	pruneInterval = 24 * time.Hour
	// pruneDelay lets the service finish booting before the first sweep.
	pruneDelay = 5 * time.Minute
)

// StartPruner keeps the notifications table from growing without bound. Call it
// from exactly one service (user.Run) — running it from several would just do
// the same DELETEs concurrently.
//
// It returns immediately; the sweep runs until ctx is cancelled.
func (n *Notifier) StartPruner(ctx context.Context) {
	if n == nil {
		return
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				n.log.Error().Interface("panic", r).Msg("notify: recovered from panic in pruner")
			}
		}()
		timer := time.NewTimer(pruneDelay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				n.prune(ctx)
				timer.Reset(pruneInterval)
			}
		}
	}()
}

// prune drops notifications nobody will look at again: anything older than
// ninety days, and anything read more than thirty days ago.
func (n *Notifier) prune(ctx context.Context) {
	tag, err := n.db.Exec(ctx,
		`DELETE FROM notifications
		 WHERE created_at < now() - INTERVAL '90 days'
		    OR (read_at IS NOT NULL AND read_at < now() - INTERVAL '30 days')`)
	if err != nil {
		n.log.Warn().Err(err).Msg("notify: could not prune notifications")
		return
	}
	if rows := tag.RowsAffected(); rows > 0 {
		n.log.Info().Int64("rows", rows).Msg("notify: pruned old notifications")
	}
}
