-- Morider App - group ride moderation (Faz 5): bans keep a kicked rider out.

CREATE TABLE IF NOT EXISTS session_bans (
    session_id BIGINT      NOT NULL REFERENCES ride_sessions(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, user_id)
);
