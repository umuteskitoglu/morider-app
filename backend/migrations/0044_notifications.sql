-- Morider App - notifications (bildirim merkezi)
--
-- Push was write-only. A like, a follow, a topluluk approval or a challenge
-- invite existed for exactly as long as the operating system kept the banner on
-- screen: nothing was written down, so a rider who had the app closed, muted
-- notifications, or simply swiped the banner away had no way to ever find out
-- what happened. There was no history, no unread count, no second chance.
--
-- This table is the durable half of every notification. pkg/notify writes a row
-- here and fires the push from the same call, so the bell icon and the lock
-- screen can never disagree about what a rider has been told.

CREATE TABLE IF NOT EXISTS notifications (
  id           BIGSERIAL   PRIMARY KEY,
  -- Who sees it.
  user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Who caused it. NULL for system events; drives the avatar and name the
  -- notification center renders next to the row.
  actor_id     BIGINT      REFERENCES users(id) ON DELETE CASCADE,
  -- Stable event kind, mirrored by pkg/notify.Kind and by the push data["type"]
  -- the mobile router switches on. Free text on purpose: adding a kind must not
  -- need a migration, and an unknown kind degrades to "just open the app".
  type         TEXT        NOT NULL,
  -- What the notification points at: post / community / challenge /
  -- conversation / segment / sos id — or the actor's own user id for a follow.
  -- The client turns (type, entity_id) into a screen.
  entity_id    BIGINT,
  -- Rendered in Turkish at write time by the producer that actually has the
  -- context (community name, challenge title, rider name). Storing the text
  -- rather than re-deriving it means a renamed community does not rewrite
  -- history the rider already read.
  title        TEXT        NOT NULL DEFAULT '',
  body         TEXT        NOT NULL DEFAULT '',
  -- Extra routing payload: post_id inside a community post, lat/lon on an SOS.
  data         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Set for the kinds that fold. Ten people liking one gönderi is one fact, not
  -- ten rows. NULL means "always a new row" — a follow, a comment and an invite
  -- each carry distinct content that folding would destroy.
  collapse_key TEXT,
  -- How many events folded into this row, so the client can say "Ali ve 9 kişi".
  event_count  INT         NOT NULL DEFAULT 1,
  -- Last time this row actually caused a push. A collapsed row re-pushes at most
  -- once per 10 minutes, so a popular gönderi cannot vibrate a phone forty times.
  pushed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- You are never notified about your own action.
  CONSTRAINT notifications_not_self_chk CHECK (actor_id IS NULL OR actor_id <> user_id)
);

-- "My list, newest first" — the notification center.
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

-- "My unread count" is polled by every signed-in device, so it gets a partial
-- index holding only the handful of rows that can possibly matter.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id) WHERE read_at IS NULL;

-- The collapse target. Only unread, only collapsible rows take part: once a
-- rider has read "3 kişi beğendi", the next like starts a fresh row instead of
-- silently mutating something they already saw.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_collapse
  ON notifications (user_id, type, entity_id, collapse_key)
  WHERE read_at IS NULL AND collapse_key IS NOT NULL;

-- Clearing a tapped entity ("mark everything about this post read").
CREATE INDEX IF NOT EXISTS idx_notifications_user_entity
  ON notifications (user_id, type, entity_id) WHERE read_at IS NULL;
