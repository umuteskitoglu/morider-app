-- Morider App - rider profile: licence class and bike type for personalised
-- route/event suggestions.

ALTER TABLE users ADD COLUMN IF NOT EXISTS license_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bike_type TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_license_type_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_license_type_check
            CHECK (license_type IS NULL OR license_type IN ('A1', 'A2', 'A', 'B'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_bike_type_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_bike_type_check
            CHECK (bike_type IS NULL OR bike_type IN
                ('naked', 'sport', 'touring', 'adventure', 'chopper', 'enduro', 'scooter', 'custom'));
    END IF;
END $$;
