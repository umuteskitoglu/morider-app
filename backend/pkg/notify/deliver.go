package notify

import (
	"context"
	"encoding/json"
	"time"

	"github.com/morider/backend/pkg/push"
)

// detachTimeout bounds the work a detached delivery may do. Generous, because
// FCM sends one sequential HTTP request per device token.
const detachTimeout = 30 * time.Second

// detach runs fn on its own goroutine with a fresh context.
//
// The recover is not decoration: gin.Recovery() only wraps the request
// goroutine, so a panic in here would take the whole process down. Notifying a
// rider must never be able to kill the service that was doing something useful.
func (n *Notifier) detach(fn func(context.Context)) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				n.log.Error().Interface("panic", r).Msg("notify: recovered from panic in delivery")
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), detachTimeout)
		defer cancel()
		fn(ctx)
	}()
}

// Deliver is the blocking form of To/ToAudience, for the one caller that needs
// the addressed-device count in its response body (telemetry's SOS `notified`).
// The database work happens synchronously; the push itself is still detached, so
// a caller on the request path never waits on FCM.
//
// The return value is devices *addressed*, not delivered.
func (n *Notifier) Deliver(ctx context.Context, recipientIDs []int64, ev Event) int {
	if n == nil {
		return 0
	}
	ids := dedupe(recipientIDs, ev.ActorID)
	if len(ids) == 0 {
		return 0
	}
	if ev.ActorID != 0 && !ev.IgnoreBlocks {
		ids = n.filterBlocked(ctx, ids, ev.ActorID)
		if len(ids) == 0 {
			return 0
		}
	}

	// Who actually gets a push. Without a row to collapse onto (PushOnly, or a
	// non-collapsing kind) that is everyone; with one, the throttle decides.
	pushTo := ids
	if !ev.PushOnly {
		pushTo = n.persist(ctx, ids, ev)
		if len(pushTo) == 0 {
			return 0
		}
	}

	tokens, err := n.tokensFor(ctx, pushTo)
	if err != nil || len(tokens) == 0 {
		return 0
	}
	n.send(tokens, ev)
	return len(tokens)
}

// persist writes one notification row per recipient and returns the recipients
// whose row should also cause a push. A collapsed row that was refreshed less
// than ten minutes ago is written but stays silent.
func (n *Notifier) persist(ctx context.Context, ids []int64, ev Event) []int64 {
	data, err := json.Marshal(mergeData(ev))
	if err != nil {
		data = []byte(`{}`)
	}
	rows, err := n.db.Query(ctx,
		`INSERT INTO notifications
		     (user_id, actor_id, type, entity_id, title, body, data, collapse_key, pushed_at)
		 SELECT u, NULLIF($2, 0::bigint), $3, NULLIF($4, 0::bigint), $5, $6, $7::jsonb, NULLIF($8, ''), now()
		 FROM unnest($1::bigint[]) AS u
		 ON CONFLICT (user_id, type, entity_id, collapse_key)
		   WHERE read_at IS NULL AND collapse_key IS NOT NULL
		 DO UPDATE SET event_count = notifications.event_count + 1,
		               actor_id    = EXCLUDED.actor_id,
		               title       = EXCLUDED.title,
		               body        = EXCLUDED.body,
		               data        = EXCLUDED.data,
		               updated_at  = now(),
		               pushed_at   = CASE
		                               WHEN notifications.pushed_at < now() - INTERVAL '10 minutes'
		                               THEN now() ELSE notifications.pushed_at
		                             END
		 RETURNING user_id, (pushed_at >= now())`,
		ids, ev.ActorID, string(ev.Kind), ev.EntityID, ev.Title, ev.Body, string(data), ev.Collapse)
	if err != nil {
		n.log.Error().Err(err).Str("kind", string(ev.Kind)).Msg("notify: could not persist notifications")
		return nil
	}
	defer rows.Close()

	out := make([]int64, 0, len(ids))
	for rows.Next() {
		var uid int64
		var shouldPush bool
		if err := rows.Scan(&uid, &shouldPush); err == nil && shouldPush {
			out = append(out, uid)
		}
	}
	return out
}

// send fires the push on its own goroutine. Best effort by design: a failed push
// must never break the thing that triggered it.
func (n *Notifier) send(tokens []string, ev Event) {
	msg := push.Notification{Title: ev.Title, Body: ev.Body, Data: mergeData(ev)}
	n.detach(func(ctx context.Context) {
		if err := n.sender.SendToTokens(ctx, tokens, msg); err != nil {
			n.log.Warn().Err(err).Str("kind", string(ev.Kind)).Msg("notify: push send failed")
		}
	})
}

// mergeData builds the push payload: the derived routing keys, with the event's
// own Data laid over them.
func mergeData(ev Event) map[string]any {
	data := map[string]any{"type": string(ev.Kind)}
	if ev.EntityID != 0 {
		data["entity_id"] = ev.EntityID
	}
	for k, v := range ev.Data {
		data[k] = v
	}
	return data
}

// tokensFor collects every device token of the given riders. This is the only
// remaining copy of this query.
func (n *Notifier) tokensFor(ctx context.Context, ids []int64) ([]string, error) {
	rows, err := n.db.Query(ctx, `SELECT token FROM push_tokens WHERE user_id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tokens := make([]string, 0, len(ids))
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil && t != "" {
			tokens = append(tokens, t)
		}
	}
	return tokens, rows.Err()
}

// userIDs runs an audience query that must select exactly one BIGINT column.
func (n *Notifier) userIDs(ctx context.Context, query string, args ...any) ([]int64, error) {
	rows, err := n.db.Query(ctx, query, args...)
	if err != nil {
		n.log.Error().Err(err).Msg("notify: could not resolve audience")
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err == nil && id != 0 {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

// filterBlocked drops riders on either side of a user_blocks edge with the
// actor. Blocking is stored one-directional but always enforced both ways, the
// same way chat treats it.
func (n *Notifier) filterBlocked(ctx context.Context, ids []int64, actorID int64) []int64 {
	kept, err := n.userIDs(ctx,
		`SELECT u FROM unnest($1::bigint[]) AS u
		 WHERE NOT EXISTS (
		   SELECT 1 FROM user_blocks b
		   WHERE (b.blocker_id = u AND b.blocked_id = $2)
		      OR (b.blocker_id = $2 AND b.blocked_id = u))`,
		ids, actorID)
	if err != nil {
		// A failed block check must not turn into "notify everyone".
		return nil
	}
	return kept
}

// dedupe removes repeats and the actor: you are never told about your own
// action, and one rider gets one notification even if two paths reach them.
func dedupe(ids []int64, actorID int64) []int64 {
	seen := make(map[int64]struct{}, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id == 0 || id == actorID {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}
