-- Morider App - user blocking
--
-- user_blocks: one row per blocker->blocked edge. Blocking is one-directional
-- (like follows) but both chat.go and the mobile client check it in either
-- direction so a block always stops contact both ways.

CREATE TABLE IF NOT EXISTS user_blocks (
    id         BIGSERIAL PRIMARY KEY,
    blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_blocks_not_self_chk CHECK (blocker_id <> blocked_id),
    UNIQUE (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks (blocked_id);
