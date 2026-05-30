-- Morider App - durable group-ride participation log for badges.
-- session_participants rows are deleted when a rider leaves (or is auto-removed
-- by the single-active-session rule), so they can't back cumulative badges.
-- This log keeps one permanent row per (rider, session) with the largest pack
-- size that session ever reached, and the reward service awards group badges
-- from it.

CREATE TABLE IF NOT EXISTS group_ride_logs (
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id BIGINT      NOT NULL REFERENCES ride_sessions(id) ON DELETE CASCADE,
    size       INT         NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_group_ride_logs_user ON group_ride_logs(user_id);
