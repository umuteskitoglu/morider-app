-- Morider App - ride privacy
-- Per-user flag for the ride summaries shown on another rider's profile.
-- Visible by default like show_garage; only summary numbers are ever exposed
-- (distance, max speed, duration, date) — the GPS track stays owner-only.

ALTER TABLE users ADD COLUMN IF NOT EXISTS show_rides BOOLEAN NOT NULL DEFAULT true;
