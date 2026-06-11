-- Morider App - rota üzeri mola noktaları (POI)
-- Community points of interest: moto-friendly cafes, fuel, repair shops,
-- viewpoints and rest stops. Stored as PostGIS points so routes can pull the
-- POIs near their geometry with a single ST_DWithin query.

CREATE TABLE IF NOT EXISTS pois (
    id          BIGSERIAL   PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    category    TEXT        NOT NULL CHECK (category IN ('cafe', 'fuel', 'repair', 'viewpoint', 'rest')),
    description TEXT,
    location    geometry(Point, 4326) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pois_location ON pois USING GIST(location);
CREATE INDEX IF NOT EXISTS idx_pois_user ON pois(user_id);
