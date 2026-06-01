-- Morider App - threaded comments: unlimited-depth replies + comment likes.

ALTER TABLE post_comments
    ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES post_comments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_post_comments_parent ON post_comments(parent_id);

CREATE TABLE IF NOT EXISTS post_comment_likes (
    id         BIGSERIAL PRIMARY KEY,
    comment_id BIGINT      NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_post_comment_likes_comment ON post_comment_likes(comment_id);
