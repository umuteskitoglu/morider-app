-- Morider App - Google Sign-In
--
-- Adds a second way to authenticate. Three schema consequences:
--
-- 1. password_hash must become nullable. An account created through Google has
--    no password, and storing a fake/empty hash would be worse than NULL: it
--    hides the distinction and invites a login path that compares against
--    something meaningless. A CHECK constraint keeps every row reachable by at
--    least one method.
--
-- 2. google_sub stores Google's stable subject id, which is the only safe join
--    key. Emails are NOT stable identity: a Gmail address can change, and a
--    released Workspace address can be reassigned to a different person. Email
--    is used once, to link an existing account on first sign-in; every later
--    sign-in matches on google_sub.
--
-- 3. email_verified records whether the address has actually been proven. Rows
--    predating this migration were created by password signup, which never
--    verified anything, so they default to false. Google-linked rows are set
--    true because Google asserts it (and the backend rejects tokens where it
--    is not).

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

-- One Google account maps to at most one Morider account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
    ON users (google_sub) WHERE google_sub IS NOT NULL;

-- Every account must remain reachable: a password, a Google link, or both.
-- Without this, a future "unlink Google" feature could strand an account with
-- no way back in.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_has_auth_method'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_has_auth_method
            CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL);
    END IF;
END $$;
