-- Morider App - route visibility (community)
-- Routes default to private. 'public' routes appear in the Explore feed;
-- 'friends' visibility is enforced once the friends feature lands.

ALTER TABLE routes
    ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

-- Guard against invalid values written outside the app.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_routes_visibility') THEN
        ALTER TABLE routes
            ADD CONSTRAINT chk_routes_visibility CHECK (visibility IN ('private', 'public', 'friends'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_routes_visibility ON routes(visibility);
