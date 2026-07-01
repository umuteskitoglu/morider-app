-- Morider App - global chat + one-to-one direct messages
--
-- global_messages: a single community-wide chat room. Flood is limited by a
-- per-user slow mode enforced in the chat service, not by schema.
--
-- conversations: one row per unordered pair of users (user_a < user_b keeps it
-- canonical and the UNIQUE constraint dedupes). Instagram-style gating: a
-- conversation between two riders who do not mutually follow starts as 'pending'
-- and only its requester may write until the other side accepts it, at which
-- point it becomes 'accepted'. 'declined' hides it and blocks further messages.
--
-- direct_messages: messages within a conversation, optionally carrying a shared
-- exact location (lat/lon) for the "send my location" help flow.

CREATE TABLE IF NOT EXISTS global_messages (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT   NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS global_messages_id_idx ON global_messages (id DESC);

CREATE TABLE IF NOT EXISTS conversations (
    id           BIGSERIAL PRIMARY KEY,
    user_a       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT   NOT NULL DEFAULT 'pending',
    requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT conversations_status_chk CHECK (status IN ('pending', 'accepted', 'declined')),
    CONSTRAINT conversations_order_chk  CHECK (user_a < user_b),
    UNIQUE (user_a, user_b)
);
-- The UNIQUE index already serves lookups by user_a; add the mirror for the
-- user_b side so the inbox query's `user_a = $1 OR user_b = $1` is indexed both ways.
CREATE INDEX IF NOT EXISTS conversations_user_b_idx ON conversations (user_b);

CREATE TABLE IF NOT EXISTS direct_messages (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body            TEXT   NOT NULL,
    lat             DOUBLE PRECISION,
    lon             DOUBLE PRECISION,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS direct_messages_conv_idx ON direct_messages (conversation_id, id DESC);
