-- Morider App - live location sharing opt-in
-- Per-user switch that controls whether the rider appears on the live "active
-- riders" map layer. Off by default: presence is only recorded and shown for
-- riders who explicitly opt in from their profile.

ALTER TABLE users ADD COLUMN IF NOT EXISTS share_live_location BOOLEAN NOT NULL DEFAULT false;
