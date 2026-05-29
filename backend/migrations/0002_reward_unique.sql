-- Morider App - reward rules engine
-- A rider earns each badge type at most once. This unique constraint enforces
-- that and is the conflict target for the idempotent ON CONFLICT upserts the
-- reward service performs (both the auto rules engine and the manual award API).

-- Idempotent so `make migrate` can be re-run safely (Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_rewards_user_type'
    ) THEN
        ALTER TABLE rewards
            ADD CONSTRAINT uq_rewards_user_type UNIQUE (user_id, type);
    END IF;
END $$;
