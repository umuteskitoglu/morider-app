-- Segments & efforts: rider-defined stretches of road (Strava-style). A segment
-- is a short polyline; an "effort" is one ride's timed traversal of it. Efforts
-- are matched from a ride's telemetry track on demand (see segments.go) and feed
-- per-segment leaderboards and personal records.
CREATE TABLE IF NOT EXISTS segments (
    id          BIGSERIAL              PRIMARY KEY,
    user_id     BIGINT                 NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT                   NOT NULL,
    path        geometry(LineString,4326) NOT NULL,
    distance    DOUBLE PRECISION       NOT NULL,           -- km
    curviness   DOUBLE PRECISION       NOT NULL DEFAULT 0,
    visibility  TEXT                   NOT NULL DEFAULT 'public', -- private | public | friends
    created_at  TIMESTAMPTZ            NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_segments_path ON segments USING GIST (path);
CREATE INDEX IF NOT EXISTS idx_segments_user ON segments(user_id);

CREATE TABLE IF NOT EXISTS segment_efforts (
    id              BIGSERIAL        PRIMARY KEY,
    segment_id      BIGINT           NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    ride_id         BIGINT           NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    user_id         BIGINT           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    elapsed_seconds DOUBLE PRECISION NOT NULL,
    avg_speed       DOUBLE PRECISION NOT NULL DEFAULT 0,    -- km/h
    started_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ      NOT NULL DEFAULT now(),
    -- One effort per (segment, ride): re-matching a ride is idempotent.
    UNIQUE (segment_id, ride_id)
);
CREATE INDEX IF NOT EXISTS idx_efforts_segment ON segment_efforts(segment_id, elapsed_seconds);
CREATE INDEX IF NOT EXISTS idx_efforts_user ON segment_efforts(user_id);
