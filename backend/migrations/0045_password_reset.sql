-- Morider App - Password reset
--
-- A rider who forgets their password had no way back into the account: the
-- only credential paths were signup, login and Google. This adds a short-lived
-- one-time code, mailed to the address on the account.
--
-- Design notes:
--
-- 1. code_hash stores a bcrypt hash, never the code itself. A reset code is a
--    password equivalent for the few minutes it lives, and a leaked database
--    dump must not hand out account takeovers.
--
-- 2. attempts is checked and incremented server-side. Six digits is only a
--    million possibilities, which is nothing without a cap — the code is short
--    because a human has to retype it from an email, so the guess budget is
--    what actually makes it safe.
--
-- 3. consumed_at marks a code as spent rather than deleting the row, so a
--    replay of the same code is distinguishable from an expired one in the
--    logs. Rows are pruned by expiry, not on use.
--
-- 4. ON DELETE CASCADE: outstanding codes must not outlive the account they
--    unlock.

CREATE TABLE IF NOT EXISTS password_resets (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash   TEXT        NOT NULL,
    attempts    INT         NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The verify path looks up the newest live code for one account; the prune
-- path sweeps by expiry.
CREATE INDEX IF NOT EXISTS idx_password_resets_user
    ON password_resets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_resets_expiry
    ON password_resets (expires_at);
