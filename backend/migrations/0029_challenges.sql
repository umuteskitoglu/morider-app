-- Challenges: time-boxed competitions over a metric (total distance, total
-- elevation gain, or ride count). Riders join; progress is aggregated from their
-- rides within the challenge window. Reaching the goal marks the participant
-- complete and awards a per-challenge badge (handled in the reward engine).
CREATE TABLE IF NOT EXISTS challenges (
    id          BIGSERIAL        PRIMARY KEY,
    creator_id  BIGINT           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT             NOT NULL,
    description TEXT,
    metric      TEXT             NOT NULL,            -- 'distance' | 'elevation' | 'rides'
    goal        DOUBLE PRECISION NOT NULL,            -- target: km | m | ride count
    starts_at   TIMESTAMPTZ      NOT NULL,
    ends_at     TIMESTAMPTZ      NOT NULL,
    created_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_challenges_window ON challenges(ends_at);

CREATE TABLE IF NOT EXISTS challenge_participants (
    challenge_id BIGINT      NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,                          -- set when the goal is reached
    PRIMARY KEY (challenge_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_challenge_participants_user ON challenge_participants(user_id);
