-- Morider App - planned ride events (Faz 6)
-- An organizer schedules an event with a meet time and a departure time. A route
-- is optional: when none is set the event carries free-form start/end locations.
-- People join by code or invite link, set their RSVP (going/maybe/declined) and
-- chat in real time over the event WebSocket.

CREATE TABLE IF NOT EXISTS events (
    id          BIGSERIAL   PRIMARY KEY,
    code        TEXT        NOT NULL UNIQUE,
    host_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT        NOT NULL,
    description TEXT,
    meet_at     TIMESTAMPTZ NOT NULL,                              -- buluşma tarihi/saati
    start_at    TIMESTAMPTZ NOT NULL,                              -- kalkış tarihi/saati
    route_id    BIGINT      REFERENCES routes(id) ON DELETE SET NULL, -- opsiyonel rota
    -- Free-form start/end points, used when no route is attached.
    start_lat   DOUBLE PRECISION,
    start_lon   DOUBLE PRECISION,
    start_name  TEXT,
    end_lat     DOUBLE PRECISION,
    end_lon     DOUBLE PRECISION,
    end_name    TEXT,
    status      TEXT        NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_host ON events(host_id, status);
CREATE INDEX IF NOT EXISTS idx_events_code ON events(code);

CREATE TABLE IF NOT EXISTS event_participants (
    event_id  BIGINT      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id   BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rsvp      TEXT        NOT NULL DEFAULT 'going' CHECK (rsvp IN ('going', 'maybe', 'declined')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS event_messages (
    id         BIGSERIAL   PRIMARY KEY,
    event_id   BIGINT      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_messages_event ON event_messages(event_id, created_at);
