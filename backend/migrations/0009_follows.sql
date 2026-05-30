-- Morider App - follows (one-directional, Instagram-style)
-- Replaces the mutual friendships model (request/accept) from 0008.

CREATE TABLE IF NOT EXISTS follows (
    follower_id BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

DROP TABLE IF EXISTS friendships;
