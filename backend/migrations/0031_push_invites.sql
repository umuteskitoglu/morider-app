-- Remote push tokens (Expo) per device, and challenge invites.
-- One row per device token; a token belongs to whichever user last registered it.
CREATE TABLE IF NOT EXISTS push_tokens (
    token      TEXT        PRIMARY KEY,            -- Expo push token (ExponentPushToken[...])
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform   TEXT,                               -- 'ios' | 'android'
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);

-- Challenge invites: a participant invites another rider to a challenge.
CREATE TABLE IF NOT EXISTS challenge_invites (
    id           BIGSERIAL   PRIMARY KEY,
    challenge_id BIGINT      NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    inviter_id   BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_id   BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT        NOT NULL DEFAULT 'pending', -- pending | accepted | declined
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (challenge_id, invitee_id)
);
CREATE INDEX IF NOT EXISTS idx_challenge_invites_invitee ON challenge_invites(invitee_id, status);
