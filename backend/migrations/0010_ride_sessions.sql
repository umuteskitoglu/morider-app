-- Morider App - live group ride sessions (Faz 5)
-- A host opens a session (optionally tied to a route); invited friends (mutual
-- followers) join by code and share live GPS over the telemetry WebSocket.

CREATE TABLE IF NOT EXISTS ride_sessions (
    id         BIGSERIAL   PRIMARY KEY,
    code       TEXT        NOT NULL UNIQUE,
    host_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    route_id   BIGINT      REFERENCES routes(id) ON DELETE SET NULL,
    status     TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ride_sessions_code ON ride_sessions(code);
CREATE INDEX IF NOT EXISTS idx_ride_sessions_host ON ride_sessions(host_id, status);

CREATE TABLE IF NOT EXISTS session_participants (
    session_id BIGINT      NOT NULL REFERENCES ride_sessions(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, user_id)
);
