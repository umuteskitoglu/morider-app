-- Morider App - profile privacy
-- Per-user visibility flags for sections shown on another rider's profile.
-- Garage is visible by default (sanitized: name + year only — plates and
-- document expiry dates are never exposed). Public routes are governed by the
-- existing per-route `visibility` column, so they need no flag here.

ALTER TABLE users ADD COLUMN IF NOT EXISTS show_garage BOOLEAN NOT NULL DEFAULT true;
