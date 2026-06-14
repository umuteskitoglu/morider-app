-- Morider App - profile enhancements (Faz 1/2)
-- A short user bio, and soft-archiving for posts (archived posts are hidden
-- from the feed and the profile grid but can be restored).

ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Active (non-archived) posts per user, newest first — backs the profile grid
-- and feed queries.
CREATE INDEX IF NOT EXISTS idx_posts_user_active
    ON posts(user_id, created_at DESC) WHERE archived_at IS NULL;
