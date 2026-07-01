-- Morider App - live rider presence
-- Last-known position of each rider who is sharing their live location. One row
-- per user (upserted on heartbeat); a rider counts as "active" only while their
-- updated_at is recent (see the presence handler's freshness window). The GIST
-- index powers the ST_DWithin nearby query; the updated_at index prunes stale
-- riders efficiently.

CREATE TABLE IF NOT EXISTS rider_presence (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    lat        DOUBLE PRECISION NOT NULL,
    lon        DOUBLE PRECISION NOT NULL,
    geom       geography(Point, 4326) NOT NULL,
    heading    DOUBLE PRECISION,
    speed      DOUBLE PRECISION,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rider_presence_geom_idx    ON rider_presence USING GIST (geom);
CREATE INDEX IF NOT EXISTS rider_presence_updated_idx ON rider_presence (updated_at);
