-- Morider App - user profile photo (avatar) URL.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
