-- Morider App - communities (Topluluk): rider clubs with admin-only broadcasts.
--
-- communities: anyone may create one; 'public' communities are joinable
-- instantly while 'closed' ones require admin approval.
--
-- community_members: role decides who may publish posts (owner/admin) versus
-- who may only comment and like (member). status 'pending' models a join
-- request awaiting approval in a closed community.
--
-- community_posts: admin broadcasts. Besides text + photos a post may carry an
-- optional attachment: a shared route, an event announcement, or a poll
-- (poll_question non-null means the post has one). The comment/like tables
-- deliberately mirror the feed's post_comments shape so the mobile CommentsView
-- component renders both without changes, but they are separate tables:
-- community posts must never leak into the global feed queries.

CREATE TABLE IF NOT EXISTS communities (
    id          BIGSERIAL   PRIMARY KEY,
    name        TEXT        NOT NULL,
    description TEXT,
    privacy     TEXT        NOT NULL DEFAULT 'public',
    avatar_url  TEXT,
    created_by  BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT communities_privacy_chk CHECK (privacy IN ('public', 'closed'))
);
-- pg_trgm is enabled by 0016; the trigram index serves discovery search (?q=).
CREATE INDEX IF NOT EXISTS idx_communities_name_trgm ON communities USING gin (name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS community_members (
    community_id BIGINT      NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT        NOT NULL DEFAULT 'member',
    status       TEXT        NOT NULL DEFAULT 'active',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, user_id),
    CONSTRAINT community_members_role_chk   CHECK (role IN ('owner', 'admin', 'member')),
    CONSTRAINT community_members_status_chk CHECK (status IN ('active', 'pending'))
);
CREATE INDEX IF NOT EXISTS idx_community_members_user ON community_members (user_id);

CREATE TABLE IF NOT EXISTS community_posts (
    id            BIGSERIAL   PRIMARY KEY,
    community_id  BIGINT      NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body          TEXT        NOT NULL DEFAULT '',
    route_id      BIGINT      REFERENCES routes(id) ON DELETE SET NULL,
    event_id      BIGINT      REFERENCES events(id) ON DELETE SET NULL,
    poll_question TEXT,
    pinned        BOOLEAN     NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_community_posts_feed ON community_posts (community_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_post_photos (
    id       BIGSERIAL PRIMARY KEY,
    post_id  BIGINT    NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    url      TEXT      NOT NULL,
    position INT       NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_community_post_photos_post ON community_post_photos (post_id, position);

CREATE TABLE IF NOT EXISTS community_post_likes (
    post_id    BIGINT      NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS community_post_comments (
    id         BIGSERIAL   PRIMARY KEY,
    post_id    BIGINT      NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT        NOT NULL,
    parent_id  BIGINT      REFERENCES community_post_comments(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_community_post_comments_post ON community_post_comments (post_id, created_at);

CREATE TABLE IF NOT EXISTS community_post_comment_likes (
    comment_id BIGINT      NOT NULL REFERENCES community_post_comments(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, user_id)
);

CREATE TABLE IF NOT EXISTS community_poll_options (
    id       BIGSERIAL PRIMARY KEY,
    post_id  BIGINT    NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    label    TEXT      NOT NULL,
    position INT       NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_community_poll_options_post ON community_poll_options (post_id, position);

-- One vote per user per poll; changing a vote is an upsert on the PK.
CREATE TABLE IF NOT EXISTS community_poll_votes (
    post_id    BIGINT      NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    option_id  BIGINT      NOT NULL REFERENCES community_poll_options(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_poll_votes_option ON community_poll_votes (option_id);
