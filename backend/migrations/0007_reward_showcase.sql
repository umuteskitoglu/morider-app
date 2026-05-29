-- Morider App - showcased badges
-- A rider chooses which of their earned badges to feature on their profile.

ALTER TABLE rewards
    ADD COLUMN IF NOT EXISTS showcased BOOLEAN NOT NULL DEFAULT false;
