-- Morider App - unique, changeable @username (separate from display name).

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;

-- Backfill existing rows. Derive from the email local-part, sanitised to the
-- allowed charset, and suffix with the id to guarantee uniqueness.
UPDATE users SET username =
    left(lower(regexp_replace(split_part(email, '@', 1), '[^a-z0-9_]', '', 'g')), 16)
    || '_' || id
WHERE username IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username));

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
