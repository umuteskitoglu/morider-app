-- Morider App - photo posts (Instagram-style feed)

CREATE TABLE IF NOT EXISTS posts (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    caption       TEXT,
    location_name TEXT,
    lat           DOUBLE PRECISION,
    lon           DOUBLE PRECISION,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS post_photos (
    id        BIGSERIAL PRIMARY KEY,
    post_id   BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    url       TEXT   NOT NULL,
    position  INT    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_post_photos_post ON post_photos(post_id, position);
