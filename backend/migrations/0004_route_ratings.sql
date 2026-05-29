-- Morider App - route ratings (1..5 stars, one vote per user per route)

CREATE TABLE IF NOT EXISTS route_ratings (
    id         BIGSERIAL PRIMARY KEY,
    route_id   BIGINT      NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score      SMALLINT    NOT NULL CHECK (score BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (route_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_route_ratings_route ON route_ratings(route_id);
