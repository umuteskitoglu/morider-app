// Package notify is the single path by which anything in Morider tells a rider
// that something happened: it writes the durable notification row AND fires the
// push, from one call, so the in-app bildirim merkezi and the lock screen can
// never disagree.
//
// It replaces what used to be copy-pasted into every service that had anything
// to say: the FCM-or-Expo sender bootstrap (four copies), the
// "SELECT token FROM push_tokens WHERE user_id = $1" lookup (five copies) and
// the "go func(){ ctx := context.Background(); ... }" detach (six copies).
package notify

import (
	"context"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/push"
)

// Kind is the stable event discriminator. It is written to notifications.type
// AND sent as the push data["type"], so the mobile router has exactly one
// vocabulary to switch on.
//
// Never rename a Kind: pushes already in flight and rows already in the table
// use these strings, and an unknown kind on the client degrades to "just open
// the app".
type Kind string

const (
	KindDM                   Kind = "dm"
	KindCommunityPost        Kind = "community_post"
	KindCommunityJoinRequest Kind = "community_join_request"
	KindCommunityApproved    Kind = "community_approved"
	KindChallengeInvite      Kind = "challenge_invite"
	KindSOS                  Kind = "sos"
	KindFollow               Kind = "follow"
	KindPostLike             Kind = "post_like"
	KindPostComment          Kind = "post_comment"
	KindSegmentKOM           Kind = "segment_kom"
)

// Event is one thing that happened, described once and delivered to one or many
// riders.
type Event struct {
	Kind Kind

	// ActorID is the rider who caused it (0 = system). It is dropped from the
	// audience, drives the avatar and name the notification center renders, and
	// is what user_blocks is checked against.
	ActorID int64

	// EntityID is what the notification points at: post / community / challenge
	// / conversation / segment / sos id — or, for a follow, the actor's own user
	// id. The mobile router turns (Kind, EntityID) into a screen.
	EntityID int64

	Title string
	Body  string

	// Data is merged over the derived payload {"type", "entity_id"}. Use it for
	// the extra keys a push already carries (an SOS's lat/lon, the post id
	// inside a community broadcast).
	Data map[string]any

	// Collapse, when non-empty, folds repeat events onto ONE unread row per
	// (recipient, kind, entity, collapse) instead of stacking them: ten likes on
	// one gönderi become one row with event_count = 10.
	Collapse string

	// PushOnly skips the notifications row. Used by DMs: the DM inbox already is
	// their notification center and the Chat tab already badges them, so a row
	// here would only double-count.
	PushOnly bool

	// IgnoreBlocks delivers even across a user_blocks edge. SOS only: a social
	// block is a preference, not a reason to withhold a crash alert.
	IgnoreBlocks bool
}

// Notifier is built once per service at boot and shared by every producer in it.
type Notifier struct {
	db     *pgxpool.Pool
	sender push.Sender
	log    zerolog.Logger
}

// New builds a Notifier, choosing FCM HTTP v1 when cfg.FCMCredentialsFile is set
// and falling back to the Expo relay otherwise. This is the only remaining copy
// of that decision.
func New(db *pgxpool.Pool, cfg config.Config, log zerolog.Logger) *Notifier {
	n := &Notifier{db: db, sender: push.ExpoSender{}, log: log}
	if cfg.FCMCredentialsFile == "" {
		return n
	}
	sa, err := os.ReadFile(cfg.FCMCredentialsFile)
	if err != nil {
		log.Warn().Err(err).Msg("could not read FCM credentials, falling back to Expo push")
		return n
	}
	sender, err := push.NewFCMSender(sa)
	if err != nil {
		log.Warn().Err(err).Msg("invalid FCM credentials, falling back to Expo push")
		return n
	}
	n.sender = sender
	log.Info().Msg("push: using FCM HTTP v1")
	return n
}

// To delivers to one rider. It never blocks and never fails the caller: it
// detaches onto its own goroutine with a fresh context, because every caller is
// on a request path whose context dies the moment the response is written.
func (n *Notifier) To(recipientID int64, ev Event) {
	if n == nil || recipientID == 0 {
		return
	}
	n.detach(func(ctx context.Context) {
		n.Deliver(ctx, []int64{recipientID}, ev)
	})
}

// ToAudience delivers to every user id returned by audienceSQL, which must
// select exactly one BIGINT column of user ids:
//
//	n.ToAudience(`SELECT user_id FROM community_members
//	              WHERE community_id = $1 AND status = 'active'`, []any{cid}, ev)
//
// Same detach semantics as To.
func (n *Notifier) ToAudience(audienceSQL string, args []any, ev Event) {
	if n == nil {
		return
	}
	n.detach(func(ctx context.Context) {
		ids, err := n.userIDs(ctx, audienceSQL, args...)
		if err != nil || len(ids) == 0 {
			return
		}
		n.Deliver(ctx, ids, ev)
	})
}

// UserName resolves a rider's display name for push copy. Producers need it to
// build "Ali seni takip etmeye başladı"; this replaces the hand-written
// `SELECT name FROM users WHERE id = $1` lookups that were scattered around.
// Returns "Bir sürücü" when the name is missing, never an empty string.
func (n *Notifier) UserName(ctx context.Context, id int64) string {
	var name string
	if n != nil && id != 0 {
		_ = n.db.QueryRow(ctx, `SELECT COALESCE(name, '') FROM users WHERE id = $1`, id).Scan(&name)
	}
	if name == "" {
		return "Bir sürücü"
	}
	return name
}
